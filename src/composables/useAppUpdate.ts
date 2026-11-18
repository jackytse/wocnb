/**
 * 应用自更新检测（检查更新，不做应用内静默安装）。
 *
 * 为什么不做 tauri-plugin-updater 自动安装：
 * 1. 更新清单要 minisign 签名 + 公网静态 JSON 端点，当前发版链路（CNB Release
 *    附件）没有签名环节；
 * 2. Windows 端当前只出 portable exe（rc 阶段 NSIS/WiX 不可用，见 .cnb.yml
 *    注释），updater 插件必须依赖安装器产物，portable exe 无法被其替换。
 * 因此本模块的定位是「检测 + 引导」：发现新版本后提示用户，跳转到
 * CNB Release 页手动下载。等正式版固定 NSIS/MSI 产物并补齐签名后再演进。
 *
 * 检测通道：复用 Releases 数据层 fetchLatestRelease（GET
 * /{repo}/-/releases/latest，scope repo-release:r），走 useCnbAuth 统一
 * 请求链路（Rust cnb_http_request 直连，规避网关 TLS 风控）。
 *
 * 两个使用入口：
 * - maybeAutoCheckOnStartup()：登录后启动 4 秒静默检查（24h 节流，由
 *   layouts/default.vue 触发），发现新版本由调用方弹 toast；
 * - checkForUpdate()：设置 · 关于页「检查更新」按钮，全量状态落单例 state。
 *
 * 通知双通道（本应用的通知约定：推送本地系统通知的同时在通知面板落记录）：
 * 发现新版本时经 sendAppSystemNotification 推一条系统通知（点击直达
 * 「设置 · 关于」），并向 useAppNotices 的应用通知列表 push 一条记录；
 * 同一版本只通知一次（localStorage 记 lastNotifiedVersion，避免 24h 节流
 * 到期后每次启动都重复打扰）。
 *
 * 文案 i18n：系统通知/面板记录的标题正文在本模块组装（复用全局 i18n 单例，
 * 与 useCnbBuildWatch 同范式）；toast 仍由调用方负责。
 */
import { computed, ref } from 'vue'
import { i18n } from '../i18n'
import { isLoggedIn } from './useCnbAuth'
import { pushAppNotice } from './useAppNotices'
import { fetchLatestRelease, type ReleaseItem } from './useCnbReleases'
import { sendAppSystemNotification } from './useCnbBuildWatch'

// ---------------------------------------------------------------------------
// 常量：更新源仓库与节流参数
// ---------------------------------------------------------------------------

/**
 * 本应用自身的发版仓库（CNB）。改仓库地址时只需改这里 ——
 * 检测与「前往下载」都指向它。与 settings/about.vue 的 repoUrl 保持一致。
 */
export const APP_SOURCE_REPO = 'jackytse/wocnb'

/** CNB Web 端 Releases 页（按钮外跳目标，系统浏览器打开）。
 *  用列表页而非 tag 深链：tag 深链 URL 形态未在项目中验证过，列表页
 *  形态已有 ReleaseAssetList.vue 在用，稳妥。 */
export const APP_RELEASES_PAGE_URL = `https://cnb.cool/${APP_SOURCE_REPO}/-/releases`

/** 自动检查节流间隔：24 小时（启动检查一天最多打一次 API） */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

/** localStorage 键：上次成功检查的毫秒时间戳 */
const LAST_CHECK_STORAGE_KEY = 'wocnb.update.lastCheckAt'

/**
 * localStorage 键：最近一次「已通知过新版本」的版本号。
 *
 * 为什么单独存：检查节流（24h）只控制"多久查一次"，不控制"查到同一个
 * 新版本后要不要再打扰"。没有这个去重的话，版本升级前用户每次启动
 * （24h 节流到期）都会收到一遍「发现新版本 0.1.0-rc.30」的系统通知。
 * 记住已通知版本后，同一版本绝不重复通知；出新版本（如 rc.31）才再次通知。
 */
