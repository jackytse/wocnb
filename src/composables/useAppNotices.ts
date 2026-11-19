/**
 * 应用通知记录（通知面板「应用通知」分区消费）。
 *
 * # 为什么独立于构建通知（useCnbBuildWatch.buildNoticeFeed）
 *
 * 构建通知的条目结构是仓库/构建语义强绑定（repoPath/sn/status/leftover），
 * 面板渲染、点击直达都依赖这些字段；而"应用级"通知（更新检测等）没有
 * 仓库上下文，硬塞进 BuildNotice 会让两类条目互相背对方的可选字段。
 * 独立数据源 + 面板独立分区，各自演进互不牵连。
 *
 * # 持久化策略（SQLite，useNoticeDb）
 *
 * 与构建通知同口径落库：push 时异步写入 SQLite（按当前登录账号隔离），
 * 失败只 warn 不影响内存展示；登录态恢复/换账号时由 useNoticeRestore
 * 调 applyRestoredAppNotices 回灌历史。落库后即使应用重启，通知面板
 * 也能展示历史更新提醒；"已通知版本"的 localStorage 去重仍由
 * useAppUpdate 负责，重启不会因持久化而重复打扰。
 *
 * # 通知产生方与消费方
 *
 * - 产生方：useAppUpdate 在发现新版本时 pushAppNotice（未来其他应用级
 *   事件可扩展 kind 枚举接入）；
 * - 消费方：NotificationsSlideover 渲染「应用通知」分区 + 打开面板时
 *   markAppNoticesRead 清未读；侧边栏底部铃铛（NotificationsButton）
 *   徽标累加 unreadAppNoticeCount。
 */
import { ref } from 'vue'

import {
  markNoticesReadInDb,
  persistAppNoticeToDb,
  type StoredAppNotice,
} from './useNoticeDb'

/** 应用通知类型（当前仅更新检测；新事件类型在此扩展枚举） */
export type AppNoticeKind = 'update'

/** 应用通知条目（通知面板「应用通知」分区展示用） */
export interface AppNotice {
  /** 唯一 id（时间戳 + 序号，同一毫秒内多次 push 也不重复） */
  id: string
  /** 通知类型 */
  kind: AppNoticeKind
  /** 通知标题（发送时已本地化，面板直接展示） */
  title: string
  /** 通知正文（同上，展示用冗余存储，避免面板再依赖 i18n 参数重算） */
  body: string
  /** 相关版本号（kind=update 时为发现的最新版本；其他 kind 留空串） */
  version: string
  /** 通知时间（毫秒时间戳，面板用相对时间展示） */
  time: number
}

/** 面板最多保留的应用通知条数（超出丢弃最旧的，防止内存无界增长） */
const MAX_APP_NOTICE_SIZE = 20

/** 应用通知列表（最新在前，最多 20 条） */
export const appNoticeFeed = ref<AppNotice[]>([])

/** 未读应用通知数（铃铛徽标累加项；打开面板即清零） */
export const unreadAppNoticeCount = ref(0)

/** 通知 id 序列号（同一毫秒内多次 push 时保证 id 唯一；模块私有计数器） */
let noticeSeq = 0

/**
 * 追加一条应用通知到列表头部（自动裁剪到 20 条并累加未读数）。
 *
 * 同时异步落库 SQLite（按当前账号隔离；未登录时 useNoticeDb 内部
 * 自动跳过）。落库失败不影响内存展示。
 *
 * @param notice 除 id 外的完整条目（id 由本函数生成，调用方不感知）
 */
export function pushAppNotice(notice: Omit<AppNotice, 'id'>): void {
  noticeSeq += 1
  const item: AppNotice = { ...notice, id: `${notice.time}-${noticeSeq}` }
  appNoticeFeed.value = [item, ...appNoticeFeed.value].slice(0, MAX_APP_NOTICE_SIZE)
  unreadAppNoticeCount.value += 1
  persistAppNoticeToDb({
    noticeId: item.id,
    kind: item.kind,
    title: item.title,
    body: item.body,
    version: item.version,
    time: item.time,
    read: false,
  })
}

/** 标记应用通知为已读（面板打开时调用：徽标清零，列表保留；落库幂等） */
export function markAppNoticesRead(): void {
  unreadAppNoticeCount.value = 0
  // 已读状态落库（与构建通知共用一条 mark_all_read 命令，幂等可重入）
  markNoticesReadInDb()
}

/**
 * 清空应用通知列表与未读数（退出登录/切换账号时调用，仅清内存 ——
 * 数据库默认保留，登出勾选「清空数据」才走 notice_db_clear）。
 */
export function clearAppNotices(): void {
  appNoticeFeed.value = []
  unreadAppNoticeCount.value = 0
}

/**
 * 回灌数据库恢复出的应用通知（登录态恢复/换账号时由 useNoticeRestore 调用）。
 *
 * 与内存 feed 按 id 去重合并（防御回灌期间恰有新通知 push 的竞态），
 * 按时间倒序裁剪到 20 条；未读徽标累加回灌条目中的未读数。
 */
export function applyRestoredAppNotices(rows: StoredAppNotice[]): void {
  if (rows.length === 0) {
    return
  }
  const existingIds = new Set(appNoticeFeed.value.map(n => n.id))
  // 未读统计必须在映射前做（映射成 AppNotice 后 read 字段已丢弃，
  // 事后过滤会把所有条目都当成未读，重复计入徽标）
  const restoredUnread = rows.filter(r => !existingIds.has(r.noticeId) && !r.read).length
  const restored: AppNotice[] = rows
    .filter(r => !existingIds.has(r.noticeId))
    .map(r => ({
      id: r.noticeId,
      // kind 来自本应用自己写入的库；当前枚举仅 'update' 一种，
      // 脏数据也归一为 'update'（面板渲染分支不会出现未知类型）
      kind: 'update' as AppNoticeKind,
      title: r.title,
      body: r.body,
      version: r.version,
      time: r.time,
    }))
  const merged = [...restored, ...appNoticeFeed.value]
    .sort((a, b) => b.time - a.time)
    .slice(0, MAX_APP_NOTICE_SIZE)
  appNoticeFeed.value = merged
  unreadAppNoticeCount.value += restoredUnread
}

/**
 * 供单测重置模块级状态（生产代码不应调用）。
 * 为什么需要：feed/未读数/id 序列号都是模块私有状态，测试之间必须
 * 显式复位才能互不干扰。
 */
export function resetAppNoticesForTest(): void {
  appNoticeFeed.value = []
  unreadAppNoticeCount.value = 0
  noticeSeq = 0
}
