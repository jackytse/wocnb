/**
 * 应用自更新：检测（CNB Release 列表比对）+ 应用内热更新（macOS）。
 *
 * 检测与安装分两条线：
 * - 「检测」走 CNB Releases 数据层 fetchReleases（GET /{repo}/-/releases，
 *   scope repo-release:r），复用 useCnbAuth 统一请求链路（Rust
 *   cnb_http_request 直连，规避网关 TLS 风控）—— 通道（release/prerelease）、
 *   版本比较、通知编排都在这条线上；
 * - 「安装」走 tauri-plugin-updater（check → downloadAndInstall → relaunch），
 *   清单端点是 updater-manifest Release 的 latest.json（静态 URL，见
 *   tauri.conf.json plugins.updater），更新包由 CI 打包时签名、客户端内置
 *   公钥验签。
 *
 * 为什么 Windows 不参与热更新：更新器必须依赖 NSIS/MSI 安装器产物替换，
 * 而当前 Windows 节点 makensis 起不来（32 位程序跑不起来，rc 版只能出
 * 裸 exe，见 .cnb.yml 注释）→ Windows check() 缺平台条目会失败，
 * installUpdate 捕获后降级为「前往 Releases 手动下载」。
 *
 * 检测通道：复用 Releases 数据层 fetchReleases（GET /{repo}/-/releases，
 * scope repo-release:r），走 useCnbAuth 统一请求链路（Rust cnb_http_request
 * 直连，规避网关 TLS 风控）。
 *
 * ⚠️ 为什么不用 GET /{repo}/-/releases/latest：swagger 明确它「仅返回标记为
 * latest 的**正式版本**」，而本项目 rc 阶段所有 Release 都是 prerelease=true、
 * is_latest=false → latest 恒 404，客户端会永远显示"已是最新"（rc.30 实测
 * 发现的功能性缺陷，详见 pickLatestRelease 注释）。
 *
 * 两个使用入口：
 * - maybeAutoCheckOnStartup()：登录后启动 4 秒静默检查（24h 节流，由
 *   layouts/default.vue 触发），发现新版本由调用方弹 toast；
 * - checkForUpdate()：设置 · 关于页「立即检查」按钮与侧边栏用户菜单
 *   「检查更新」动作，全量状态落单例 state。
 *
 * 更新通道（release / prerelease）：用户可在「设置 · 关于」选择只看正式版
 * 还是连预发布版一起看（默认 prerelease —— 本项目 rc 阶段只有预发布版）。
 * 通道持久化在 localStorage，参与 pickLatestRelease 过滤，并按通道分别维护
 * 「已通知版本」去重记录。
 *
 * 应用内热更新（macOS）：检测到新版本后可在「设置 · 关于」一键安装 ——
 * 走 tauri-plugin-updater：check() 拉 updater-manifest 清单 → downloadAndInstall
 * （下载进度经回调回填 installProgress）→ 完成后由用户点「重启」调
 * plugin-process 的 relaunch。清单端点与签名公钥在 tauri.conf.json 的
 * plugins.updater，更新包签名由 CI 打包时生成（TAURI_SIGNING_PRIVATE_KEY）。
 *
 * 通道与热更新的交汇点（容易漏的坑）：updater 清单只维护「最新版本」一条
 * 记录，**不感知通道**。若用户选了 release 通道而清单指向 rc，直接装会把
 * 预发布版塞给"只要稳定版"的用户 —— 所以 installUpdate() 里校验
 * update.version 必须等于当前通道检测出的 latestVersion，不等则拒绝安装
 * 并引导手动下载。
 *
 * Windows 端降级：清单目前只有 darwin-aarch64 条目（Windows 只出 portable
 * exe，更新器必须依赖 NSIS/MSI 安装器产物），Windows check() 会失败 /
 * 缺条目，installUpdate 捕获后走 failed 分支，UI 引导手动下载。
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
import { fetchReleases, type ReleaseItem } from './useCnbReleases'
import { sendAppSystemNotification } from './useCnbBuildWatch'

// ---------------------------------------------------------------------------
// 常量：更新源仓库与节流参数
// ---------------------------------------------------------------------------

/**
 * 本应用自身的发版仓库（CNB）。改仓库地址时只需改这里 ——
 * 检测、「前往下载」与侧边栏「代码仓库」外链都指向它。
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

// ---------------------------------------------------------------------------
// 更新通道（release / prerelease）
// ---------------------------------------------------------------------------

/**
 * 更新通道：
 * - `prerelease`（预发布通道）：非草稿的**全部** Release 参与挑选，含 rc 与
 *   正式版。正式版版本号天然大于同号 rc（semver §11.4），所以这个通道不会
 *   "被旧 rc 卡住"，是功能最全的口径；
 * - `release`（正式版通道）：只看 `prerelease === false` 的 Release，绝不提示
 *   rc —— 给"只想稳"的用户。
 */
