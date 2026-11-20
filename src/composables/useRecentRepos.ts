/**
 * 最近访问的仓库记录（托盘快捷面板「最近打开」数据源）。
 *
 * # 为什么需要单独记录
 *
 * CNB Open API 没有"最近打开"这类个人化查询端点，用户真正关心的
 * "我最近在弄哪个仓库"只能由客户端自己记。
 *
 * # 存储位置：SQLite（主）/ localStorage（降级）
 *
 * Tauri 桌面环境下数据落 SQLite（notice_db.rs 的 recent_repos 表，
 * 按登录账号隔离）—— 此前存 localStorage，应用更新后 WebView 分区
 * 数据可能被清导致列表丢失；SQLite 在 app_data_dir 下不受 WebView
 * 更新影响，且登出勾选「清空本地数据」时可一并物理清除。
 * 非 Tauri 环境（浏览器 dev / vitest）降级回 localStorage 路径。
 *
 * # 账号语义（与通知持久化一致）
 *
 * 写入/读取都由 Rust 侧从托盘登录态槽位取当前账号（set_tray_auth
 * 同步 + tray-auth.txt 启动兜底），未登录不落库、面板展示空态。
 * 登出默认保留数据；勾选「清空本地数据」时由 notice_db_clear 一并
 * 物理删除该账号的 recent_repos 行。
 *
 * # 旧数据迁移
 *
 * 升级前版本的数据在 localStorage（无账号归属）。主窗口会话恢复后
 * 调用 migrateFromLocalStorage()：把旧记录逐条 upsert 进 SQLite
 * （保留原始打开时间），成功后删除 localStorage 键，只迁移一次。
 *
 * # 数据形态与去重
 *
 * 同一仓库重复访问只更新时间并置顶，不产生重复条目（按 repoPath
 * 去重，SQLite 侧 UNIQUE(username, repo_path) 约束兜底）；上限
 * MAX_RECENT_REPOS 条，超出裁掉最旧的（Rust 侧 SQL 裁剪）。time 用
 * ISO 8601 字符串（前端渲染口径），DB 存毫秒时间戳，两者边界转换。
 *
 * # 跨窗口同步
 *
 * 托盘面板是独立 WebView；SQLite 由 Rust 进程持有（天然跨窗口共享）。
 * 面板每次弹出（cnb://tray-panel-shown / focus）调 loadRecentRepos()
 * 重新查询即可拿到主窗口最新记录。
 */
import { ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'

/** 合法的仓库可见性（小写口径；RepoDetail.visibility 是首字母大写，记录时归一） */
export type RecentRepoVisibility = 'public' | 'private' | 'secret'

/** 一条最近访问记录（前端展示形态） */
export interface RecentRepoEntry {
  /** 仓库完整路径（如 cnb/feedback） */
  repoPath: string
  /** 仓库展示名（缺省取路径最后一段） */
  name: string
  /** 最近访问时间（ISO 8601，供 formatRelativeTime 渲染） */
  time: string
  /** 主语言（可选，用于左侧色块底色） */
  language?: string
  /** 语言主题色（#RRGGBB，可选） */
  languageColor?: string
  /** 仓库可见性（可选；旧记录/未知为空 → 面板不渲染徽标，绝不误标） */
  visibility?: RecentRepoVisibility
}

/**
 * 归一化任意输入为合法可见性（脏值/空值/旧数据一律 undefined → 不渲染徽标）。
 * RepoDetail.visibility 首字母大写（Public/Private/Secret），统一转小写；
 * 其余取值（未来 API 扩展/手改数据）保守丢弃，不猜默认值。
 */
export function normalizeRecentRepoVisibility(value: unknown): RecentRepoVisibility | undefined {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return v === 'public' || v === 'private' || v === 'secret' ? v : undefined
}

/** SQLite 行形态（与 Rust StoredRecentRepo 的 serde camelCase 输出对应） */
interface StoredRecentRepoRow {
  repoPath: string
  repoName: string
  language: string
  languageColor: string
  visibility: string
  /** 毫秒时间戳 */
  openedAt: number
}

/** localStorage 键名（非 Tauri 降级路径 + 旧版本数据迁移来源） */
const STORAGE_KEY = 'wocnb.recentRepos'

/** 最多保留条数（面板只展示前若干条；与 Rust RECENT_KEEP_PER_USER 一致） */
const MAX_RECENT_REPOS = 20

/** 响应式列表（面板/将来主窗口首页都可消费） */
export const recentRepos = ref<RecentRepoEntry[]>([])

/** 是否运行在 Tauri 桌面环境（浏览器 dev / vitest 无 invoke，走降级路径） */
function isTauriEnv(): boolean {
  // 先判 window 存在性：vitest node 环境没有 window，直接 in 会抛
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** 取路径最后一段作为展示名（与仓库列表页的兜底规则一致） */
function nameFromPath(repoPath: string): string {
  const parts = repoPath.split('/').filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1]! : repoPath
}

/** 毫秒时间戳 → ISO 8601（非法值返回当前时间，防御脏数据） */
function msToIso(ms: number): string {
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString()
}

/** 宽松校验单条记录（localStorage 可能被手改/旧版本结构污染） */
function isValidEntry(value: unknown): value is RecentRepoEntry {
  if (!value || typeof value !== 'object') {
    return false
  }
  const v = value as Record<string, unknown>
  return typeof v.repoPath === 'string' && v.repoPath.length > 0
    && typeof v.time === 'string' && v.time.length > 0
}

// ---------------------------------------------------------------------------
// localStorage 路径（非 Tauri 降级 + 迁移来源；纯同步，测试友好）
// ---------------------------------------------------------------------------

/**
 * 从 localStorage 读取并归一（过滤脏数据、补 name、按时间倒序、裁剪）。
 * 注意：坏 JSON 直接当作空列表，不让面板因一条脏数据整体白屏。
 */
export function readRecentRepos(): RecentRepoEntry[] {
  if (typeof localStorage === 'undefined') {
    return []
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return []
    }
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed
      .filter(isValidEntry)
      .map(entry => ({
        repoPath: entry.repoPath,
        name: typeof entry.name === 'string' && entry.name ? entry.name : nameFromPath(entry.repoPath),
        time: entry.time,
        language: typeof entry.language === 'string' ? entry.language : undefined,
        languageColor: typeof entry.languageColor === 'string' ? entry.languageColor : undefined,
        visibility: normalizeRecentRepoVisibility(entry.visibility),
      }))
      .sort((a, b) => Date.parse(b.time) - Date.parse(a.time))
      .slice(0, MAX_RECENT_REPOS)
  }
  catch {
    // 坏 JSON / 隐私模式写入受限：一律按空列表处理（面板展示空态即可）
    return []
  }
}

/** 把 localStorage 内容灌进响应式列表（非 Tauri 环境的 load 实现） */
function loadFromLocalStorage(): void {
  recentRepos.value = readRecentRepos()
}

// ---------------------------------------------------------------------------
// 统一入口（Tauri → SQLite；否则 → localStorage）
// ---------------------------------------------------------------------------

/**
 * 刷新「最近打开」列表（面板每次弹出 / 主窗口需要时调用）。
 *
 * Tauri 环境走 SQLite 查询（用户名由 Rust 槽位决定，未登录返回空）；
 * 非 Tauri 环境同步读 localStorage。查询失败保留现有列表不清空
 * （失败只 warn —— 数据在库，下次弹出自然恢复）。
 */
export function loadRecentRepos(): void {
  if (!isTauriEnv()) {
    loadFromLocalStorage()
    return
  }
  invoke<StoredRecentRepoRow[]>('recent_repos_load')
    .then((rows) => {
      recentRepos.value = rows
        .map(row => ({
          repoPath: row.repoPath,
          name: row.repoName || nameFromPath(row.repoPath),
          time: msToIso(row.openedAt),
          language: row.language || undefined,
          languageColor: row.languageColor || undefined,
          // Rust 侧已统一小写落库；再过一次归一防脏值渲染徽标
          visibility: normalizeRecentRepoVisibility(row.visibility),
        }))
        .sort((a, b) => Date.parse(b.time) - Date.parse(a.time))
        .slice(0, MAX_RECENT_REPOS)
    })
    .catch((err) => {
      console.warn('[wocnb] 读取最近打开记录失败（保留现有列表）：', err)
    })
}

