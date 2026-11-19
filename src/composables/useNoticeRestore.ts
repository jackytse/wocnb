/**
 * 通知持久化与登录态的协调层（useNoticeDb + 两个通知模块之间的粘合）。
 *
 * # 职责
 *
 * 监听当前登录用户（cnbUser.username）变化，驱动通知 feed 的
 * 「回灌 / 清空」：
 * - 登录（或会话恢复，username 从无到有）：清空内存 feed（防上一个
 *   账号残留）→ 从 SQLite 按该账号回灌历史通知与未读数；
 * - 登出（username 置空）：只清**内存** feed，数据库保留 —— 这是
 *   「登出默认不清空数据」策略的落地（物理删除仅在用户登出勾选
 *   「清空本地数据」时走 useNoticeDb.clearNoticesInDb，见登出弹窗）。
 *
 * # 为什么不放在 useCnbAuth.logout
 *
 * 登出路径有四条（UserMenu / 设置页 token 页 / OAuth 刷新失败 / 401
 * 拦截），在 logout 里硬编码清理会让"是否清数据"的弹窗决策无处安放；
 * 以 username 为唯一驱动源 watch，则所有路径自然收敛 —— 任何方式
 * 改变了登录用户，feed 都会正确切换或清空，无需各调用点逐一接线。
 *
 * # 依赖方向
 *
 * useNoticeRestore → useCnbAuth / useCnbBuildWatch / useAppNotices /
 * useNoticeDb，全部单向无环（useCnbBuildWatch / useAppNotices 只依赖
 * useNoticeDb 做落库，不反向依赖本模块）。
 */
import { watch } from 'vue'

import { applyRestoredAppNotices, clearAppNotices } from './useAppNotices'
import { applyRestoredBuildNotices, clearBuildNotices } from './useCnbBuildWatch'
import { cnbUser } from './useCnbAuth'
import { loadNoticesFromDb, setNoticeUsernameProvider } from './useNoticeDb'

/** 上一次同步时使用的用户名（防止 watch 对同一账号重复回灌） */
let lastSyncedUsername: string | null = null

/**
 * 按 username 同步通知 feed。
 *
 * @param username 当前登录用户名；null 表示未登录（只清内存）
 */
async function syncNoticeFeed(username: string | null): Promise<void> {
  // 无论登录还是登出，先清内存 feed：换账号场景下，旧账号的通知
  // 绝不能残留展示给新账号（数据隔离的最后一道防线）
  clearBuildNotices()
  clearAppNotices()

  if (!username) {
    return
  }

  // 从本地 SQLite 回灌该账号的历史通知（构建 + 应用一次取回）。
  // 未登录期间产生的内存通知在上方已被清掉，不会被错误归属到新账号。
  try {
    const result = await loadNoticesFromDb()
    if (result) {
      // 应用层再做一次 id 去重合并（applyRestored* 内部实现），
      // 防御"清空 feed 之后、回灌完成之前恰好有新通知 push"的竞态
      applyRestoredBuildNotices(result.buildNotices)
      applyRestoredAppNotices(result.appNotices)
    }
  }
  catch (err) {
    // 回灌失败不阻断登录流程：通知面板照常工作（本轮新通知仍会
    // 实时入列），只是历史不可见，console 记录便于排查
    console.warn('[wocnb] 从数据库回灌历史通知失败（不影响登录）：', err)
  }
}

/**
 * 初始化通知持久化与登录态的联动（main.ts 启动时调用一次）。
 *
 * - 浏览器 dev（无 Tauri 运行时）直接跳过，无 SQLite 也就无需联动；
 * - immediate: true 覆盖"启动时本地已有登录态"的场景（cnbUser 是
 *   useStorage 持久化的，启动瞬间就能拿到 username，不必等
 *   restoreSession 的网络校验完成即可回灌历史通知）。
 */
export function initNoticeDbSync(): void {
  // 先判 window 存在性：vitest node 环境没有 window（与 useNoticeDb 同范式）
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    return
  }
  // 注入用户名提供器：useNoticeDb 不直接 import useCnbAuth（避免穿透
  // 单测 mock），所有落库/回灌/清空都经此拿当前账号
  setNoticeUsernameProvider(() => cnbUser.value?.username || null)
  watch(
    () => cnbUser.value?.username || null,
    (username) => {
      if (username === lastSyncedUsername) {
        return
      }
      lastSyncedUsername = username
      void syncNoticeFeed(username)
    },
    { immediate: true },
  )
}

/**
 * 供单测重置模块私有状态（生产代码不应调用）。
 */
export function resetNoticeDbSyncForTest(): void {
  lastSyncedUsername = null
}
