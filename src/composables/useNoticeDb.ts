/**
 * 通知 SQLite 持久化的前端通道（invoke 封装层）。
 *
 * # 职责边界
 *
 * 只做「前端数据结构 ↔ Rust 命令」的转接，不持有任何响应式状态 ——
 * feed/未读计数的读写属于 useCnbBuildWatch / useAppNotices，
 * 跨模块协调（登录态变化时回灌/清理）属于 useNoticeRestore。
 * 这样依赖保持单向（通知模块 → 本模块 → useCnbAuth），无环。
 *
 * # 用户数据隔离
 *
 * 所有命令都必须携带 username（当前登录账号 cnbUser.username），
 * Rust 侧按 username 过滤读写（见 notice_db.rs）。username 为空
 * （未登录）时本模块所有写入直接跳过 —— 未登录态的通知只存内存，
 * 不落库、跨账号不可见。
 *
 * # 容错策略
 *
 * 持久化是「尽力而为」：落库/已读标记失败只 warn 不抛 —— 通知面板
 * 照常工作（内存 feed 是主数据源），数据库失败不应打断构建监控轮询。
 * # 依赖方向
 *
 * 本模块**不直接 import** useCnbAuth（cnbUser）：useCnbBuildWatch /
 * useAppNotices → 本模块这条导入链会穿透大量对 useCnbAuth 做 vi.mock
 * 的单测文件（mock 缺 cnbUser 导出会直接炸）。username 改为启动期
 * 注入（setNoticeUsernameProvider，由 useNoticeRestore 在 main.ts
 * 初始化时注入）—— 测试环境未注入则恒为 null，持久化自动跳过。
 */
import { invoke } from '@tauri-apps/api/core'

// ---------------------------------------------------------------------------
// 环境与身份
// ---------------------------------------------------------------------------

/** 是否运行在 Tauri 桌面环境（浏览器 dev 下无 SQLite，全部操作直接跳过） */
function isTauriEnv(): boolean {
  // 先判 window 存在性：vitest node 环境没有 window，直接 in 会抛
  // ReferenceError（pushNotice 在测试里被直接调用，守卫必须自身无异常）
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/**
 * 当前用户名提供器（启动期注入，见模块头注释"依赖方向"）。
 * 未注入（测试 / 浏览器 dev）时恒返回 null → 所有持久化操作自动跳过。
 */
let usernameProvider: () => string | null = () => null

/**
 * 注入当前用户名提供器（main.ts 启动链路里由 useNoticeRestore 调用一次）。
 * @param provider 返回当前登录用户名；未登录返回 null
 */
export function setNoticeUsernameProvider(provider: () => string | null): void {
  usernameProvider = provider
}

/**
 * 当前登录用户名（数据隔离键）。
 * 未登录 / 未注入提供器时返回 null，调用方据此跳过持久化。
 */
export function currentNoticeUsername(): string | null {
  return usernameProvider()
}

// ---------------------------------------------------------------------------
// 类型定义（与 Rust notice_db.rs 的 StoredBuildNotice / StoredAppNotice
// serde camelCase 输出一一对应；改任一侧必须同步另一侧）
// ---------------------------------------------------------------------------

/** 从数据库恢复出的构建通知条目（比前端 BuildNotice 多 read 标记） */
export interface StoredBuildNotice {
  noticeId: string
  repoPath: string
  repoName: string
  sn: string
  status: string
  commitTitle: string
  sourceRef: string
  nickName: string
  /** 毫秒时间戳 */
  time: number
  leftover: boolean
  /** 已读标记（打开通知面板即置 true） */
  read: boolean
}

/** 从数据库恢复出的应用通知条目（比前端 AppNotice 多 read 标记） */
export interface StoredAppNotice {
  noticeId: string
  kind: string
  title: string
  body: string
  version: string
  /** 毫秒时间戳 */
  time: number
  read: boolean

}

/** 一次加载取回的两个分区（前端回灌只需一次 IPC） */
export interface NoticeLoadResult {
  buildNotices: StoredBuildNotice[]
  appNotices: StoredAppNotice[]
}

// ---------------------------------------------------------------------------
// 命令封装
// ---------------------------------------------------------------------------

/**
 * 加载当前账号的全部历史通知（构建 + 应用，最新在前）。
 * 会话恢复 / 登录成功后由 useNoticeRestore 调用一次。
 */
export async function loadNoticesFromDb(): Promise<NoticeLoadResult | null> {
  const username = currentNoticeUsername()
  if (!isTauriEnv() || !username) {
    return null
  }
  return await invoke<NoticeLoadResult>('notice_db_load', { username })
}

/**
 * 落库一条构建通知（fire-and-forget：失败只 warn，不打断通知主流程）。
 * @param notice 除 id 外的完整条目 + 生成的 id（noticeId）
 */
export function persistBuildNoticeToDb(notice: StoredBuildNotice): void {
  const username = currentNoticeUsername()
  if (!isTauriEnv() || !username) {
    return
  }
  invoke('notice_db_insert_build', { username, ...notice }).catch((err) => {
    console.warn('[wocnb] 构建通知落库失败（不影响面板展示）：', err)
  })
}

/**
 * 落库一条应用通知（fire-and-forget，同上容错策略）。
 */
export function persistAppNoticeToDb(notice: StoredAppNotice): void {
  const username = currentNoticeUsername()
  if (!isTauriEnv() || !username) {
    return
  }
  invoke('notice_db_insert_app', { username, ...notice }).catch((err) => {
    console.warn('[wocnb] 应用通知落库失败（不影响面板展示）：', err)
  })
}

/**
 * 把当前账号全部通知标记为已读（打开通知面板时调用，幂等）。
 * fire-and-forget：失败只 warn，未读徽标清零以内存为准。
 */
export function markNoticesReadInDb(): void {
  const username = currentNoticeUsername()
  if (!isTauriEnv() || !username) {
    return
  }
  invoke('notice_db_mark_all_read', { username }).catch((err) => {
    console.warn('[wocnb] 通知已读标记落库失败：', err)
  })
}

/**
 * 清空当前账号的全部持久化通知（登出勾选「清空本地数据」时调用）。
 *
 * 注意：必须在 logout() 清空 cnbUser **之前**调用（依赖 username）。
 * 与其他操作不同，失败会向上抛 —— 调用方需要把失败反馈给用户
 * （用户以为数据已清空，实际还在，是必须告知的差异）。
 */
export async function clearNoticesInDb(): Promise<void> {
  const username = currentNoticeUsername()
  if (!isTauriEnv() || !username) {
    return
  }
  await invoke('notice_db_clear', { username })
}
