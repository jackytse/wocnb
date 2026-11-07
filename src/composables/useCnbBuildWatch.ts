/**
 * 构建结果通知（轮询 → 系统通知 + 应用内通知面板）。
 *
 * # 为什么是轮询
 *
 * CNB OpenAPI 的 199 个端点里**没有任何推送通道**：没有 SSE、没有 Webhook
 * 接收端点、没有长轮询接口。构建状态只能拉取（GET /{repo}/-/build/logs），
 * 因此本功能本质是"定时间隔轮询 + 客户端侧比对快照"。这也决定了两个设计约束：
 * 1. 轮询必须在应用进程存活期间一直跑（关窗后驻留托盘）；
 * 2. 轮询必须节流（并发上限 + 请求错峰），否则仓库多的组织一次 tick 就会
 *    把 CNB 网关打爆（网关对突发请求有风控，会返回 403，见 useCnbAuth 的
 *    httpFetch 注释）。
 *
 * # 为什么关闭 backgroundThrottling（关键，勿删）
 *
 * macOS WKWebView 在窗口不可见（点关闭按钮后窗口被 hide、应用仅驻留托盘）
 * 时会**节流 JS 定时器**：后台标签/隐藏窗口的 setTimeout/setInterval 会被降频
 * 到最低 ~1 次/分钟甚至更久（WebKit 的 background throttling 策略）。
 * 定时器被节流 → 轮询不再按时执行 → "应用在后台时收不到构建通知"，
 * 而这恰恰是本功能的核心场景。因此必须在 src-tauri/tauri.conf.json 里
 * 给主窗口设置 "backgroundThrottling": "disabled"（Tauri 2 的
 * BackgroundThrottlingPolicy 枚举取值是 disabled / suspend / throttle，
 * 默认 suspend；"disabled" 即"关闭后台节流"，等价于布尔语义的 false），
 * 让 WebView 在隐藏状态下仍按真实间隔触发定时器。
 *
 * 即便如此仍有不确定因素：macOS 的 App Nap（进程级节能，当应用无窗口、
 * 无音频、长时间无用户交互时可能把整个进程降频）不在 WebView 控制范围内，
 * 系统极度省电（低电量模式）时也可能延迟通知。因此"准时"的保证只到
 * WebView 层，进程级省电策略属系统行为，无法从应用侧强制。
 *
 * # 结构：纯函数与副作用分离
 *
 * - 纯函数（diffBuildSnapshot / summarizeNotifications / shouldNotifyStatus 等）
 *   不做 IO、不读响应式状态，便于单测（见 __tests__/useCnbBuildWatch.test.ts）；
 * - 副作用（定时器、网络、系统通知、localStorage）集中在 initBuildWatcher()
 *   及其内部函数里，由 main.ts 在 restoreSession() 之后调用一次。
 */
import { computed, ref, watch } from 'vue'
import { useStorage } from '@vueuse/core'
import { i18n } from '../i18n'
import {
  CnbApiError,
  cnbToken,
  fetchCnbGroupRepos,
  selectedGroup,
  type CnbRepo,
} from './useCnbAuth'
import { fetchBuildLogs } from './useCnbRepo'

// ---------------------------------------------------------------------------
// 纯函数区（可单测，禁止读写响应式状态 / 禁止网络请求）
// ---------------------------------------------------------------------------

/**
 * 快照中的单条构建（只记录 pending 中的构建）。
 * 字段与 dto.LogInfo 对齐，用于构建结束后的通知文案（分支 + 提交标题）。
 */
export interface BuildEntry {
  /** 构建序号（仓库内唯一） */
  sn: string
  /** 上一轮见到的状态（恒为 pending，保留字段便于排查） */
  status: string
  /** 提交标题 */
  commitTitle: string
  /** 源分支 / 引用 */
  sourceRef: string
  /** 触发者昵称 */
  nickName: string
  /** 构建创建时间（ISO 8601） */
  createTime: string
}

/**
 * 构建快照：repoPath -> sn -> 构建条目。
 *
 * 语义：**只存上一轮处于 pending（运行中/排队中）的构建**。
 * 之所以只存 pending，是因为"结束"的判定依据就是"上一轮在里面、这一轮不在"；
 * 若把成功/失败也存进快照，快照会无限增长（构建历史是无界的）。
 */
export type BuildSnapshot = Record<string, Record<string, BuildEntry>>

/** 已结束的构建（由 diff 产出，状态待回查） */
export interface FinishedBuild {
  repoPath: string
  sn: string
  commitTitle: string
  sourceRef: string
  nickName: string
  createTime: string
}

/** 已回查最终状态的构建（status 为 '' 表示回查失败/状态未知） */
export interface ResolvedBuild extends FinishedBuild {
  status: string
}

/** diff 结果：已结束的构建 + 新增的 pending 构建 */
export interface BuildSnapshotDiff {
  finished: FinishedBuild[]
  started: string[]
}

/** 合并摘要的计数（成功/失败/取消/未知分项） */
export interface BuildNotifyDigest {
  total: number
  success: number
  error: number
  cancel: number
  unknown: number
}

/** 通知计划：逐条 or 合并成一条摘要 */
export interface BuildNotifyPlan {
  /** single = 逐条通知；digest = 合并成一条摘要（避免通知轰炸） */
  mode: 'single' | 'digest'
  /** 逐条模式的条目（digest 模式为空数组） */
  singles: ResolvedBuild[]
  /** 摘要计数（两种模式都会算，便于日志/测试） */
  digest: BuildNotifyDigest
}

/**
 * 复合键：repoPath + sn。
 *
 * 为什么需要：sn 只在**仓库内**唯一，不同仓库可能出现相同 sn。
 * 若只用 sn 做键，跨仓库的相同 sn 会互相"串味"（A 仓库的构建结束会被
 * 误当成 B 仓库的那条还在跑）。所有需要全局唯一标识的地方都走本函数。
 */
export function buildKey(repoPath: string, sn: string): string {
  return `${repoPath}#${sn}`
}

/**
 * 归一化仓库路径：去掉首尾空白与结尾多余的 '/'。
 *
 * 为什么需要：CNB 的仓库列表接口偶尔返回带结尾 '/' 的 path，而构建接口
 * 与页面路由用的是不带 '/' 的形式；不归一化会让同一个仓库在快照里出现
 * 两个键，导致"构建凭空消失 → 全部判定为已结束"的误报。
 */
