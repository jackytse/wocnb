/**
 * cnb-cli OAuth 设备授权登录的组合式函数。
 *
 * 设计说明（决策依据见 src-tauri/src/cnb_cli.rs 模块注释）：
 * - 登录走 cnb-cli 的 OAuth2 设备授权流（Rust 命令 spawn `cnb login`），
 *   前端只负责流程编排：检测/安装 CLI → 展示设备码 → 每 2s 轮询 → 读取令牌；
 * - CLI 只负责登录与令牌生命周期，应用内 API 请求仍走现有 cnbFetch 通道，
 *   本模块绝不把 CLI 当 API 通道；
 * - 授权成功后令牌写入现有登录态（cnbToken/cnbUser），并记录登录方式与
 *   过期时间 —— 所有已实现功能零改动即可复用；
 * - 应用启动时若 OAuth 令牌临期（<10min），优先用 refresh_token 续期
 *   （Rust 命令 cnb_cli_refresh_token，端点依据 CLI 源码 refreshAccessToken，
 *   dist/index.js @948223：POST {platform_url}/oauth2/token，
 *   form grant_type=refresh_token + refresh_token + client_id，无 Basic 认证），
 *   刷新成功后 Rust 侧写回 ~/.cnb/token 保持 CLI 同步；失败则清登录态
 *   引导重新授权。
 *
 * 安全红线：
 * - 令牌值只在 Rust ↔ 前端间流转，本模块不做任何 console 输出令牌内容；
 * - 网络一律走 Rust 命令（设备流全程不经过页面 fetch），无裸 fetch。
 */
import { onScopeDispose, ref, type Ref } from 'vue'
import { useStorage } from '@vueuse/core'
import { i18n } from '../i18n'
import {
  cnbAvatarUrl,
  cnbFetch,
  cnbToken,
  cnbUser,
  logout,
  type CnbUser,
} from './useCnbAuth'

// ---------------------------------------------------------------------------
// 类型（与 Rust 侧 serde rename_all = "camelCase" 的结构一一对应）
// ---------------------------------------------------------------------------

/** CLI 检测结果（source: system=PATH 中找到 / app=应用数据目录 / none=未找到） */
export interface CliDetectResult {
  found: boolean
  path: string
  version: string
  source: 'system' | 'app' | 'none' | string
  /**
   * 未找到时的具体原因（找到时为空串/缺省）。
   * 为什么需要：Node 版 cnb（JS shim）在 GUI 环境下可能因找不到 node 运行时
   * 而不可用 —— 这类原因必须能透出，否则用户只看到"未找到"而无从自查。
   */
  reason?: string
}

/** CLI 安装结果 */
export interface CliInstallResult {
  path: string
  version: string
}

/** 设备授权启动结果（handle 供轮询/取消引用） */
export interface CliLoginStart {
  handle: number
  verificationUrl: string
  userCode: string
  rawOutput: string
}

/** 登录轮询结果（status: pending / success / failed） */
export interface CliLoginPoll {
  status: 'pending' | 'success' | 'failed' | string
  message: string
}

/** CLI 侧令牌信息（值仅在 Rust ↔ 前端间流转，绝不打印） */
export interface CliTokenInfo {
  accessToken: string
  refreshToken?: string | null
  expiresAt: number
  platformUrl: string
  clientId: string
  loginHost: string
}

/** 令牌刷新结果（refreshed=false 表示仍有效、无需刷新） */
export interface CliRefreshResult {
  accessToken: string
  expiresAt: number
  refreshed: boolean
}

// ---------------------------------------------------------------------------
// 全局登录态扩展：登录方式 + OAuth 令牌过期时间（localStorage 持久化）
// ---------------------------------------------------------------------------

/** 登录方式：oauth（设备授权）/ pat（手动令牌）/ 空（未登录或旧版本数据） */
export const cnbAuthMethod = useStorage<'oauth' | 'pat' | ''>('cnb-auth-method', '')
/** OAuth access_token 过期时间（Unix 秒；PAT 登录恒为 0） */
export const cnbTokenExpiresAt = useStorage<number>('cnb-token-expires-at', 0)