const LAST_NOTIFIED_VERSION_KEY = 'wocnb.update.lastNotifiedVersion'

// ---------------------------------------------------------------------------
// 语义化版本比较（纯函数，单测锁定）
// ---------------------------------------------------------------------------

/** 解析后的版本号（x.y.z[-预发布标识]；预发布标识按 '.' 拆段） */
export interface ParsedVersion {
  major: number
  minor: number
  patch: number
  /** 预发布标识段数组；空数组 = 正式版（如 0.1.0 的 prerelease 为 []） */
  prerelease: string[]
}

/**
 * 解析语义化版本号（宽松：容忍前导 v / 首尾空白）。
 *
 * 覆盖本项目全部实际形态：`0.1.0-rc.25`（Tauri version）、`v0.1.0-rc.25`
 * （git tag）、`0.1.0`（未来正式版）。解析失败返回 null（版本号口径未知时
 * 调用方必须按「无法比较 → 不提示更新」处理，绝不能误报）。
 */
export function parseVersion(input: string): ParsedVersion | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(input.trim())
  if (!m) {
    return null
  }
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.') : [],
  }
}

/**
 * 比较单个预发布标识段（semver 规范 §11.4）：
 * - 纯数字对纯数字 → 按数值比较（rc.9 < rc.25 是数值比较，不是字典序！）；
 * - 数字标识 < 字母数字标识（1 < alpha）；
 * - 两个字母数字标识 → 按字典序。
 */
function comparePrereleaseId(a: string, b: string): number {
  const isNumA = /^\d+$/.test(a)
  const isNumB = /^\d+$/.test(b)
  if (isNumA && isNumB) {
    return Number(a) - Number(b)
  }
  if (isNumA) {
    return -1
  }
  if (isNumB) {
    return 1
  }
  if (a < b) {
    return -1
  }
  if (a > b) {
    return 1
  }
  return 0
}

/**
 * 语义化版本比较（semver 规范）。
 *
 * 返回值：a > b → 正数，a < b → 负数，相等 → 0；
 * 任一版本解析失败 → null（调用方按「无法比较」处理，不得当作 0）。
 *
 * 预发布比较要点（全是踩过的真实语义坑）：
 * - `1.0.0-rc.1 < 1.0.0`：正式版大于一切同号预发布；
 * - `rc.9 < rc.25`：数字段按数值比，字典序会把 rc.25 排到 rc.9 前面（错）；
 * - `rc.1 < rc.1.1`：标识段逐段比，先耗尽的一方更小。
 */
export function compareVersions(a: string, b: string): number | null {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  // 任一无法解析 → 无法比较（不是相等！）
  if (!pa || !pb) {
    return null
  }
  if (pa.major !== pb.major) {
    return pa.major - pb.major
  }
  if (pa.minor !== pb.minor) {
    return pa.minor - pb.minor
  }
  if (pa.patch !== pb.patch) {
    return pa.patch - pb.patch
  }
  // 主版本一致 → 比预发布：正式版（无标识段）大于一切预发布
  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) {
    return 0
  }
  if (pa.prerelease.length === 0) {
    return 1
  }
  if (pb.prerelease.length === 0) {
    return -1
  }
  // 都有预发布 → 逐段比较；先耗尽的一方更小（rc.1 < rc.1.1）
  const len = Math.max(pa.prerelease.length, pb.prerelease.length)
  for (let i = 0; i < len; i++) {
    const idA = pa.prerelease[i]
    const idB = pb.prerelease[i]
    if (idA === undefined) {
      return -1
    }
    if (idB === undefined) {
      return 1
    }
    const cmp = comparePrereleaseId(idA, idB)
    if (cmp !== 0) {
      return cmp
    }
  }
  return 0
}