export function ensureTrailingSlashFree(repoPath: string): string {
  return (repoPath || '').trim().replace(/\/+$/, '')
}

/**
 * 比对两轮快照，得出"这一轮结束的构建"与"这一轮新出现的 pending 构建"。
 *
 * 规则：
 * - prev 里有、next 里没有（含整个仓库从 next 中消失）→ finished；
 * - next 里有、prev 里没有 → started（**只更新快照，不发通知**：
 *   构建开始不是用户关心的事件，通知一次构建就开始会非常吵）；
 * - prev 为空（首次基线）→ finished 恒为空，避免把历史 pending 全当"刚结束"。
 *
 * @param prev 上一轮快照（只含 pending）
 * @param next 本轮快照（只含 pending）
 */
export function diffBuildSnapshot(prev: BuildSnapshot, next: BuildSnapshot): BuildSnapshotDiff {
  const finished: FinishedBuild[] = []
  const started: string[] = []
  const prevMap = prev ?? {}
  const nextMap = next ?? {}

  // 结束判定：以"上一轮存在"为基准遍历（仓库整条消失时 nextMap[repo] 为 undefined，
  // 等价于该仓库全部 pending 都结束）
  for (const rawRepoPath of Object.keys(prevMap)) {
    const prevRepo = prevMap[rawRepoPath] ?? {}
    const nextRepo = nextMap[rawRepoPath] ?? {}
    for (const sn of Object.keys(prevRepo)) {
      if (nextRepo[sn]) {
        continue
      }
      const entry = prevRepo[sn]
      finished.push({
        repoPath: rawRepoPath,
        sn,
        // 文案字段全部兜底空串：通知里出现 undefined 比空白更糟
        commitTitle: entry?.commitTitle ?? '',
        sourceRef: entry?.sourceRef ?? '',
        nickName: entry?.nickName ?? '',
        createTime: entry?.createTime ?? '',
      })
    }
  }

  // 新增判定：以"本轮存在"为基准遍历
  for (const repoPath of Object.keys(nextMap)) {
    const prevRepo = prevMap[repoPath] ?? {}
    const nextRepo = nextMap[repoPath] ?? {}
    for (const sn of Object.keys(nextRepo)) {
      if (!prevRepo[sn]) {
        started.push(buildKey(repoPath, sn))
      }
    }
  }

  return { finished, started }
}

/**
 * 该状态是否值得打扰用户。
 *
 * CNB 构建状态枚举（官方原话）：pending / success / error / cancel。
 * 其中 **pending 就是"运行中/排队中"**（没有单独的 running）——它不是终态，
 * 不该发通知；未知值（接口新增枚举或解析异常）同样不发，宁可漏报不误报。
 */
export function shouldNotifyStatus(status: string): boolean {
  return status === 'success' || status === 'error' || status === 'cancel'
}

/**
 * 把"已结束构建列表"整理成通知计划：少量逐条、大量合并。
 *
 * 为什么合并：一次推送里可能有十几个构建同时结束（比如合并主干触发的
 * 批量构建），逐条弹 15 个系统通知会把用户的屏幕糊住，反而看不到关键信息。
 * 因此 finished 数 > maxSingle 时只发一条摘要（成功 x / 失败 y / 取消 z）。
 *
 * @param finished 已回查最终状态的构建列表
 * @param maxSingle 逐条通知的数量上限（默认 5）
 */
export function summarizeNotifications(finished: ResolvedBuild[], maxSingle = 5): BuildNotifyPlan {
  const list = Array.isArray(finished) ? finished : []
  const digest: BuildNotifyDigest = { total: list.length, success: 0, error: 0, cancel: 0, unknown: 0 }
  for (const item of list) {
    switch (item.status) {
      case 'success':
        digest.success += 1
        break
      case 'error':
        digest.error += 1
        break
      case 'cancel':
        digest.cancel += 1
        break
      default:
        // ''（回查失败/未知）与其他枚举都归入 unknown
        digest.unknown += 1
    }
  }
  // maxSingle 至少为 1：传 0 或负数时退化为"只发摘要"，不产生空计划
  const limit = Math.max(1, Math.floor(maxSingle))
  const mode: BuildNotifyPlan['mode'] = list.length <= limit ? 'single' : 'digest'
  return {
    mode,
    singles: mode === 'single' ? list.slice() : [],
    digest,
  }
}

/**
 * 文本截断：超长时保留 max-1 个字符并追加省略号。
 * 用于通知正文（提交标题可能很长，macOS 通知中心会自己折行但体验很差）。
 */
export function truncateText(text: string, max: number): string {
  const value = (text ?? '').trim()
  if (max <= 0 || value.length <= max) {
    return value
  }
  return `${value.slice(0, max - 1)}…`
}

/**
 * 判断错误是否为"403"（HTTP 层面的语义：服务端拒绝了这次请求）。
 *
 * 为什么不用 instanceof：本模块在单测里会 mock useCnbAuth（CnbApiError 是
 * 替身类），instanceof 判断会失效；同时保持对"任何带 kind 字段的错误对象"
 * 的宽容识别，避免因为跨模块类实例不一致而漏判权限问题。
 *
 * 注意（与 isMissingScopeError 的区别，勿混用）：本函数只回答"是不是 403"，
 * **不回答"是不是缺权限"**。CNB 网关的风控（突发请求/指纹）同样返回 403，
 * 那种 403 与"令牌缺 scope"在 HTTP 层面无法区分——只能靠 errmsg 里能否解析
 * 出具体的 scope 名来区分，见 isMissingScopeError。
 */
export function isForbiddenError(err: unknown): boolean {
  if (err instanceof CnbApiError && err.kind === 'forbidden') {
    return true
  }
  return typeof err === 'object' && err !== null && (err as { kind?: unknown }).kind === 'forbidden'
}