/**
 * 记录一次仓库访问（仓库详情页加载成功后调用）。
 *
 * 响应式列表同步做置顶去重（本窗口立即见效）；持久化按环境分流：
 * Tauri → SQLite upsert（fire-and-forget，失败只 warn，不打断页面）；
 * 非 Tauri → localStorage 写盘。
 *
 * @param entry 至少要有 repoPath；name/language/languageColor/visibility
 *              有则更好（visibility 传入 RepoDetail.visibility 原值即可，
 *              内部归一为小写三值）
 */
export function recordRecentRepo(entry: {
  repoPath: string
  name?: string
  language?: string
  languageColor?: string
  visibility?: string
}): void {
  const repoPath = entry.repoPath?.trim()
  if (!repoPath) {
    return
  }
  // 可见性立即归一（大小写混用/脏值不落盘），渲染侧无需再判
  const visibility = normalizeRecentRepoVisibility(entry.visibility)
  // 先去重同仓库旧记录，再插到头部（最近访问置顶语义）
  const rest = recentRepos.value.filter(item => item.repoPath !== repoPath)
  const next: RecentRepoEntry[] = [
    {
      repoPath,
      name: entry.name?.trim() || nameFromPath(repoPath),
      time: new Date().toISOString(),
      language: entry.language,
      languageColor: entry.languageColor,
      visibility,
    },
    ...rest,
  ].slice(0, MAX_RECENT_REPOS)
  // 同窗口内的响应式列表同步更新（跨窗口由对方 load 兜底）
  recentRepos.value = next

  if (isTauriEnv()) {
    invoke('recent_repos_upsert', {
      repoPath,
      repoName: next[0]?.name ?? '',
      language: entry.language?.trim() ?? '',
      languageColor: entry.languageColor?.trim() ?? '',
      // 归一后的值（undefined → 空串；Rust 侧再统一小写兜底）
      visibility: visibility ?? '',
    }).catch((err) => {
      console.warn('[wocnb] 最近打开记录落库失败（不影响页面）：', err)
    })
    return
  }
  // 非 Tauri 降级：localStorage 写盘（失败静默，不影响页面）
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
  catch {
    // 写盘失败（配额/隐私模式）不影响页面本身
  }
}

/**
 * 旧版本 localStorage 数据一次性迁移进 SQLite。
 *
 * main.ts 会话恢复后调用（此时 Rust 槽位已有当前用户名）。逐条 upsert
 * 并保留原始打开时间；全部成功后删除 localStorage 键（任何一条失败都
 * 不删键，下次启动重试）。非 Tauri 环境直接跳过。
 */
export function migrateRecentReposToDb(): Promise<void> {
  if (!isTauriEnv()) {
    return Promise.resolve()
  }
  const legacy = readRecentRepos()
  if (legacy.length === 0) {
    return Promise.resolve()
  }
  const upserts = legacy.map(entry =>
    invoke('recent_repos_upsert', {
      repoPath: entry.repoPath,
      repoName: entry.name,
      language: entry.language ?? '',
      languageColor: entry.languageColor ?? '',
      // 旧记录可能没有可见性（undefined → 空串，面板不渲染徽标）
      visibility: entry.visibility ?? '',
      // 保留原始打开时间（毫秒），迁移不丢时间线。
      // 参数名对应 Rust 命令的 opened_at（Tauri 自动 camelCase↔snake_case）
      openedAt: Date.parse(entry.time),
    }).catch((err) => {
      console.warn('[wocnb] 迁移最近打开记录失败（保留 localStorage 待重试）：', entry.repoPath, err)
      throw err
    }),
  )
  return Promise.all(upserts)
    .then(() => {
      try {
        localStorage.removeItem(STORAGE_KEY)
      }
      catch {
        // 删键失败无害：SQLite 已有数据，重复迁移是幂等 upsert
      }
      console.info(`[wocnb] 已迁移 ${legacy.length} 条最近打开记录到 SQLite`)
    })
    .catch(() => {
      // 有条目失败：不删键，下次启动重试（upsert 幂等，重复迁移无害）
    })
}

/** 清空记录（登出勾选「清空本地数据」时清内存 + localStorage 残留；
 *  SQLite 侧由 notice_db_clear 一并物理删除，不走本函数） */
export function clearRecentRepos(): void {
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(STORAGE_KEY)
    }
    catch {
      // 忽略：删除失败不阻断调用方
    }
  }
  recentRepos.value = []
}