/**
 * candidate 是否比 current 更新（tag 候选 > 本地当前版本才算有更新）。
 * 任一版本无法解析 → false（保守不提示，绝不因脏数据误报更新）。
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const cmp = compareVersions(candidate, current)
  return cmp !== null && cmp > 0
}

// ---------------------------------------------------------------------------
// 检查状态（模块级单例：关于页与启动 toast 共享同一份 state）
// ---------------------------------------------------------------------------

/** 检查状态机：idle 初始 → checking 中 → upToDate / available / error 终态 */
export type UpdateCheckStatus = 'idle' | 'checking' | 'upToDate' | 'available' | 'error'

/** 一次检查的完整结果（调用方据此弹 toast / 渲染行内状态） */
export interface UpdateCheckResult {
  /** 是否发现新版本（仅 release 存在且能比较出更大版本时为 true） */
  available: boolean
  /** 最新版本号（去掉 tag 前导 v；无 release 时为空串） */
  latestVersion: string
  /** 本地当前版本（resolveCurrentVersion 失败时为空串） */
  currentVersion: string
  /** 最新 Release 归一化条目（服务端 404 = 无任何 Release 时为 null） */
  release: ReleaseItem | null
  /** 检查失败时的用户可读错误信息（成功为空串） */
  error: string
}

// 模块级单例 state（与 useCnbAuth 的 cnbToken、通知面板单例同范式：
// 多个组件/布局引用 useAppUpdate() 看到的是同一份数据）
const currentVersion = ref('')
const latestRelease = ref<ReleaseItem | null>(null)
const status = ref<UpdateCheckStatus>('idle')
const lastError = ref('')
/** 上次完成检查的时间戳（0 = 从未检查；只统计**成功**检查） */
const checkedAt = ref(0)

/** 进行中的检查（防抖：连点「检查更新」按钮只发一次请求） */
let inFlight: Promise<UpdateCheckResult> | null = null

/**
 * 读取本地当前版本号（Tauri 环境 getVersion；浏览器 dev 返回空串）。
 * 失败返回空串而非抛错 —— 版本号拿不到只影响"能否比较"，不该阻断检查。
 */
async function resolveCurrentVersion(): Promise<string> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    return ''
  }
  try {
    const { getVersion } = await import('@tauri-apps/api/app')
    return await getVersion()
  }
  catch {
    return ''
  }
}

/**
 * 自动检查是否到期（纯函数，单测锁定节流口径）。
 * lastCheckAt=0（从未检查）→ 到期；距上次 < 24h → 未到期。
 */
export function isAutoCheckDue(lastCheckAt: number, now: number): boolean {
  if (!lastCheckAt) {
    return true
  }
  return now - lastCheckAt >= UPDATE_CHECK_INTERVAL_MS
}

/** localStorage 安全读写：容器无 localStorage / 隐私模式禁写都不抛错 */
function readLastCheckAt(): number {
  try {
    const raw = typeof localStorage !== 'undefined'
      ? localStorage.getItem(LAST_CHECK_STORAGE_KEY)
      : null
    const n = raw ? Number(raw) : 0
    return Number.isFinite(n) && n > 0 ? n : 0
  }
  catch {
    return 0
  }
}

function writeLastCheckAt(ts: number): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(LAST_CHECK_STORAGE_KEY, String(ts))
    }
  }
  catch {
    // 写失败只影响下次节流判定（多查一次），不影响功能正确性
  }
}

/**
 * 「已通知过的最新版本」内存缓存（null = 尚未从持久层读过）。
 *
 * 为什么双层（localStorage + memo）：
 * - Tauri WebView 里 localStorage 可用，跨启动持久化去重状态；
 * - vitest node 环境没有 localStorage（读写都会走 catch 分支），若每次
 *   都直接读 localStorage，去重在测试里永远不生效、无法验证；
 *   memo 让"写过就能读到"在两个环境里行为一致。
 */
let lastNotifiedVersionMemo: string | null = null