/** 轮询间隔 2s；整体超时 5 分钟（设备码有效期更长，但 5 分钟足够完成授权） */
const LOGIN_POLL_INTERVAL_MS = 2000
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000
/** 临近过期阈值：10 分钟（与 Rust 侧 REFRESH_MARGIN_SECS 一致） */
const EXPIRY_MARGIN_MS = 10 * 60 * 1000

/** 判断当前是否运行在 Tauri 桌面环境（与 useCnbAuth 同判据） */
function isTauriEnv(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

// ---------------------------------------------------------------------------
// 纯函数（导出供单元测试）
// ---------------------------------------------------------------------------

/**
 * OAuth 令牌临期/过期判定。
 * 边界语义：`now >= expiresAtMs - margin` 即临期（提前刷新优先于压哨使用）；
 * expiresAt 缺失（0）时恒判临期 —— 无法确认有效期的令牌宁可多刷新。
 * @param expiresAt 过期时间（Unix 秒；0 或负数视为已过期）
 * @param nowMs 当前毫秒时间戳
 * @param marginMs 临期阈值（默认 10 分钟）
 */
export function isTokenExpiring(
  expiresAt: number,
  nowMs: number,
  marginMs: number = EXPIRY_MARGIN_MS,
): boolean {
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
    return true
  }
  return nowMs >= expiresAt * 1000 - marginMs
}

/**
 * 从验证链接（verification_uri_complete）中提取设备码（user_code）。
 * 依据实测：CLI 打印的链接形如
 * `https://cnb.cool/oauth2/device/verify?user_code=XXXX`。
 * 无 user_code 参数时返回空串（界面隐藏设备码区，仅展示链接）。
 */
export function extractUserCode(verificationUrl: string): string {
  try {
    return new URL(verificationUrl).searchParams.get('user_code') || ''
  } catch {
    // 非法 URL：按无设备码处理（子进程输出按不可信文本处理）
    return ''
  }
}

// ---------------------------------------------------------------------------
// Rust 命令封装（Tauri 环境 invoke；浏览器环境抛出可读错误）
// ---------------------------------------------------------------------------

/** 统一 invoke 封装：非 Tauri 环境（纯浏览器调试）直接给出可读错误 */
async function invokeCli<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriEnv()) {
    throw new Error(i18n.global.t('login.cliDesktopOnly'))
  }
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(command, args)
}

/** 检测 cnb CLI（PATH + 应用数据目录，--version 验证可执行） */
export async function detectCli(): Promise<CliDetectResult> {
  return invokeCli<CliDetectResult>('cnb_cli_detect')
}

/** 安装官方原生 cnb CLI 到应用数据目录（失败抛错，含手动安装指引） */
export async function installCli(): Promise<CliInstallResult> {
  return invokeCli<CliInstallResult>('cnb_cli_install')
}

/** 发起设备授权登录（spawn cnb login，返回设备码与验证链接） */
export async function startDeviceLogin(): Promise<CliLoginStart> {
  return invokeCli<CliLoginStart>('cnb_cli_login')
}

/** 轮询登录会话状态 */
export async function pollCliLogin(handle: number): Promise<CliLoginPoll> {
  return invokeCli<CliLoginPoll>('cnb_cli_login_poll', { handle })
}

/** 取消登录会话（kill 子进程） */
export async function cancelCliLogin(handle: number): Promise<void> {
  return invokeCli<void>('cnb_cli_cancel_login', { handle })
}

/** 读取 CLI 侧令牌（无令牌返回 null） */
export async function readCliToken(): Promise<CliTokenInfo | null> {
  return invokeCli<CliTokenInfo | null>('cnb_cli_read_token')
}

/** 按需刷新 OAuth 令牌（临期 <10min 时；刷新成功后 Rust 侧已写回 CLI 令牌文件） */
export async function refreshCliToken(): Promise<CliRefreshResult> {
  return invokeCli<CliRefreshResult>('cnb_cli_refresh_token')
}

