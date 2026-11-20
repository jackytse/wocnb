/**
 * 退出登录确认弹窗的全局共享状态与登出执行逻辑。
 *
 * 为什么做成模块级单例：退出登录的入口有两处 ——
 * 1. 侧边栏用户菜单（UserMenu.vue）；
 * 2. 系统托盘右键菜单的「退出登录」条目（Rust emit cnb://tray-logout，
 *    main.ts 监听后调 openLogoutConfirm()，此时 UserMenu 可能根本没挂载）。
 * 弹窗状态必须活在与组件生命周期无关的模块作用域，对话框组件
 * （LogoutConfirmDialog.vue）挂在 App.vue 根部常驻渲染，谁打开都可见。
 *
 * confirmLogout 从 UserMenu.vue 原样迁移（行为不变）：
 * - 可选清空本地通知数据（勾选后先物理删除 SQLite 该账号通知，失败仅
 *   toast 告知不阻塞登出）；
 * - OAuth 登录方式同步清理 CLI 侧令牌（失败静默）；
 * - 清空本地凭证与登录方式标记 → toast 反馈 → 回登录页。
 */
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { logout } from './useCnbAuth'
// 登出可选清空持久化数据（SQLite）：勾选时在 logout() 之前物理删除
// 当前账号的本地数据（依赖 username，logout 之后拿不到）——
// 含历史通知与「最近打开」记录（notice_db_clear 一并删除）
import { clearNoticesInDb } from './useNoticeDb'
// 「最近打开」的内存/localStorage 残留清空（SQLite 行由 clearNoticesInDb
// 内的 notice_db_clear 删除，本函数只负责前端侧状态）
import { clearRecentRepos } from './useRecentRepos'
// OAuth 登录方式下的退出需要同步清理 CLI 侧令牌与登录方式标记（缺陷 D1：
// 残留 oauth 标记会让重启时的临期刷新分支把 CLI 旧 OAuth 令牌静默覆盖
// 用户重登的 PAT —— 与 settings/token.vue 的退出逻辑保持对齐）
import { cnbAuthMethod, cnbTokenExpiresAt, logoutCliSide } from './useCnbCliAuth'
import { useAppToast } from './useAppToast'

/**
 * 确认弹窗开关（模块级单例）：所有入口共用同一份状态，
 * LogoutConfirmDialog 直接绑定渲染。
 */
const logoutConfirmOpen = ref(false)

/**
 * 退出时是否同时清空本地通知数据（SQLite 持久化的历史通知）。
 * 默认 false —— 数据保留是默认策略（同一账号下次登录仍可见），
 * 用户显式勾选才物理删除；每次打开弹窗时重置，不残留上次勾选。
 */
const logoutClearData = ref(false)

/** 登出执行中的标记：确认按钮置 loading 并禁用，防双击重复登出 */
const logoutBusy = ref(false)

/**
 * 打开退出登录确认弹窗（任意入口调用）。
 * 每次打开都重置「清空数据」勾选，避免上次取消时勾选状态残留。
 */
export function openLogoutConfirm() {
  logoutClearData.value = false
  logoutConfirmOpen.value = true
}

/**
 * 退出登录确认弹窗的共享状态与执行函数（组件 setup 中调用）。
 * 需要 router / i18n / toast 的实例上下文，因此以 composable 形式暴露；
 * 状态本体是模块级 ref，多个组件拿到的是同一份数据。
 */
export function useLogoutConfirm() {
  const router = useRouter()
  const { t } = useI18n()
  const toast = useAppToast()

  /**
   * 执行登出（弹窗「退出登录」按钮回调）。
   *
   * 顺序要点：清空通知必须在 logout() 之前 —— clearNoticesInDb 依赖
   * cnbUser.username，登出后拿不到；CLI 登出失败、通知删除失败都不
   * 阻塞本地凭证清理（凭证清理是登出的核心动作，不能被可选步骤中断）。
   */
  async function confirmLogout() {
    // 防重入：登出执行中再次点击直接忽略（按钮已禁用，这里是兜底）
    if (logoutBusy.value) {
      return
    }
    logoutBusy.value = true
    try {
      // 勾选了清空数据：删除该账号的持久化数据（通知两个分区 + 最近打开记录，
      // 同一条 notice_db_clear 命令内完成）+ 前端侧「最近打开」内存/降级存储
      if (logoutClearData.value) {
        try {
          await clearNoticesInDb()
          clearRecentRepos()
        }
        catch (err) {
          // 删除失败：明确告知“数据未删除”，避免用户误以为已清空
          toast.add({
            title: t('menu.logoutClearFailed'),
            description: String(err),
            color: 'warning',
            duration: 5000,
          })
        }
      }
      // OAuth 登录方式：同步清理 CLI 侧令牌（cnb logout --host），保证应用与
      // CLI 两端一致；失败不阻塞本地登出（与 settings/token.vue 同策略）
      if (cnbAuthMethod.value === 'oauth') {
        await logoutCliSide().catch(() => {})
      }
      logout()
      // 清理登录方式与过期时间标记：防止残留 oauth 标记误触发重启续期分支
      cnbAuthMethod.value = ''
      cnbTokenExpiresAt.value = 0
      toast.add({
        title: t('menu.loggedOut'),
        description: t('menu.loggedOutDesc'),
        color: 'neutral',
        duration: 3000,
      })
      await router.replace('/login')
    }
    finally {
      logoutBusy.value = false
    }
  }

  return {
    /** 弹窗开关（v-model:open 直接绑定） */
    logoutConfirmOpen,
    /** 清空数据勾选（弹窗内 UCheckbox 绑定） */
    logoutClearData,
    /** 登出执行中（确认按钮 loading/禁用） */
    logoutBusy,
    /** 执行登出（确认按钮回调） */
    confirmLogout,
  }
}