/** 读取「已通知过的最新版本」（无记录/脏数据 → 空串；memo 优先） */
function readLastNotifiedVersion(): string {
  if (lastNotifiedVersionMemo !== null) {
    return lastNotifiedVersionMemo
  }
  try {
    const raw = typeof localStorage !== 'undefined'
      ? localStorage.getItem(LAST_NOTIFIED_VERSION_KEY)
      : null
    lastNotifiedVersionMemo = typeof raw === 'string' ? raw : ''
  }
  catch {
    lastNotifiedVersionMemo = ''
  }
  return lastNotifiedVersionMemo
}

/** 记录「已通知过的最新版本」（写 memo + 尽力持久化，写失败可接受） */
function writeLastNotifiedVersion(version: string): void {
  lastNotifiedVersionMemo = version
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(LAST_NOTIFIED_VERSION_KEY, version)
    }
  }
  catch {
    // 容器无 localStorage / 隐私模式禁写：静默降级（本次会话内 memo 仍生效）
  }
}

/**
 * 供单测清除「已通知版本」记录（生产代码不应调用）。
 * 用例之间需要显式复位去重状态，否则同一进程内第二次发现同版本
 * 会被去重逻辑吞掉，无法验证通知行为。
 */
export function resetUpdateNotifyStateForTest(): void {
  lastNotifiedVersionMemo = null
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(LAST_NOTIFIED_VERSION_KEY)
    }
  }
  catch {
    // 忽略：测试环境异常不该让用例挂掉
  }
}

/**
 * 发现新版本时的通知编排（系统通知 + 应用通知记录，按版本去重）。
 *
 * # 为什么放在数据层而不是调用方
 *
 * 「发现新版本 → 通知」的口径必须全局唯一（去重状态、通知文案、载荷
 * 结构都在这里），若交给 default.vue（启动 toast 处）与 about.vue（手动
 * 检查处）各自实现，两处口径漂移是迟早的事。checkForUpdate 是两个入口
 * 的公共必经点，在这里编排天然覆盖两条链路。
 *
 * # 去重与副作用边界
 *
 * - 同版本已通知过 → 直接 return（检查本身照常执行，关于页状态照常更新）；
 * - 系统通知 fire-and-forget：发送失败（浏览器 dev / 权限未授权）不影响
 *   主流程——应用内记录与 toast 是兜底通道；
 * - 记录先于"发送结果"落盘：即使系统通知没发出去（权限缺失），面板里
 *   也应有这条记录（用户回到应用时能看到）。
 *
 * @param result checkForUpdate 的检查结果（available=false 时为 no-op）
 */
function maybeNotifyUpdateAvailable(result: UpdateCheckResult): void {
  if (!result.available || !result.latestVersion) {
    return
  }
  // 同一版本只通知一次：rc 阶段版本更新频繁但同一版本会伴随多次检查
  // （启动静默 + 手动），不去重会反复打扰
  if (readLastNotifiedVersion() === result.latestVersion) {
    return
  }
  writeLastNotifiedVersion(result.latestVersion)

  // 文案与载荷：标题带新版本号（通知中心里一眼可辨），正文带当前版本
  const title = i18n.global.t('appUpdate.notify.title', { version: result.latestVersion })
  const body = i18n.global.t('appUpdate.notify.body', { current: result.currentVersion || '—' })
  // 系统通知：点击直达「设置 · 关于」（extra 带 kind=update，无 repoPath/sn）
  void sendAppSystemNotification(title, body, { kind: 'update' })
  // 应用通知记录：通知面板「应用通知」分区展示，点击同样直达关于页
  pushAppNotice({ kind: 'update', title, body, version: result.latestVersion, time: Date.now() })
}

/**
 * 执行一次更新检查（手动按钮 / 启动静默共用主流程）。
 *
 * - 失败不抛异常：结果以 error 字段带回（静默场景调用方忽略即可，
 *   手动场景渲染到关于页），避免 toast 弹两层；
 * - 并发防抖：上一次检查未完成时直接复用其 Promise；
 * - 任何一次**成功**检查（含 404 无 Release）都记录 checkedAt 与
 *   localStorage 时间戳 —— 404 属正常业务态，不该导致反复重试。
 */