/** 在 CLI 侧退出登录（cnb logout --host cnb.cool，保证两端一致） */
export async function logoutCliSide(): Promise<void> {
  if (!isTauriEnv()) {
    return
  }
  return invokeCli<void>('cnb_cli_logout')
}

// ---------------------------------------------------------------------------
// 登录态写入（与 loginWithPat 相同的回滚套路）
// ---------------------------------------------------------------------------

/**
 * 把 CLI 授权得到的令牌写入现有登录态并拉取用户信息。
 *
 * 套路与 loginWithPat 一致：先写令牌 → cnbFetch('/user') 校验并拉用户 →
 * 失败回滚令牌（保持"未登录"状态干净）。成功后记录登录方式 oauth 与
 * 过期时间，后续启动时的续期分支据此判断。
 *
 * @throws Error 校验失败（401/网络等，文案来自 cnbFetch 的 CnbApiError）
 */
export async function applyCliToken(info: CliTokenInfo): Promise<CnbUser> {
  // 临时令牌仅用于本次校验请求，避免污染全局状态（校验通过后才正式保存）
  const savedToken = cnbToken.value
  cnbToken.value = info.accessToken
  try {
    const raw = await cnbFetch<Partial<CnbUser>>('/user')
    // 兜底字段：用户名是 CNB 资源路径的组成部分，必须存在
    if (!raw.username) {
      throw new Error(i18n.global.t('auth.missingUsername'))
    }
    const normalized: CnbUser = {
      username: raw.username,
      nickname: raw.nickname || raw.username,
      avatar: raw.avatar || cnbAvatarUrl(raw.username),
      email: raw.email || '',
    }
    cnbUser.value = normalized
    cnbAuthMethod.value = 'oauth'
    cnbTokenExpiresAt.value = info.expiresAt
    return normalized
  } catch (err) {
    // 校验失败：回滚令牌与登录方式（过期时间置 0），保持未登录状态干净
    cnbToken.value = savedToken
    cnbAuthMethod.value = ''
    cnbTokenExpiresAt.value = 0
    throw err
  }
}

/**
 * PAT 登录成功后记录登录方式（缺陷 D2 修复）。
 *
 * 为什么放在本模块而非 useCnbAuth.loginWithPat 内：登录方式/过期时间这两个
 * 持久化键由 cnb-cli 集成引入，若 useCnbAuth 反向引用会形成循环依赖；
 * 由登录页在 PAT 校验成功后调用本函数，职责边界清晰。
 *
 * 不清登录方式导致的后果（缺陷 D1 同源）：残留 oauth 标记会让重启时的
 * refreshCliTokenIfNeeded 误触发 OAuth 刷新分支。
 */
export function markPatLogin(): void {
  cnbAuthMethod.value = 'pat'
  cnbTokenExpiresAt.value = 0
}

/**
 * OAuth 令牌按需续期（应用启动时调用，先于 restoreSession）。
 *
 * 仅当：Tauri 环境 + 登录方式为 oauth + 令牌临期（<10min）时触发。
 * 成功：更新本地令牌与过期时间（Rust 侧已同步写回 CLI 令牌文件）。
 * 失败（refresh_token 过期/被吊销等）：清登录态引导重新授权 —— 与 401
 * 拦截同语义（清干净，路由守卫自动跳登录页）。
 * @returns 是否执行了刷新（无论成败；未触发条件返回 false）
 */
export async function refreshCliTokenIfNeeded(): Promise<boolean> {
  if (!isTauriEnv() || cnbAuthMethod.value !== 'oauth' || !cnbToken.value) {
    return false
  }
  if (!isTokenExpiring(cnbTokenExpiresAt.value, Date.now())) {
    return false
  }
  try {
    const result = await refreshCliToken()
    cnbToken.value = result.accessToken
    cnbTokenExpiresAt.value = result.expiresAt
    return true
  } catch {
    // 刷新失败：令牌已不可用，清除登录态引导重新授权（不清 CLI 侧令牌 ——
    // Rust 侧刷新失败时未写文件，CLI 侧状态保持原样）
    logout()
    cnbAuthMethod.value = ''
    cnbTokenExpiresAt.value = 0
    return true
  }
}