export type UpdateChannel = 'prerelease' | 'release'

/** 允许的通道枚举顺序（顺序 = 设置页下拉顺序，预发布在前且为默认） */
export const UPDATE_CHANNEL_OPTIONS: readonly UpdateChannel[] = ['release', 'prerelease']

/**
 * 默认通道 = release（正式版，用户要求）。
 *
 * 注意 rc 阶段的边界事实：当前全部 Release 都是 `prerelease=true`，默认
 * release 时**新装用户默认检测不到任何更新**（除非仓库已发正式版）——这是
 * 该默认值的既定语义（"更稳定"），不是缺陷；想要 rc 一早收到通知的用户
 * 需在「设置 · 关于」手动切到预发布通道。
 */
export const DEFAULT_UPDATE_CHANNEL: UpdateChannel = 'release'

/** localStorage 键：用户选择的更新通道 */
export const UPDATE_CHANNEL_STORAGE_KEY = 'wocnb.update.channel'

/**
 * 归一化任意输入为合法通道（脏值 / 空值 / 旧版本残留一律回落默认通道）。
 * 与通知监控范围的 normalizeScope 同范式：**读取时**也要归一，保证界面
 * 显示的就是检查实际在用的口径。
 */
export function normalizeUpdateChannel(value: unknown): UpdateChannel {
  return UPDATE_CHANNEL_OPTIONS.includes(value as UpdateChannel)
    ? (value as UpdateChannel)
    : DEFAULT_UPDATE_CHANNEL
}

/**
 * 检查更新时拉取的 Release 条数。
 *
 * 列表接口按 created_at 倒序，最新版本必在前几条；取 30 条足以覆盖
 * 「连续补发多个版本」的场景，同时把响应体控制在几十 KB（每个 Release
 * 带 body 与 assets 元数据）。
 */
const RELEASE_SCAN_PAGE_SIZE = 30

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

/**
 * 从 Release 列表里挑出「最新的可用版本」。
 *
 * 为什么不用 GET /{repo}/-/releases/latest —— 这是踩过的坑：
 * swagger 对该端点的描述是「获取指定仓库中最新的**正式版本**发布。仅返回
 * 标记为最新（latest）的版本」，而本项目 rc 阶段所有 Release 都是
 * prerelease=true、is_latest=false，于是 latest 恒 404 → 客户端（rc.30）
 * 点「检查更新」永远显示"已是最新"，功能实际失效。
 *
 * 选取规则：
 * - 跳过草稿：draft 未发布，用户在 Releases 页下载不到；
 * - 按**更新通道**过滤：release 通道只留 `prerelease === false` 的正式版
 *   （`undefined` 也排除 —— 通道字段缺失时保守当作预发布，绝不把 rc 当成
 *   正式版推给"只要稳定版"的用户）；prerelease 通道不过滤；
 * - 在**可解析版本号**的条目里取版本号最大者，而不是取列表第一条 ——
 *   补发旧版本（例如重发 rc.29）会让第一条不再是最大版本；
 * - 整列表都不可解析（非 semver tag）时退回第一条非草稿，交给调用方
 *   isNewerVersion 判定（解析失败一律不误报更新）。注意这里同样**在通道
 *   过滤之后**取，否则 release 通道会漏出预发布版。
 *
 * @param list    Release 列表（fetchReleases 归一化结果）
 * @param channel 更新通道（默认 DEFAULT_UPDATE_CHANNEL = release；
 *                显式默认值让老调用点与单测语义不变）
 */
