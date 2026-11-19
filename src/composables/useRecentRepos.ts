/**
 * 最近访问的仓库记录（托盘快捷面板「最近的项目」数据源）。
 *
 * # 为什么需要单独记录
 *
 * CNB Open API 没有"最近打开"这类个人化查询端点，用户真正关心的
 * "我最近在弄哪个仓库"只能由客户端自己记。这里用 localStorage 落盘
 * （体积小、无需走 SQLite；与账号无关的纯本机行为数据，登出不清除）。
 *
 * # 数据形态与去重
 *
 * 同一仓库重复访问只更新时间并置顶，不产生重复条目（按 repoPath 去重）；
 * 上限 MAX_RECENT_REPOS 条，超出裁掉最旧的。time 存 ISO 8601 字符串，
 * 面板直接用 formatRelativeTime 渲染"4 小时前"。
 *
 * # 跨窗口同步
 *
 * 托盘面板是独立 WebView，各自有 JS 上下文；localStorage 虽同源共享，
 * 但 storage 事件在 Tauri 多 WebView 间不保证传递。因此面板每次获得
 * 焦点（弹出时）主动 loadRecentRepos() 重新读盘即可拿到最新列表 ——
 * 无需事件通道。
 */
import { ref } from 'vue'

/** 一条最近访问记录 */
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
}

/** localStorage 键名（与 useCnbAuth 的其它键同前缀风格） */
const STORAGE_KEY = 'wocnb.recentRepos'

/** 最多保留条数（面板只展示前若干条，留余量供主窗口将来复用） */
const MAX_RECENT_REPOS = 20

/** 响应式列表（面板/将来主窗口首页都可消费） */
export const recentRepos = ref<RecentRepoEntry[]>([])

/** 取路径最后一段作为展示名（与仓库列表页的兜底规则一致） */
function nameFromPath(repoPath: string): string {
  const parts = repoPath.split('/').filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1]! : repoPath
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
      }))
      .sort((a, b) => Date.parse(b.time) - Date.parse(a.time))
      .slice(0, MAX_RECENT_REPOS)
  }
  catch {
    // 坏 JSON / 隐私模式写入受限：一律按空列表处理（面板展示空态即可）
    return []
  }
}

/** 重新读盘并刷新响应式列表（面板窗口获得焦点时调用） */
export function loadRecentRepos(): void {
  recentRepos.value = readRecentRepos()
}

/**
 * 记录一次仓库访问（仓库详情页加载成功后调用）。
 *
 * @param entry 至少要有 repoPath；name/language/languageColor 有则更好
 */
export function recordRecentRepo(entry: {
  repoPath: string
  name?: string
  language?: string
  languageColor?: string
}): void {
  const repoPath = entry.repoPath?.trim()
  if (!repoPath || typeof localStorage === 'undefined') {
    return
  }
  // 先去重同仓库旧记录，再插到头部（最近访问置顶语义）
  const rest = readRecentRepos().filter(item => item.repoPath !== repoPath)
  const next: RecentRepoEntry[] = [
    {
      repoPath,
      name: entry.name?.trim() || nameFromPath(repoPath),
      time: new Date().toISOString(),
      language: entry.language,
      languageColor: entry.languageColor,
    },
    ...rest,
  ].slice(0, MAX_RECENT_REPOS)

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
  catch {
    // 写盘失败（配额/隐私模式）不影响页面本身，静默降级
    return
  }
  // 同窗口内的响应式列表同步更新（跨窗口由对方 load 兜底）
  recentRepos.value = next
}

/** 清空记录（单测复位 / 将来"清除历史"入口） */
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