/**
 * 判断错误是否确认为"令牌缺少某个具体 scope"（可用于永久跳过该仓库）。
 *
 * # 为什么需要这个更严格的判定（线上风险点）
 *
 * 本项目已知事实：CNB 网关对突发请求有风控，会直接返回 403（正是为了绕开
 * rustls 指纹被风控，才自建了 Rust native-tls 请求通道）。若把"任何 403"
 * 都当成"缺 repo-cnb-history:r"，一次风控抖动就会让该仓库**整个会话**被
 * 永久跳过（scopeMissing 没有移除路径），用户只能看到设置页计数 +1，
 * 且没有任何恢复途径。
 *
 * 因此只在 errmsg 里**能解析出具体 scope 名**（CnbApiError.missingScope，
 * 由 useCnbAuth 的 parseMissingScope 用 /[a-z][a-z0-9-]*:(?:r|rw)(?![\w-])/
 * 解析，如 "repo-cnb-history:r"）时才认定为缺权限；解析不出来的 403
 * （风控、权限服务抖动等无法归因）按**普通失败**处理：本轮快照照旧并回、
 * 计入退避、下一轮重试。
 */
export function isMissingScopeError(err: unknown): boolean {
  if (!isForbiddenError(err)) {
    return false
  }
  if (err instanceof CnbApiError) {
    return typeof err.missingScope === 'string' && err.missingScope.length > 0
  }
  const missingScope = (err as { missingScope?: unknown }).missingScope
  return typeof missingScope === 'string' && missingScope.length > 0
}

// ---------------------------------------------------------------------------
// 应用内通知数据（面板消费）
// ---------------------------------------------------------------------------

/** 构建通知条目（通知面板展示用） */
export interface BuildNotice {
  /** 唯一 id（时间戳 + 序号，同一毫秒内也不会重复） */
  id: string
  /** 仓库完整路径（点击跳转 /repos/<repoPath>?tab=builds&sn=<sn>） */
  repoPath: string
  /** 仓库名（列表里取名字，取不到时用路径末段兜底） */
  repoName: string
  /** 构建序号 */
  sn: string
  /** 最终状态；'' 表示状态未知（回查失败，界面上按"状态未知"展示） */
  status: string
  commitTitle: string
  sourceRef: string
  nickName: string
  /** 通知时间（毫秒时间戳，面板用相对时间展示） */
  time: number
  /** 是否为"应用未运行期间结束"的补推条目 */
  leftover: boolean
}

/** 通知面板最多保留的条目数（超出丢弃最旧的，避免 localStorage/内存无界增长） */
const MAX_FEED_SIZE = 50

/** 构建通知列表（最新在前，最多 50 条） */
export const buildNoticeFeed = ref<BuildNotice[]>([])

/** 未读构建通知数（铃铛徽标；打开面板即清零） */
export const unreadBuildCount = ref(0)

/** 缺少 repo-cnb-history:r 权限的仓库路径（本次会话内跳过轮询） */
const scopeMissingPaths = ref<string[]>([])

/** 缺权限仓库数量（设置页展示"N 个仓库缺少构建读取权限"） */
export const buildScopeMissingCount = computed(() => scopeMissingPaths.value.length)

/** 系统通知权限被拒标记（设置页展示提示） */
export const buildNotifyPermissionDenied = ref(false)

/** 最近一次 tick 成功关注的仓库数（设置页展示"当前关注 N 个仓库"） */
export const buildWatchRepoCount = ref(0)

/** 仓库列表是否被截断（组织仓库 >100 时只关注最近更新的 100 个） */
export const buildWatchTruncated = ref(false)

/** 通知 id 序列号（同一毫秒内多次 push 时保证 id 唯一） */
let noticeSeq = 0

/** 追加一条通知到列表头部（自动裁剪到 50 条并累加未读数） */
function pushNotice(notice: Omit<BuildNotice, 'id'>): void {
  noticeSeq += 1
  const item: BuildNotice = { ...notice, id: `${notice.time}-${noticeSeq}` }
  buildNoticeFeed.value = [item, ...buildNoticeFeed.value].slice(0, MAX_FEED_SIZE)
  unreadBuildCount.value += 1
}

/** 标记构建通知为已读（面板打开时调用：徽标清零，列表保留） */
export function markBuildNoticesRead(): void {
  unreadBuildCount.value = 0
}

/** 清空通知列表与未读数（退出登录时调用，避免上一个账号的通知残留） */
export function clearBuildNotices(): void {
  buildNoticeFeed.value = []
  unreadBuildCount.value = 0
}

// ---------------------------------------------------------------------------
// 持久化配置（localStorage）
// ---------------------------------------------------------------------------

/** 是否启用构建结果通知（默认开启：这是本版本的主功能） */
export const buildNotifyEnabled = useStorage<boolean>('cnb-build-notify-enabled', true)

/**
 * 轮询间隔（秒），可选 30 / 60 / 120，默认 60。
 * 存储为 number；非法值在 readIntervalSec() 里归一为默认值。
 */
export const buildNotifyIntervalSec = useStorage<number>('cnb-build-notify-interval-sec', 60)

/** 间隔可选值（设置页下拉与校验共用同一份常量，避免两处漂移） */
export const BUILD_NOTIFY_INTERVAL_OPTIONS = [30, 60, 120] as const

/**
 * 快照序列化器（显式指定，防 vueuse 猜错）。
 *
 * 踩坑记录（与 useCnbAuth 的 cnbUserSerializer 同源）：useStorage 会按默认值
 * 推断序列化器；默认值是对象时推断虽为 'object'，但一旦默认值写错/改成 null，
 * 就会被推断成 'any' 并退化为 String(v)，把对象写成 "[object Object]"。
 * 这里显式 JSON 序列化 + 读取时做结构校验，任何脏数据都归零为「空快照」，
 * 而不是让整个轮询因为 JSON.parse 抛错而瘫痪。
 */