export function pickLatestRelease(
  list: ReleaseItem[] | null | undefined,
  channel: UpdateChannel = DEFAULT_UPDATE_CHANNEL,
): ReleaseItem | null {
  const usable = (Array.isArray(list) ? list : []).filter(item =>
    !!item
    && !item.isDraft
    // release 通道：必须是明确的"非预发布"；字段缺失按预发布处理（保守）
    && (channel === 'release' ? item.isPrerelease === false : true))
  if (usable.length === 0) {
    return null
  }
  let best: ReleaseItem | null = null
  for (const item of usable) {
    // tagName 必须是可解析的语义化版本才参与比较（tag 形如 v0.1.0-rc.31）
    if (!parseVersion(item.tagName || '')) {
      continue
    }
    if (!best || isNewerVersion(item.tagName, best.tagName)) {
      best = item
    }
  }
  return best ?? usable[0] ?? null
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
  /** 本次检查使用的更新通道（调用方据此提示"通过哪个通道查的"） */
  channel: UpdateChannel
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

/**
 * 当前更新通道（模块级单例，关于页下拉直接绑它）。
 *
 * 初值取默认通道而不是先读 localStorage：模块加载时机可能早于 WebView 的
 * 存储就绪（也早于 vitest 里 localStorage 的存在），真正的落盘值由
 * ensureChannelLoaded() 在首次 useAppUpdate()/检查时同步补齐。
 */
const updateChannel = ref<UpdateChannel>(DEFAULT_UPDATE_CHANNEL)
/** 落盘通道是否已读入内存（避免每次读 localStorage） */
let channelLoaded = false

/** 首次访问时从 localStorage 读一次用户选择（脏值经归一回落默认） */
function ensureChannelLoaded(): void {
  if (channelLoaded) {
    return
  }
  channelLoaded = true
  try {
    const raw = typeof localStorage !== 'undefined'
      ? localStorage.getItem(UPDATE_CHANNEL_STORAGE_KEY)
      : null
    if (typeof raw === 'string' && raw) {
      updateChannel.value = normalizeUpdateChannel(raw)
    }
  }
  catch {
    // 容器无 localStorage / 隐私模式禁读：保持默认通道，功能照常
  }
}

/**
 * 切换更新通道（设置 · 关于页下拉调用）。
 *
 * 副作用（刻意为之，三处都必要）：
 * 1. **重置检查状态**为 idle 并清空上次结果 —— 旧结果属于旧通道，继续展示
 *    "发现新版本 rc.32" 会让刚切到正式版通道的用户误以为还会收到 rc；
 * 2. **清空节流时间戳**（内存 + localStorage）—— 通道变了就该立刻重查一次，
 *    否则用户切完通道要再等 24h 才被自动检查覆盖；
 * 3. **不动通知去重**：去重记录按通道分键存储（见 readLastNotifiedVersion），
 *    切走再切回来仍是同一通道，不该重复打扰同一版本。
 */
export function setUpdateChannel(channel: UpdateChannel): void {
  const next = normalizeUpdateChannel(channel)
  if (next === updateChannel.value) {
    return
  }
  updateChannel.value = next
  channelLoaded = true
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(UPDATE_CHANNEL_STORAGE_KEY, next)
    }
  }
  catch {
    // 写失败只影响下次启动能否记住选择，不影响本次会话内生效
  }
  status.value = 'idle'
  latestRelease.value = null
  lastError.value = ''
  checkedAt.value = 0
  writeLastCheckAt(0)
  // 安装状态同属旧通道：一并复位（否则切通道后残留的 ready 态会让用户
  // 把新通道的检查结果和新版本安装动作错误地拼在一起）
  installStatus.value = 'idle'
  installProgress.value = 0
  installError.value = ''
}

/** 进行中的检查（防抖：连点「检查更新」按钮只发一次请求） */
let inFlight: Promise<UpdateCheckResult> | null = null
/**
 * 进行中检查所用的通道。
 *
 * 为什么必须记下来：防抖只能复用**同一通道**的请求。用户在请求飞行途中
 * 切了通道，再点「立即检查」必须真的按新通道查一次 —— 若仍复用旧 Promise，
 * 界面会显示旧通道的结论（例如"已是最新"，但新通道其实没查过）。
 */
let inFlightChannel: UpdateChannel | null = null

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
 *
 * 为什么按通道分键：预发布通道会先通知 rc.32，用户随后切到正式版通道
 * 又会发现 0.1.0（版本号不同，本不会互相覆盖）。但两个通道可能挑到
 * **同一个 tag**（例如正式版 0.1.0 在两个通道都可见），若共用一个键，
 * 后一个通道就会因为"已通知过这个版本"而静默 —— 用户会觉得切通道没用。
 * 分键后每个通道各自维护自己的去重记录，语义清晰且可预期。
 */