export async function checkForUpdate(opts: { currentVersion?: string } = {}): Promise<UpdateCheckResult> {
  if (inFlight) {
    return inFlight
  }
  status.value = 'checking'
  lastError.value = ''
  inFlight = (async (): Promise<UpdateCheckResult> => {
    try {
      // 本地版本号：调用方注入优先（单测），否则 Tauri getVersion
      const version = opts.currentVersion ?? await resolveCurrentVersion()
      currentVersion.value = version
      // 服务端 404（无任何 Release）已由 fetchLatestRelease 归一为 null
      const release = await fetchLatestRelease(APP_SOURCE_REPO)
      latestRelease.value = release
      checkedAt.value = Date.now()
      writeLastCheckAt(Date.now())
      if (!release) {
        // 仓库还没有 Release：按"已是最新"处理，latestVersion 留空
        status.value = 'upToDate'
        return { available: false, latestVersion: '', currentVersion: version, release: null, error: '' }
      }
      // tag 去前导 v 后比较（tag 形如 v0.1.0-rc.25，本地版本 0.1.0-rc.25）
      const latestVersion = release.tagName.replace(/^v/, '')
      const available = !!version && isNewerVersion(latestVersion, version)
      status.value = available ? 'available' : 'upToDate'
      if (available) {
        // 发现新版本：推系统通知 + 落通知面板记录（内部按版本去重）。
        // 同步调用、内部无 await 前的分支（发送为 fire-and-forget），
        // checkForUpdate 返回时通知编排已完成，测试断言时序确定
        maybeNotifyUpdateAvailable({ available, latestVersion, currentVersion: version, release, error: '' })
      }
      return { available, latestVersion, currentVersion: version, release, error: '' }
    }
    catch (err) {
      // 401 已由全局拦截器登出（这里只负责把错误落到状态里）；
      // 403（令牌缺 repo-release:r）/ 网络异常 → 关于页展示原始信息
      const message = err instanceof Error ? err.message : String(err)
      lastError.value = message
      status.value = 'error'
      return { available: false, latestVersion: '', currentVersion: currentVersion.value, release: null, error: message }
    }
    finally {
      inFlight = null
    }
  })()
  return inFlight
}

/**
 * 启动静默检查入口（layouts/default.vue 挂载后延迟调用）。
 *
 * 前置条件（任一不满足直接返回 null，不发请求）：
 * - Tauri 环境（浏览器 dev 里 CNB API 无 CORS 头，检查必失败，跳过）；
 * - 已登录（repo-release:r 需要 Bearer 令牌）；
 * - 距上次成功检查 ≥ 24h（节流，避免每次启动都打 API）。
 *
 * 返回 null = 本次没检查；调用方只在 result.available 时弹 toast。
 */
export async function maybeAutoCheckOnStartup(opts: { currentVersion?: string, now?: number } = {}): Promise<UpdateCheckResult | null> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    return null
  }
  if (!isLoggedIn()) {
    return null
  }
  if (!isAutoCheckDue(readLastCheckAt(), opts.now ?? Date.now())) {
    return null
  }
  // 静默：任何异常都吞掉（checkForUpdate 本身不抛，这里兜底防御）
  try {
    return await checkForUpdate(opts)
  }
  catch {
    return null
  }
}

/**
 * 应用更新检测（单例 state + 动作）。
 * 关于页与启动链路共用，保证两处看到同一份检查结果。
 */
export function useAppUpdate() {
  return {
    /** 本地当前版本号（检查后回填） */
    currentVersion,
    /** 服务端最新 Release（404 无 Release 时为 null） */
    latestRelease,
    /** 检查状态机（about 页按状态渲染行内提示） */
    status,
    /** 检查失败的错误信息（403 缺 scope / 网络异常原文） */
    lastError,
    /** 上次成功检查时间戳（0 = 从未） */
    checkedAt,
    /** 是否有新版本（derived：status === 'available'） */
    updateAvailable: computed(() => status.value === 'available'),
    checkForUpdate,
    maybeAutoCheckOnStartup,
  }
}