const buildSnapshotSerializer = {
  read: (raw: string | null): BuildSnapshot => {
    if (raw == null || raw === '' || raw === 'null') {
      return {}
    }
    try {
      const parsed = JSON.parse(raw) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {}
      }
      // 逐层校验：只保留 repoPath -> sn -> 对象 的合法结构，脏条目直接丢弃
      const result: BuildSnapshot = {}
      for (const [repoPath, repoValue] of Object.entries(parsed as Record<string, unknown>)) {
        if (!repoValue || typeof repoValue !== 'object' || Array.isArray(repoValue)) {
          continue
        }
        const entries: Record<string, BuildEntry> = {}
        for (const [sn, entryValue] of Object.entries(repoValue as Record<string, unknown>)) {
          if (!entryValue || typeof entryValue !== 'object' || Array.isArray(entryValue)) {
            continue
          }
          const entry = entryValue as Partial<BuildEntry>
          entries[sn] = {
            sn: typeof entry.sn === 'string' ? entry.sn : sn,
            status: typeof entry.status === 'string' ? entry.status : 'pending',
            commitTitle: typeof entry.commitTitle === 'string' ? entry.commitTitle : '',
            sourceRef: typeof entry.sourceRef === 'string' ? entry.sourceRef : '',
            nickName: typeof entry.nickName === 'string' ? entry.nickName : '',
            createTime: typeof entry.createTime === 'string' ? entry.createTime : '',
          }
        }
        if (Object.keys(entries).length > 0) {
          result[repoPath] = entries
        }
      }
      return result
    }
    catch {
      // 旧版本脏数据（如 "[object Object]"）：按空快照处理，重新建立基线
      return {}
    }
  },
  write: (value: BuildSnapshot): string => JSON.stringify(value ?? {}),
}

/**
 * 上一轮 pending 快照（持久化，用于"离线补推"）。
 * 键名带 cnb- 前缀，与本项目其他 localStorage 键风格一致。
 */
export const buildSnapshot = useStorage<BuildSnapshot>('cnb-build-snapshot', {}, undefined, {
  serializer: buildSnapshotSerializer,
})

/**
 * 快照所属的组织路径。
 *
 * 为什么需要单独存：selectedGroup 不持久化（每次启动默认选中组织列表第一项），
 * 若用户在 A 组织时退出、下次启动默认落在 B 组织，把 A 的快照当 B 的基线用
 * 就会误报"一批构建已结束"。记录归属后，组织不一致时直接丢弃旧快照。
 */
const buildSnapshotGroup = useStorage<string>('cnb-build-snapshot-group', '')

// ---------------------------------------------------------------------------
// 副作用：定时器 / 网络 / 系统通知
// ---------------------------------------------------------------------------

/** 并发上限：同时最多 3 个构建状态请求（再多容易触发网关风控） */
const BUILD_WATCH_CONCURRENCY = 3

/** 请求错峰间隔：相邻请求至少间隔 150ms，摊平瞬时并发 */
const BUILD_WATCH_STAGGER_MS = 150

/** 仓库列表缓存有效期：5 分钟（仓库增删不频繁，避免每轮都拉列表） */
const REPO_LIST_CACHE_TTL_MS = 5 * 60 * 1000

/** 单组织最多关注的仓库数（按最近更新时间取前 N 个） */
const MAX_WATCH_REPOS = 100

/** 失败退避上限：5 分钟 */
const MAX_BACKOFF_MS = 5 * 60 * 1000

/** 首次 tick 延迟（等登录态与组织列表就绪，不与首屏请求抢带宽） */
const FIRST_TICK_DELAY_MS = 3000

/** 窗口重新可见时的补跑冷却：距上一轮不足 10s 就不补，避免频繁切窗口等于缩短间隔 */
const VISIBILITY_RETICK_COOLDOWN_MS = 10 * 1000

/** initBuildWatcher 幂等标记（main.ts 重复调用不会重复注册定时器/监听） */
let watcherReady = false

/** 上一轮 tick 结束时间（毫秒时间戳，用于窗口可见补跑的冷却判断） */
let lastTickAt = 0

/** 当前定时器句柄（null 表示未在运行） */
let tickTimer: ReturnType<typeof setTimeout> | null = null

/** 单轮重入保护：上一轮未跑完时跳过本轮（慢网络下防止 tick 堆叠） */
let tickRunning = false

/** 是否已建立基线（首次 tick 只建基线、不发通知） */
let baselineReady = false

/** 连续失败轮数（用于间隔翻倍退避） */
let failedRounds = 0

/** 本次会话内缺权限、已跳过轮询的仓库集合（Set 便于 O(1) 判断，ref 数组给界面） */
const scopeMissing = new Set<string>()

/** 当前轮询生效的组织路径（用于识别组织切换） */
let activeGroupPath = ''

/** 仓库列表缓存（单条，按组织路径 + 时间戳失效） */
let repoCache: { groupPath: string, repos: CnbRepo[], truncated: boolean, fetchedAt: number } | null = null

/** 系统通知权限缓存：null = 尚未询问过 */
let notificationGranted: boolean | null = null

/** 本次会话是否已经主动弹过系统权限框（避免反复打扰） */
let permissionRequested = false