// ---------------------------------------------------------------------------
// 设备授权登录流程编排（登录页使用的状态机）
// ---------------------------------------------------------------------------

/** 登录流程阶段：idle 未开始 / preparing 检测安装中 / waiting 等待授权 / failed 失败 */
export type CliLoginPhase = 'idle' | 'preparing' | 'waiting' | 'failed'

/**
 * 设备授权登录流程状态机。
 *
 * 流程：begin() → 检测 CLI（无则自动安装）→ startDeviceLogin 拿设备码 →
 * 每 2s 轮询（超时 5 分钟）→ 成功后读令牌、写登录态、回调 onSuccess。
 * 组件卸载时自动取消未完成的会话（onScopeDispose），避免残留子进程。
 */
export function useCliDeviceLogin(options: { onSuccess: () => void }): {
  phase: Ref<CliLoginPhase>
  statusText: Ref<string>
  userCode: Ref<string>
  verificationUrl: Ref<string>
  errorMessage: Ref<string>
  begin: () => Promise<void>
  cancel: () => Promise<void>
  retry: () => Promise<void>
} {
  const phase = ref<CliLoginPhase>('idle')
  /** preparing 阶段的进度文案（i18n 翻译结果） */
  const statusText = ref('')
  const userCode = ref('')
  const verificationUrl = ref('')
  const errorMessage = ref('')

  let handle: number | null = null
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let deadline = 0
  /**
   * 检测阶段的具体失败原因（如"Node 版 cnb 但找不到 node 运行时"）。
   * 自动安装成功后无需展示；自动安装也失败时一并透出，用户才知道
   * 该装原生版还是修 PATH，而不是只看到一句"安装失败"。
   */
  let detectReason = ''
  /**
   * 流程代际号（缺陷 D3 修复）：每次 begin/cancel 递增；begin 内每个 await
   * 返回后校验代际，不一致说明期间被取消/重开 —— 必须中止后续步骤，
   * 否则取消后 cnb login 仍会被 spawn（僵尸会话存活至 5min 超时）。
   */
  let generation = 0

  function stopPolling() {
    if (pollTimer != null) {
      clearTimeout(pollTimer)
      pollTimer = null
    }
  }

  function resetState() {
    stopPolling()
    handle = null
    detectReason = ''
    phase.value = 'idle'
    statusText.value = ''
    userCode.value = ''
    verificationUrl.value = ''
    errorMessage.value = ''
  }

  /** 排定下一次轮询（独立成函数便于失败重试与超时控制） */
  function schedulePoll() {
    pollTimer = setTimeout(() => {
      void pollTick()
    }, LOGIN_POLL_INTERVAL_MS)
  }

  async function pollTick() {
    if (handle == null) {
      return
    }
    // 整体超时：设备码长期未授权，主动终止并引导重试
    if (Date.now() > deadline) {
      await cleanupSession()
      errorMessage.value = i18n.global.t('login.cliAuthTimeout')
      phase.value = 'failed'
      return
    }
    try {
      const result = await pollCliLogin(handle)
      if (result.status === 'success') {
        // 缺陷 D4 修复：成功后 Rust 侧已移除会话 —— 后续任何 poll 都会报
        // "会话不存在"，因此先停轮询并释放 handle，读令牌/写登录态的失败
        // 必须独立捕获并透出真实错误（退化为 5min 超时会让用户无从排查）
        stopPolling()
        handle = null
        try {
          // 读 CLI 侧令牌并写入登录态（授权成功后 CLI 已把令牌写入 ~/.cnb/token）
          const tokenInfo = await readCliToken()
          if (!tokenInfo) {
            throw new Error(i18n.global.t('login.cliTokenMissing'))
          }
          await applyCliToken(tokenInfo)
          phase.value = 'idle'
          options.onSuccess()
        }
        catch (err) {
          // 授权成功但登录态写入失败（网络/校验）：以真实错误进入 failed
          errorMessage.value = err instanceof Error ? err.message : String(err)
          phase.value = 'failed'
        }
        return
      }
      if (result.status === 'failed') {
        stopPolling()
        handle = null
        errorMessage.value = result.message || i18n.global.t('login.cliAuthFailed')
        phase.value = 'failed'
        return
      }
      // pending：继续轮询
      schedulePoll()
    }
    catch {
      // 单次轮询异常（IPC 抖动等）不直接失败，继续轮询直至超时。
      // 注意：handle 已被清空的场景（成功分支的读令牌失败）不会走到这里
      // —— 该分支的异常在上面内层 try 中消化
      schedulePoll()
    }
  }

  /** 清理未完成的登录会话（kill 子进程；会话可能已结束，错误静默） */
  async function cleanupSession() {
    stopPolling()
    if (handle != null) {
      await cancelCliLogin(handle).catch(() => {})
      handle = null
    }
  }

  /** 开始/重新发起登录流程 */
  async function begin() {
    // 缺陷 D6 修复：重入守卫 —— preparing/waiting 中重复 begin（双击、
    // retry 误触）直接忽略，防止并发流程互相踩踏。
    // 注意 failed 不拦截：retry() 正是从 failed 重开的合法路径。
    if (phase.value === 'preparing' || phase.value === 'waiting') {
      return
    }
    resetState()
    generation++
    const gen = generation
    phase.value = 'preparing'
    try {
      // 1. 检测 CLI；未找到则自动安装（失败抛错含手动安装指引）
      statusText.value = i18n.global.t('login.cliDetecting')
      const detected = await detectCli()
      // 缺陷 D3 修复：await 期间被取消/重开 —— 中止，不得继续 spawn cnb login
      if (gen !== generation) {
        return
      }
      if (!detected.found) {
        // 记下检测失败原因：自动安装也失败时一起透出（Rust 侧已给出可读原因，
        // 例如"检测到 Node 版 cnb，但应用环境找不到 node 运行时"）
        detectReason = detected.reason || ''
        statusText.value = i18n.global.t('login.cliInstalling')
        await installCli()
        if (gen !== generation) {
          return
        }
      }
      // 2. 发起设备授权（Rust spawn cnb login，CLI 自行打开浏览器）
      statusText.value = i18n.global.t('login.cliStarting')
      const start = await startDeviceLogin()
      if (gen !== generation) {
        // 等待期间被取消：cnb login 子进程已经 spawn，必须立即杀掉，
        // 否则僵尸会话会存活到 5min 超时（且浏览器已被 CLI 打开）
        await cancelCliLogin(start.handle).catch(() => {})
        return
      }
      handle = start.handle
      userCode.value = start.userCode
      verificationUrl.value = start.verificationUrl
      deadline = Date.now() + LOGIN_TIMEOUT_MS
      phase.value = 'waiting'
      schedulePoll()
    }
    catch (err) {
      // 取消/重开过程中产生的报错（如 abort）不进 failed：流程已被放弃，
      // 界面状态由取消方负责（保持 idle）
      if (gen !== generation) {
        return
      }
      phase.value = 'failed'
      const baseMessage = err instanceof Error ? err.message : String(err)
      // 附带检测阶段原因：用户据此判断是"装个原生版"还是"修 node/PATH"
      errorMessage.value = detectReason ? `${baseMessage}（${detectReason}）` : baseMessage
    }
  }

  /** 用户主动取消 */
  async function cancel() {
    // 递增代际号：让进行中 begin 的每个 await 后校验失败而中止（缺陷 D3）
    generation++
    await cleanupSession()
    resetState()
  }

  /** 失败后重试（等价重新 begin） */
  async function retry() {
    await begin()
  }

  // 组件卸载时取消未完成会话，避免残留轮询子进程
  onScopeDispose(() => {
    void cleanupSession()
  })

  return { phase, statusText, userCode, verificationUrl, errorMessage, begin, cancel, retry }
}