const lastNotifiedByChannel = new Map<UpdateChannel, string>()

/** 去重记录的存储键（按通道隔离） */
function notifiedStorageKey(channel: UpdateChannel): string {
  return `${LAST_NOTIFIED_VERSION_KEY}.${channel}`
}

/** 读取指定通道「已通知过的最新版本」（无记录/脏数据 → 空串；memo 优先） */
function readLastNotifiedVersion(channel: UpdateChannel): string {
  const memo = lastNotifiedByChannel.get(channel)
  if (memo !== undefined) {
    return memo
  }
  let value = ''
  try {
    const raw = typeof localStorage !== 'undefined'
      ? localStorage.getItem(notifiedStorageKey(channel))
      : null
    value = typeof raw === 'string' ? raw : ''
  }
  catch {
    value = ''
  }
  lastNotifiedByChannel.set(channel, value)
  return value
}

/** 记录指定通道「已通知过的最新版本」（写 memo + 尽力持久化，写失败可接受） */
function writeLastNotifiedVersion(channel: UpdateChannel, version: string): void {
  lastNotifiedByChannel.set(channel, version)
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(notifiedStorageKey(channel), version)
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
  lastNotifiedByChannel.clear()
  try {
    if (typeof localStorage !== 'undefined') {
      for (const channel of UPDATE_CHANNEL_OPTIONS) {
        localStorage.removeItem(notifiedStorageKey(channel))
      }
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
 *   去重记录**按通道**存储（同一 tag 在两个通道都可见时各自通知一次）；
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
  // 同一通道内同一版本只通知一次：rc 阶段版本更新频繁但同一版本会伴随多次
  // 检查（启动静默 + 手动），不去重会反复打扰
  if (readLastNotifiedVersion(result.channel) === result.latestVersion) {
    return
  }
  writeLastNotifiedVersion(result.channel, result.latestVersion)

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
 * - 并发防抖：**同一通道**上一次检查未完成时直接复用其 Promise；
 * - 任何一次**成功**检查（含 404 无 Release）都记录 checkedAt 与
 *   localStorage 时间戳 —— 404 属正常业务态，不该导致反复重试；
 * - 检查期间通道被切换 → 本次结果整体丢弃（不写状态、不通知），避免旧通道
 *   的结论污染新通道的界面。
 */
export async function checkForUpdate(opts: { currentVersion?: string } = {}): Promise<UpdateCheckResult> {
  ensureChannelLoaded()
  const channel = updateChannel.value
  // 同通道请求在飞 → 复用（连点按钮只发一次）；跨通道 → 另起一次检查
  if (inFlight && inFlightChannel === channel) {
    return inFlight
  }
  status.value = 'checking'
  lastError.value = ''
  const task = (async (): Promise<UpdateCheckResult> => {
    try {
      // 本地版本号：调用方注入优先（单测），否则 Tauri getVersion
      const version = opts.currentVersion ?? await resolveCurrentVersion()
      currentVersion.value = version
      // 拉 Release 列表后按版本号 + 通道挑最新（不能用 latest 端点，见
      // pickLatestRelease 注释：它只认"标记为 latest 的正式版"，rc 恒 404）
      const releases = await fetchReleases(APP_SOURCE_REPO, {
        page: 1,
        pageSize: RELEASE_SCAN_PAGE_SIZE,
      })
      // 等待期间用户切了通道：这次结果已无意义（当前界面属于新通道），
      // 直接以"无更新"的形式返回且不写任何共享状态
      if (updateChannel.value !== channel) {
        return { available: false, latestVersion: '', currentVersion: version, release: null, channel, error: '' }
      }
      const release = pickLatestRelease(releases, channel)
      latestRelease.value = release
      checkedAt.value = Date.now()
      writeLastCheckAt(Date.now())
      if (!release) {
        // 该通道下没有任何可用 Release：按"已是最新"处理，latestVersion 留空
        status.value = 'upToDate'
        return { available: false, latestVersion: '', currentVersion: version, release: null, channel, error: '' }
      }
      // tag 去前导 v 后比较（tag 形如 v0.1.0-rc.25，本地版本 0.1.0-rc.25）
      const latestVersion = release.tagName.replace(/^v/, '')
      const available = !!version && isNewerVersion(latestVersion, version)
      status.value = available ? 'available' : 'upToDate'
      if (available) {
        // 发现新版本：推系统通知 + 落通知面板记录（内部按通道+版本去重）。
        // 同步调用、内部无 await 前的分支（发送为 fire-and-forget），
        // checkForUpdate 返回时通知编排已完成，测试断言时序确定
        maybeNotifyUpdateAvailable({ available, latestVersion, currentVersion: version, release, channel, error: '' })
      }
      return { available, latestVersion, currentVersion: version, release, channel, error: '' }
    }
    catch (err) {
      // 401 已由全局拦截器登出（这里只负责把错误落到状态里）；
      // 403（令牌缺 repo-release:r）/ 网络异常 → 关于页展示原始信息
      const message = err instanceof Error ? err.message : String(err)
      // 通道已变则不把旧通道的失败写进新通道界面
      if (updateChannel.value === channel) {
        lastError.value = message
        status.value = 'error'
      }
      return { available: false, latestVersion: '', currentVersion: currentVersion.value, release: null, channel, error: message }
    }
  })()
  inFlight = task
  inFlightChannel = channel
  // 只清理自己那次请求的防抖槽位：跨通道并发时旧请求收尾不能把新请求的
  // 槽位抹掉（否则用户连点会打出第二发请求）
  void task.finally(() => {
    if (inFlight === task) {
      inFlight = null
      inFlightChannel = null
    }
  })
  return task
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

// ---------------------------------------------------------------------------
// 应用内热更新（macOS）：tauri-plugin-updater 下载安装 + process 重启
// ---------------------------------------------------------------------------

/**
 * 安装状态机：
 * - idle：未在安装（无可装内容或从未点过安装）；
 * - downloading：下载中（installProgress 为 0~100 百分比）；
 * - installing：下载完成、写入/校验中（通常很快）；
 * - ready：安装完成，等待用户点「重启」生效；
 * - failed：失败（installError 带原文，UI 引导手动下载兜底）。
 */
export type UpdateInstallStatus = 'idle' | 'downloading' | 'installing' | 'ready' | 'failed'

/**
 * installUpdate 的结果码（细粒度，UI 据此决定提示文案与降级路径）：
 * - ready：下载安装成功，可 relaunch；
 * - no-update：updater 清单无可装更新（或本地还没做过通道检测）；
 * - mismatch：清单版本与本通道检测出的最新版本不一致 —— 典型场景是
 *   release 通道 + 清单指向 rc（见模块头注释），拒绝安装防通道被绕过；
 * - failed：网络 / 验签 / 平台缺条目（Windows）等失败；
 * - unsupported：非 Tauri 环境（浏览器 dev）；
 * - in-progress：已有一次安装在进行中（连点保护）。
 */
export type UpdateInstallOutcome = 'ready' | 'no-update' | 'mismatch' | 'failed' | 'unsupported' | 'in-progress'

// 安装状态（模块级单例，与检查状态同范式；about 页直接渲染）
const installStatus = ref<UpdateInstallStatus>('idle')
/** 下载进度百分比（0~100；installing/ready 时为 100） */
const installProgress = ref(0)
/** 失败原文（installError 展示在关于页，含 Windows 缺条目等场景） */
const installError = ref('')

/**
 * 是否处于 Tauri 环境（热更新与启动检查同口径的守卫）。
 * 抽成函数：installUpdate / relaunchApp 两处复用，避免散落字面量判断。
 */
function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/**
 * 下载并安装检测到的更新（macOS 热更新主流程，关于页「一键更新」按钮）。
 *
 * # 流程
 * 1. 前置校验：Tauri 环境 + 当前通道已检测出最新版本（latestRelease）；
 * 2. updater check()：拉 tauri.conf.json 配置的清单端点（updater-manifest
 *    Release 的 latest.json），拿到与当前平台匹配的更新项；
 * 3. **通道校验**：update.version 必须等于本通道检测出的 latestVersion，
 *    否则拒绝（release 通道用户绝不能被塞进 rc，见模块头注释）；
 * 4. downloadAndInstall：进度回调回填 installProgress（百分比）；
 * 5. 成功后置 ready —— **不自动重启**：安装瞬间杀进程会打断用户正在做的
 *    操作，重启动作交给用户点「重启完成更新」（relaunchApp）。
 *
 * # 失败面
 * - Windows：清单缺 windows 条目 → check() 抛错 → failed + 手动下载引导；
 * - 网络/验签失败 → failed，原文落 installError；
 * - 清单不可达（首次 bootstrap 前 / CI 未发布清单）→ 同 failed。
 */
export async function installUpdate(): Promise<UpdateInstallOutcome> {
  if (!isTauriRuntime()) {
    return 'unsupported'
  }
  // 连点保护：下载/安装途中再次点击直接忽略（按钮在 UI 层也会禁用）
  if (installStatus.value === 'downloading' || installStatus.value === 'installing') {
    return 'in-progress'
  }
  // 期望版本 = 当前通道检测出的最新版本（没检测过就让用户先点「检查更新」）
  const expected = (latestRelease.value?.tagName || '').replace(/^v/, '')
  if (!expected) {
    return 'no-update'
  }
  installStatus.value = 'downloading'
  installProgress.value = 0
  installError.value = ''
  try {
    const { check } = await import('@tauri-apps/plugin-updater')
    const update = await check()
    if (!update) {
      // 清单版本 ≤ 本地版本：按"无可装更新"处理（不视为错误）
      installStatus.value = 'idle'
      return 'no-update'
    }
    // 通道校验（防 release 通道被清单里的 rc 绕过，见函数头注释）
    if (update.version.replace(/^v/, '') !== expected) {
      installStatus.value = 'idle'
      return 'mismatch'
    }
    // 下载 + 安装：进度事件按官方类型收窄（Started 带总长、Progress 带 chunk、Finished）
    let downloaded = 0
    let total = 0
    await update.downloadAndInstall((event) => {
      if (event.event === 'Started') {
        total = event.data.contentLength ?? 0
      }
      else if (event.event === 'Progress') {
        downloaded += event.data.chunkLength
        if (total > 0) {
          installProgress.value = Math.min(100, Math.round((downloaded / total) * 100))
        }
      }
      else if (event.event === 'Finished') {
        installStatus.value = 'installing'
        installProgress.value = 100
      }
    })
    installStatus.value = 'ready'
    return 'ready'
  }
  catch (err) {
    // Windows 缺平台条目 / 网络异常 / 验签失败都进这里：原文展示 + 手动下载兜底
    installError.value = err instanceof Error ? err.message : String(err)
    installStatus.value = 'failed'
    return 'failed'
  }
}

/**
 * 重启应用使更新生效（关于页「重启完成更新」按钮 / 安装完成后的引导动作）。
 * 非阻塞：relaunch 由系统接管进程生命周期；浏览器 dev 下为 no-op。
 */
export async function relaunchApp(): Promise<void> {
  if (!isTauriRuntime()) {
    return
  }
  try {
    const { relaunch } = await import('@tauri-apps/plugin-process')
    await relaunch()
  }
  catch {
    // relaunch 失败极罕见（权限/平台差异）：不打断用户，UI 仍可手动重启应用
  }
}

/** 供单测复位安装状态（生产代码不应调用） */
export function resetUpdateInstallStateForTest(): void {
  installStatus.value = 'idle'
  installProgress.value = 0
  installError.value = ''
}

/**
 * 应用更新检测（单例 state + 动作）。
 * 关于页与启动链路共用，保证两处看到同一份检查结果。
 */
export function useAppUpdate() {
  // 首次拿到 composable 时把落盘通道读进内存（同步，界面首帧即显示正确值）
  ensureChannelLoaded()
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
    /** 当前更新通道（只读展示用，写入请走 setUpdateChannel） */
    updateChannel,
    /** 切换更新通道（写 localStorage + 重置检查状态，见函数注释） */
    setUpdateChannel,
    /** 是否有新版本（derived：status === 'available'） */
    updateAvailable: computed(() => status.value === 'available'),
    /** 热更新安装状态机（downloading/installing/ready/failed） */
    installStatus,
    /** 热更新下载进度（0~100） */
    installProgress,
    /** 热更新失败原文 */
    installError,
    /** 下载并安装检测到的更新（macOS；Windows 会 failed 并引导手动下载） */
    installUpdate,
    /** 安装完成后重启应用 */
    relaunchApp,
    checkForUpdate,
    maybeAutoCheckOnStartup,
  }
}