/** 是否运行在 Tauri 桌面环境（浏览器 dev 下跳过系统通知，只写应用内通知） */
function isTauriEnv(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** 让出事件循环（错峰用） */
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** 允许的间隔值归一：只接受 30/60/120，其他值退回默认 60 */
function normalizeIntervalSec(value: number): number {
  const num = Number(value)
  return (BUILD_NOTIFY_INTERVAL_OPTIONS as readonly number[]).includes(num) ? num : 60
}

/**
 * 当前应使用的轮询间隔（含失败退避）。
 *
 * 退避策略：连续 3 轮出现请求失败后间隔翻倍（60s → 120s → 240s → 上限 300s），
 * 任意一轮全成功立刻恢复用户设定值。目的：断网/网关限流时不要继续硬打接口，
 * 但也不要彻底停止（否则网络恢复后用户永远收不到通知）。
 */
function currentIntervalMs(): number {
  const baseMs = normalizeIntervalSec(buildNotifyIntervalSec.value) * 1000
  if (failedRounds < 3) {
    return baseMs
  }
  const factor = 2 ** Math.min(failedRounds - 2, 4)
  return Math.min(baseMs * factor, MAX_BACKOFF_MS)
}

/** 当前是否应处于运行态（登录 + 已选组织 + 开关打开） */
function isActive(): boolean {
  return !!cnbToken.value && !!selectedGroup.value?.path && buildNotifyEnabled.value === true
}

/** 标记某仓库缺少构建读取权限（本次会话内跳过） */
function markScopeMissing(repoPath: string): void {
  if (!repoPath || scopeMissing.has(repoPath)) {
    return
  }
  scopeMissing.add(repoPath)
  scopeMissingPaths.value = [...scopeMissing]
}

/** 重置快照（同时清空持久化与归属标记） */
function resetSnapshot(groupPath: string): void {
  buildSnapshot.value = {}
  buildSnapshotGroup.value = groupPath
}

/**
 * 并发受限的任务执行器（带启动错峰）。
 *
 * 为什么要自己实现而不是 Promise.all 一把梭：
 * 1. 一个组织可能有上百个仓库，一次性并发 100 个请求会触发 CNB 网关风控
 *    （表现为大面积 403/超时，反而更慢）；
 * 2. 错峰（每个 worker 首个请求延迟 workerIndex * staggerMs，且相邻请求之间
 *    再等 staggerMs）把瞬时峰值摊平到网关友好范围内；
 * 3. 单个任务异常不影响其他任务（内部 catch），失败由调用方通过计数感知。
 */
async function runWithLimit(tasks: (() => Promise<void>)[], limit: number, staggerMs: number): Promise<void> {
  if (tasks.length === 0) {
    return
  }
  let cursor = 0
  const workerCount = Math.min(Math.max(1, limit), tasks.length)
  const workers = Array.from({ length: workerCount }, async (_, workerIndex) => {
    // 首个请求错峰启动：worker 0 立即打，worker 1 等 150ms，worker 2 等 300ms
    if (workerIndex > 0 && staggerMs > 0) {
      await sleep(staggerMs * workerIndex)
    }
    let first = true
    while (cursor < tasks.length) {
      const index = cursor
      cursor += 1
      const task = tasks[index]
      if (!task) {
        continue
      }
      // 同一 worker 的相邻请求之间也保持间隔（首个请求已由上面的错峰覆盖）
      if (!first && staggerMs > 0) {
        await sleep(staggerMs)
      }
      first = false
      try {
        await task()
      }
      catch (err) {
        // 兜底：任务自身已 try/catch，这里只防御未来的改动引入未捕获异常
        console.warn('[build-watch] 任务执行异常：', err)
      }
    }
  })
  await Promise.all(workers)
}

/**
 * 拉取（并缓存 5 分钟）组织仓库列表。
 * 超过 100 个仓库时按 updatedAt 倒序截断到 100（最近更新的仓库更可能产生构建）。
 */
async function loadRepoList(groupPath: string): Promise<{ repos: CnbRepo[], truncated: boolean }> {
  const now = Date.now()
  if (repoCache && repoCache.groupPath === groupPath && now - repoCache.fetchedAt < REPO_LIST_CACHE_TTL_MS) {
    return { repos: repoCache.repos, truncated: repoCache.truncated }
  }
  const raw = await fetchCnbGroupRepos(groupPath, 1, MAX_WATCH_REPOS)
  // updatedAt 解析失败（空串/非法）时按 0 处理，保证排序稳定（NaN 会让比较失效）
  const timeOf = (value: string): number => {
    const parsed = Date.parse(value || '')
    return Number.isNaN(parsed) ? 0 : parsed
  }
  const sorted = [...raw].sort((a, b) => timeOf(b.updatedAt) - timeOf(a.updatedAt))
  // 是否被截断：列表接口单页上限 100，拉满一页时**不能直接断定"超过 100"**
  // （恰好 100 个仓库是很常见的边界，QA 缺陷 #5）。改用一次极轻量的探测请求
  // （第 2 页、每页 1 条）确认是否真的还有更多仓库；探测失败不影响主流程，
  // 按"未截断"处理（宁可少报，也不要给用户看错误的警示）。
  let truncated = false
  if (sorted.length >= MAX_WATCH_REPOS) {
    try {
      const probe = await fetchCnbGroupRepos(groupPath, 2, 1)
      truncated = Array.isArray(probe) && probe.length > 0
    }
    catch {
      truncated = false
    }
  }
  const repos = sorted.slice(0, MAX_WATCH_REPOS).filter(repo => !!repo.path)
  repoCache = { groupPath, repos, truncated, fetchedAt: now }
  return { repos, truncated }
}

/** 仓库名解析器：优先用列表里的 name，取不到时回退路径末段 */
function makeRepoNameResolver(repos: CnbRepo[]): (repoPath: string) => string {
  const map = new Map<string, string>()
  for (const repo of repos) {
    map.set(ensureTrailingSlashFree(repo.path), repo.name || repo.path)
  }
  return (repoPath: string): string => {
    const direct = map.get(repoPath)
    if (direct) {
      return direct
    }
    const segments = repoPath.split('/').filter(Boolean)
    return segments[segments.length - 1] || repoPath
  }
}

/**
 * 确保系统通知权限（按需申请）。
 *
 * 原则（用户体感至关重要）：**启动阶段绝不弹权限框**。
 * 只有两种情况会申请：用户在设置页打开开关（interactive=true 由设置页触发），
 * 或第一次真的有构建结果要通知时（首条通知顺带申请一次）。
 * 浏览器 dev 环境（没有 Tauri 运行时）直接返回 false，安静降级为仅应用内通知。
 *
 * 口径说明（主理人裁决，勿当 bug 改掉）：上面两处申请点**是刻意保留的双入口**
 * ——"用户打开开关"给意图明确的用户即时授权，"首次要发通知"兜住老用户
 * （升级前就开着开关、从未走过设置页）。二者共用本函数 + `permissionRequested`
 * 会话级标记，因此无论走哪个入口，一次会话最多只弹一次系统权限框，
 * 启动路径上则一次都不会弹。
 */
async function ensureNotificationPermission(interactive: boolean): Promise<boolean> {
  if (!isTauriEnv()) {
    return false
  }
  if (notificationGranted === true) {
    return true
  }
  try {
    const { isPermissionGranted, requestPermission } = await import('@tauri-apps/plugin-notification')
    if (await isPermissionGranted()) {
      notificationGranted = true
      buildNotifyPermissionDenied.value = false
      return true
    }
    if (!interactive) {
      return false
    }
    // 本次会话只主动弹一次系统权限框：用户拒绝后再反复调用 requestPermission
    // 也只会得到 denied（macOS 不会再弹），但白跑 IPC 且容易让人以为应用"卡住"
    if (permissionRequested) {
      return false
    }
    permissionRequested = true
    const result = await requestPermission()
    notificationGranted = result === 'granted'
    // denied（用户拒绝）与 default（未决定）都不再反复弹窗：denied 时设置页给文字指引
    buildNotifyPermissionDenied.value = result === 'denied'
    return notificationGranted
  }
  catch (err) {
    console.warn('[build-watch] 系统通知权限检查失败：', err)
    return false
  }
}

/**
 * 供设置页调用：用户主动开启开关时申请一次通知权限。
 * 返回是否已获得权限（false 时设置页展示"打开系统设置"的文字指引）。
 *
 * 会重置"本次会话已问过"的标记：用户可能刚在系统设置里放开了权限，
 * 再点一次开关应当重新检查一次真实状态。
 */
export async function requestBuildNotificationPermission(): Promise<boolean> {
  permissionRequested = false
  notificationGranted = null
  return ensureNotificationPermission(true)
}

/** 发送一条 macOS 系统通知（非 Tauri 环境或未授权时静默跳过） */
async function sendSystemNotification(title: string, body: string): Promise<void> {
  if (!isTauriEnv()) {
    return
  }
  const granted = await ensureNotificationPermission(true)
  if (!granted) {
    return
  }
  try {
    const { sendNotification } = await import('@tauri-apps/plugin-notification')
    sendNotification({ title, body })
  }
  catch (err) {
    console.warn('[build-watch] 系统通知发送失败：', err)
  }
}

/** 状态 -> 通知标题的 i18n 键（成功/失败/取消/未知） */
function titleKeyOf(status: string): string {
  switch (status) {
    case 'success':
      return 'buildWatch.notify.successTitle'
    case 'error':
      return 'buildWatch.notify.errorTitle'
    case 'cancel':
      return 'buildWatch.notify.cancelTitle'
    default:
      return 'buildWatch.notify.unknownTitle'
  }
}

/**
 * 通知正文：'{源分支} · {提交标题}'，提交标题截断 80 字符、整行再截 100 字符。
 * macOS 通知中心可展示的行数有限，过长的正文只会被系统截掉且看起来像 bug。
 */
function buildBodyText(sourceRef: string, commitTitle: string): string {
  const title = truncateText(commitTitle, 80) || '—'
  const ref = truncateText(sourceRef, 40) || '—'
  return truncateText(`${ref} · ${title}`, 100)
}

/**
 * 回查已结束构建的最终状态。
 *
 * 为什么必须回查：pending 列表只能告诉我们"这条构建不在运行了"，
 * 但**无法区分 success / error / cancel**（三者都会离开 pending）。
 * 列表接口支持 sn 精确过滤，因此回查 1 次即可拿到终态。
 *
 * 回查失败（网络/权限/查不到）时 status 保持 ''（状态未知）：
 * 这种条目**只写应用内通知、不发系统通知**——把未知状态报成"成功"
 * 或"失败"是明确的产品红线（会误导用户以为发布成功）。
 */
async function resolveFinishedStatuses(finished: FinishedBuild[]): Promise<ResolvedBuild[]> {
  const results: ResolvedBuild[] = finished.map(item => ({ ...item, status: '' }))
  const tasks = results.map(result => async () => {
    try {
      const { items } = await fetchBuildLogs(result.repoPath, { sn: result.sn, pageSize: 10 })
      // 优先按 sn 精确匹配（服务端应已过滤，这里再兜一层防御）
      const hit = items.find(item => item.sn === result.sn) ?? items[0]
      if (!hit) {
        return
      }
      if (shouldNotifyStatus(hit.status)) {
        result.status = hit.status
        // 回查结果里的文案字段更权威（提交标题可能在构建期间被 rebase 更新）
        result.commitTitle = hit.commitTitle || result.commitTitle
        result.sourceRef = hit.sourceRef || result.sourceRef
        result.nickName = hit.nickName || result.nickName
        return
      }
      // 回查到非终态（极少见的竞态：查询间隙构建被重跑）→ 按未知处理，不打扰用户
      result.status = ''
    }
    catch (err) {
      // 回查路径同理：只有确认缺 scope 才跳过该仓库；风控 403 只是这一次
      // 回查失败（该条构建按"状态未知"进面板），不该让整仓从此不再轮询
      if (isMissingScopeError(err)) {
        markScopeMissing(result.repoPath)
      }
      console.warn(`[build-watch] 回查构建状态失败 ${result.repoPath}#${result.sn}：`, err)
    }
  })
  await runWithLimit(tasks, BUILD_WATCH_CONCURRENCY, BUILD_WATCH_STAGGER_MS)
  return results
}

/** 逐条 / 摘要方式发出构建结果通知（系统通知 + 应用内通知同步写入） */
async function emitResolvedNotices(resolved: ResolvedBuild[], nameOf: (repoPath: string) => string): Promise<void> {
  if (resolved.length === 0) {
    return
  }
  const plan = summarizeNotifications(resolved)
  const now = Date.now()

  if (plan.mode === 'single') {
    for (const item of plan.singles) {
      const repoName = nameOf(item.repoPath)
      const title = i18n.global.t(titleKeyOf(item.status), { repo: repoName })
      const body = buildBodyText(item.sourceRef, item.commitTitle)
      // 状态未知（''）只进应用内列表：系统通知里说不清成功还是失败，容易误导
      if (shouldNotifyStatus(item.status)) {
        await sendSystemNotification(title, body)
      }
      pushNotice({
        repoPath: item.repoPath,
        repoName,
        sn: item.sn,
        status: item.status,
        commitTitle: item.commitTitle,
        sourceRef: item.sourceRef,
        nickName: item.nickName,
        time: now,
        leftover: false,
      })
    }
    return
  }

  // 合并摘要：一条系统通知 + 每条构建一条应用内记录（面板里仍可逐条查看）
  //
  // 状态未知的守卫（与 single 分支口径一致，QA 缺陷 #1）：摘要模式同样
  // 必须遵守"状态未知不发系统通知"——若 6 个构建结束时 sn 回查全部失败，
  // 弹一条「6 个构建已结束 / 未知 6」既没有信息量又让人以为构建成功了。
  // 因此只有拿到**至少一个确定终态**（success/error/cancel）才发系统通知，
  // 未知数量改为在正文尾部追加；全未知则只写应用内面板。
  const knownCount = plan.digest.success + plan.digest.error + plan.digest.cancel
  if (knownCount > 0) {
    const digestTitle = i18n.global.t('buildWatch.notify.digestTitle', { count: plan.digest.total })
    const digestBody = i18n.global.t('buildWatch.notify.digestBody', {
      success: plan.digest.success,
      error: plan.digest.error,
      cancel: plan.digest.cancel,
    })
    // 混有未知状态时追加一句，避免"摘要计数加起来不等于总数"让人困惑
    const unknownSuffix = plan.digest.unknown > 0
      ? i18n.global.t('buildWatch.notify.digestUnknown', { count: plan.digest.unknown })
      : ''
    await sendSystemNotification(digestTitle, `${digestBody}${unknownSuffix}`)
  }
  for (const item of resolved) {
    pushNotice({
      repoPath: item.repoPath,
      repoName: nameOf(item.repoPath),
      sn: item.sn,
      status: item.status,
      commitTitle: item.commitTitle,
      sourceRef: item.sourceRef,
      nickName: item.nickName,
      time: now,
      leftover: false,
    })
  }
}

/**
 * 离线补推：应用未运行（或未登录）期间结束的构建，重启后汇总成一条通知。
 *
 * 为什么只发一条摘要：用户关机一夜可能有几十个构建结束，逐条补推等于
 * 开机瞬间轰炸；一条"未运行期间 N 个构建已结束"既提示了事实又不打扰。
 * 这些条目的最终状态**不回查**（可能早已被构建历史的分页挤出，回查命不中
 * 只会带来无意义的请求），因此状态记为未知、面板标"离开期间"。
 */
async function emitLeftoverNotices(finished: FinishedBuild[], nameOf: (repoPath: string) => string): Promise<void> {
  if (finished.length === 0) {
    return
  }
  const title = i18n.global.t('buildWatch.notify.leftoverTitle', { count: finished.length })
  const body = i18n.global.t('buildWatch.notify.leftoverBody')
  await sendSystemNotification(title, body)
  const now = Date.now()
  for (const item of finished) {
    pushNotice({
      repoPath: item.repoPath,
      repoName: nameOf(item.repoPath),
      sn: item.sn,
      status: '',
      commitTitle: item.commitTitle,
      sourceRef: item.sourceRef,
      nickName: item.nickName,
      time: now,
      leftover: true,
    })
  }
}

/**
 * 单轮 tick：拉列表 → 逐仓库取 pending → 比对快照 → 回查终态 → 发通知。
 * 任何阶段异常都不向上抛（定时器里的未捕获异常会让整个轮询链断掉）。
 */
async function runTick(): Promise<void> {
  if (tickRunning) {
    // 上一轮还没结束（网络极慢）：跳过本轮，下一轮再来，避免请求堆叠
    return
  }
  const groupPath = ensureTrailingSlashFree(selectedGroup.value?.path ?? '')
  if (!cnbToken.value || !groupPath || buildNotifyEnabled.value !== true) {
    return
  }
  tickRunning = true
  // 记录本轮开始时间：窗口可见补跑用它对冷却做判断（见 visibilitychange 监听）
  lastTickAt = Date.now()
  try {
    let repos: CnbRepo[] = []
    let truncated = false
    let listFailed = false
    try {
      const result = await loadRepoList(groupPath)
      repos = result.repos
      truncated = result.truncated
    }
    catch (err) {
      listFailed = true
      console.warn('[build-watch] 仓库列表拉取失败，本轮跳过：', err)
    }
    buildWatchTruncated.value = truncated

    // 仓库列表拉不到时**不动快照**：拿空 next 去比对会把所有 pending 判成已结束
    if (listFailed) {
      failedRounds += 1
      return
    }
    const nameOf = makeRepoNameResolver(repos)
    const next: BuildSnapshot = {}
    const failedRepos = new Set<string>()
    /**
     * 本轮"没有发起请求"的仓库（缺 repo-cnb-history:r 已被跳过）。
     *
     * 必须与 failedRepos 同等对待（QA 缺陷 #2，假警报）：若只是把它们从
     * tasks 里 filter 掉，它们的上一轮快照就不会并回 next → diff 会认为
     * "这个仓库的 pending 全消失了" → 面板凭空冒出「构建已结束 · 状态未知」。
     * 原则：宁可在缺权限期间漏报，也绝不能误报。
     */
    const skippedRepos = new Set<string>()
    let failedCount = 0

    const tasks: (() => Promise<void>)[] = []
    for (const repo of repos) {
      const repoPath = ensureTrailingSlashFree(repo.path)
      if (scopeMissing.has(repoPath)) {
        // 缺权限仓库：不请求、但保留其上一轮快照（见 skippedRepos 注释）
        skippedRepos.add(repoPath)
        continue
      }
      tasks.push(async () => {
        try {
          const { items } = await fetchBuildLogs(repoPath, { status: 'pending', pageSize: 100 })
          const entries: Record<string, BuildEntry> = {}
          for (const item of items) {
            if (!item.sn) {
              continue
            }
            entries[item.sn] = {
              sn: item.sn,
              // 源数据状态可能为空串，统一按 pending 记录（本查询本身已按 pending 过滤）
              status: item.status || 'pending',
              commitTitle: item.commitTitle || '',
              sourceRef: item.sourceRef || '',
              nickName: item.nickName || '',
              createTime: item.createTime || '',
            }
          }
          if (Object.keys(entries).length > 0) {
            next[repoPath] = entries
          }
        }
        catch (err) {
          failedCount += 1
          failedRepos.add(repoPath)
          // 只有"确认为缺 scope"的 403 才永久跳过（isMissingScopeError）；
          // 解析不出 scope 的 403（网关风控等）按普通失败处理，下一轮重试，
          // 避免一次风控抖动把该仓库的构建通知整个会话静音（红线：绝不登出）
          if (isMissingScopeError(err)) {
            markScopeMissing(repoPath)
          }
        }
      })
    }
    await runWithLimit(tasks, BUILD_WATCH_CONCURRENCY, BUILD_WATCH_STAGGER_MS)

    // 关注数量口径（QA 缺陷 #6）：只统计"真的在轮询"的仓库 —— 缺权限被跳过
    // 的仓库不计入，否则设置页的"当前关注 N 个仓库"会把根本没在轮询的仓库
    // 也算进去（用户会以为通知漏了）。这里按 scopeMissing 集合过滤而不是用
    // skippedRepos.size：某仓库是本轮才发现 403 的，当轮它仍进过 tasks，
    // 但它已经不该算进"已关注"了。
    buildWatchRepoCount.value = repos
      .filter(repo => !scopeMissing.has(ensureTrailingSlashFree(repo.path)))
      .length

    // 失败仓库 + 被跳过仓库的上一轮快照原样并入 next：
    // 否则"请求失败/没发请求 → 构建看似消失 → 误报已结束"
    const prevSnapshot = buildSnapshot.value ?? {}
    for (const repoPath of [...failedRepos, ...skippedRepos]) {
      const prevRepo = prevSnapshot[repoPath]
      if (prevRepo) {
        next[repoPath] = { ...prevRepo, ...(next[repoPath] ?? {}) }
      }
    }

    if (!baselineReady) {
      // —— 首次基线 ——
      // 只建快照、不发通知：否则启动瞬间会把所有历史 pending 当成"刚结束"。
      // 例外：持久化快照里已有 pending 且它们已不在本轮 pending 中，
      // 说明是"应用未运行期间结束的构建" → 补推一条摘要（只做一次）。
      const persistedGroup = buildSnapshotGroup.value
      const persisted = prevSnapshot
      const persistedUsable = Object.keys(persisted).length > 0
        && (persistedGroup === '' || persistedGroup === groupPath)
      if (persistedUsable) {
        const { finished } = diffBuildSnapshot(persisted, next)
        await emitLeftoverNotices(finished, nameOf)
      }
      buildSnapshot.value = next
      buildSnapshotGroup.value = groupPath
      baselineReady = true
    }
    else {
      const { finished } = diffBuildSnapshot(prevSnapshot, next)
      if (finished.length > 0) {
        const resolved = await resolveFinishedStatuses(finished)
        await emitResolvedNotices(resolved, nameOf)
      }
      buildSnapshot.value = next
      buildSnapshotGroup.value = groupPath
    }

    failedRounds = failedCount > 0 ? failedRounds + 1 : 0
  }
  catch (err) {
    failedRounds += 1
    console.warn('[build-watch] 轮询异常：', err)
  }
  finally {
    tickRunning = false
  }
}

/** 清掉当前定时器（幂等） */
function clearTickTimer(): void {
  if (tickTimer !== null) {
    clearTimeout(tickTimer)
    tickTimer = null
  }
}

/**
 * 安排下一轮 tick。
 *
 * 为什么用 setTimeout 递归而不是 setInterval：间隔是**动态**的
 * （失败退避会翻倍、用户改设置会变），setInterval 的周期在创建时固定，
 * 每轮都得 clear + 重建。递归 setTimeout 天然做到"跑完上一轮再排下一轮"，
 * 顺带解决 setInterval 在慢网络下 tick 堆叠的问题。
 */
function scheduleNextTick(delayMs?: number): void {
  clearTickTimer()
  if (!isActive()) {
    return
  }
  const delay = delayMs ?? currentIntervalMs()
  tickTimer = setTimeout(() => {
    void (async () => {
      try {
        await runTick()
      }
      finally {
        // 无论本轮成功失败都继续排下一轮：轮询链不能断
        scheduleNextTick()
      }
    })()
  }, delay)
}

/**
 * 重建轮询计划（登录态 / 组织 / 开关 / 间隔任一变化时调用）。
 * 组织变化会丢弃旧快照（不同组织的仓库完全无关），并清空缺权限记录。
 */
function restartWatcher(): void {
  clearTickTimer()
  const groupPath = ensureTrailingSlashFree(selectedGroup.value?.path ?? '')
  const previousGroupPath = activeGroupPath

  if (groupPath !== previousGroupPath) {
    // 组织变化：旧快照属于另一个组织的仓库，留着会把它的 pending 误判成"已结束"。
    // 但**首次确定组织**（previousGroupPath 为空，即启动早期 selectedGroup 尚未
    // 就绪）必须保留持久化快照 —— 否则"离线补推"永远失效（快照在启动瞬间被清掉）。
    if (previousGroupPath) {
      resetSnapshot(groupPath)
    }
    activeGroupPath = groupPath
    scopeMissing.clear()
    scopeMissingPaths.value = []
    repoCache = null
    baselineReady = false
  }

  // 开关关闭 / 未登录：清空定时器并丢弃快照
  // （关闭期间的构建不该在重新开启时被补推成"未运行期间结束"，那会误导用户）
  if (!isActive()) {
    baselineReady = false
    // 只在"确定不该跑"的原因上清快照；仅仅"组织还没就绪"时保留快照等离线补推
    if (!cnbToken.value || buildNotifyEnabled.value !== true) {
      resetSnapshot('')
    }
    if (!cnbToken.value) {
      // 退出登录：清掉上一个账号的通知与组织归属，避免串号
      activeGroupPath = ''
      clearBuildNotices()
      buildNotifyPermissionDenied.value = false
    }
    return
  }

  failedRounds = 0
  scheduleNextTick(FIRST_TICK_DELAY_MS)
}

/**
 * 初始化构建通知轮询（main.ts 在 restoreSession() 之后调用一次）。
 *
 * 幂等：重复调用不会注册多份 watch / 定时器（HMR 或未来多次调用都安全）。
 * 不阻塞首屏：内部只注册监听并延迟首次 tick，所有网络请求都在定时器里异步发生。
 */
export function initBuildWatcher(): void {
  if (watcherReady) {
    return
  }
  watcherReady = true

  // 四个输入共同决定轮询是否运行 / 间隔多少：
  // 令牌（登录态）、选中组织（关注范围）、开关、间隔
  watch(
    () => [
      cnbToken.value,
      selectedGroup.value?.path ?? '',
      buildNotifyEnabled.value,
      normalizeIntervalSec(buildNotifyIntervalSec.value),
    ] as const,
    () => restartWatcher(),
    { immediate: true },
  )

  // 窗口重新可见（含从系统休眠唤醒、从托盘唤回）后尽早补一轮：
  // 隐藏/休眠期间定时器不推进，唤醒后马上检查，比等下一个完整间隔
  // （最长 2 分钟 + 退避）体验好得多。
  // 加 10s 冷却：用户频繁切窗口时不该反复触发（否则等于把轮询间隔降到了 10s）
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || !isActive()) {
        return
      }
      if (Date.now() - lastTickAt < VISIBILITY_RETICK_COOLDOWN_MS) {
        return
      }
      scheduleNextTick(0)
    })
  }
}
