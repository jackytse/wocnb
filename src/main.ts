import './assets/css/main.css'

import { createApp, watch } from 'vue'
import type { RouteRecordRaw } from 'vue-router'
import { createRouter, createWebHistory } from 'vue-router'
import { routes, handleHotUpdate } from 'vue-router/auto-routes'
import { setupLayouts } from 'virtual:generated-layouts'
import { createHead } from '@unhead/vue/client'
import { openUrl } from '@tauri-apps/plugin-opener'
import { restoreSession, cnbToken, setUnauthorizedHandler } from './composables/useCnbAuth'
import { refreshCliTokenIfNeeded } from './composables/useCnbCliAuth'
import { initBuildWatcher } from './composables/useCnbBuildWatch'
import { initBuildNotificationActionHandler } from './composables/useBuildNotificationAction'
import { isNotificationsSlideoverOpen } from './composables/useDashboard'
import { localePref, resolvedLocale } from './composables/useAppLocale'
import { i18n } from './i18n'
import { LEGACY_ORG_ROUTE_NAME, legacyOrgRedirect } from './router/legacy-org'
import ui from '@nuxt/ui/vue-plugin'

import App from './App.vue'

/**
 * Tauri 环境下把外部 http(s) 链接转交给系统默认浏览器打开。
 *
 * 背景：Tauri 的 Webview 会拦截 <a target="_blank"> 的新窗口请求，
 * 导致点击 Feedback、Help & Support 等外链没有任何反应。
 *
 * 实现：在 document 捕获阶段监听 click（确保先于框架/组件的默认行为），
 * 命中外链时阻止默认跳转，改为调用 opener 插件唤起系统浏览器。
 * 纯浏览器环境（pnpm dev 直开网页）不做拦截，保持原跳转行为。
 */
function setupExternalLinkHandler() {
  // __TAURI_INTERNALS__ 仅在 Tauri Webview 中由运行时注入
  const isTauri = '__TAURI_INTERNALS__' in window
  if (!isTauri) {
    return
  }

  document.addEventListener('click', (event) => {
    // closest 向上找到最近的可点击锚点，兼容 Nuxt UI 组件内部的多层嵌套结构
    const anchor = (event.target as HTMLElement | null)?.closest?.('a')
    if (!anchor) {
      return
    }
    const href = anchor.getAttribute('href')
    // 仅拦截完整的外部 http(s) 链接；站内路由（/xxx）与锚点（#）不处理
    if (!href || !/^https?:\/\//i.test(href)) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    openUrl(href).catch((err) => {
      // 打开失败时降级为 Webview 内直接导航，保证链接仍可用
      console.error('openUrl failed, fallback to navigate:', err)
      window.location.href = href
    })
  }, true)
}

setupExternalLinkHandler()

/**
 * 多语言初始化：
 * 1. 启动时按「用户偏好（默认 system）+ 系统语言」立即设定生效语言，
 *    保证首屏文案语言正确；
 * 2. watch resolvedLocale（用户在菜单中切换语言 / 系统语言变化）时热切换，
 *    所有使用 t() 的文案（含 computed 中的调用）随响应式依赖自动更新，
 *    无需刷新页面；
 * 3. 同步 <html lang> 属性，便于无障碍与字体渲染策略识别语言。
 */
i18n.global.locale.value = resolvedLocale.value
watch(resolvedLocale, (loc) => {
  i18n.global.locale.value = loc
  document.documentElement.setAttribute('lang', loc)
})
// 偏好本身变化也要触发一次同步（如从 zh-CN 切回 system 且推断结果不同）
watch(localePref, () => {
  i18n.global.locale.value = resolvedLocale.value
})

const app = createApp(App)

/**
 * 全局错误兜底：组件渲染 / watcher 回调里抛出的异常会被 Vue 内部捕获，
 * 开发态只打印 console.warn，生产包甚至没有任何痕跡 —— 用户侧表现为
 * "页面卡住 / 内容空白"，却完全无从排查。
 *
 * 典型踩坑（2026-10-27）：USelect 的 items 里出现 `value: ''` 时，底层
 * Reka UI 的 SelectItem 会抛错，异常发生在 Tabs 内容的 watcher 渲染阶段，
 * 于是整个 Builds 页签渲染中断、页面看起来像卡死。
 *
 * 这里统一把此类异常打到 console.error（含 Vue 给出的阶段信息），
 * 保证下次再出现同类问题能第一时间看到原始栈。
 */
app.config.errorHandler = (err, _instance, info) => {
  console.error('[wocnb] unhandled error:', info, err)
}

const head = createHead()

// 旧链接 /org → /group 的重定向记录与完整设计说明见 src/router/legacy-org.ts
// （单独成模块是为了让 legacy-org 单测 import 真身，而非复刻一份路由表导致假绿）
const appRoutes: RouteRecordRaw[] = [
  ...setupLayouts(routes as RouteRecordRaw[]),
  legacyOrgRedirect,
]

const router = createRouter({
  routes: appRoutes,
  history: createWebHistory()
})

/**
 * 登录守卫：未登录（本地无 CNB 访问令牌）时强制跳转登录页；
 * 已登录访问 /login 时自动回到首页。
 * 原始目标路径记录在 redirect 参数中，登录成功后原路返回。
 * 登录态读取统一走 useCnbAuth 的响应式状态（与 localStorage 持久化同一来源）。
 */
router.beforeEach((to) => {
  if (to.path === '/login') {
    return cnbToken.value ? { path: '/' } : true
  }
  if (!cnbToken.value) {
    return { path: '/login', query: { redirect: to.fullPath } }
  }
  return true
})

app.use(head)
app.use(i18n)
app.use(router)
app.use(ui)

app.mount('#app')

// 登录态恢复：本地令牌存在但用户信息缺失/非法时，后台静默补全用户信息
// （不阻塞首屏渲染；令牌失效会自动清除登录态并回到登录页）。
// OAuth 登录（cnb-cli 设备授权）先做临期续期（<10min 时用 refresh_token
// 刷新，Rust 侧同步写回 ~/.cnb/token），再恢复用户信息；刷新失败会清
// 登录态，由路由守卫引导到登录页重新授权。
refreshCliTokenIfNeeded().then(() => restoreSession())

/**
 * 构建结果通知轮询：登录态恢复之后再启动（轮询首轮会用到 selectedGroup
 * 与令牌）。initBuildWatcher 内部只注册 watch + 延迟首次 tick，不阻塞首屏；
 * 首次 tick 只建立快照基线、不发通知（避免把历史 pending 当成"刚结束"）。
 *
 * 注意：该轮询依赖主窗口的 `"backgroundThrottling": "disabled"`
 * （见 src-tauri/tauri.conf.json 与 useCnbBuildWatch 顶部注释），否则窗口
 * 隐藏后定时器会被 WKWebView 节流，托盘常驻场景收不到通知。
 * 该字段是 Tauri 2 的 BackgroundThrottlingPolicy **字符串枚举**
 * （disabled / suspend / throttle），写成布尔 false 会让 cargo build 的
 * 配置校验直接失败（invalid type: boolean，expected string or map），
 * 不要"顺手"改回布尔值。
 */
initBuildWatcher()

/**
 * 系统通知点击处理：Rust 侧 on_action（src-tauri/src/lib.rs）把用户点击
 * 通知的动作以事件 `cnb://build-notification-action` emit 给前端，这里
 * 注册监听并把动作翻译成路由意图：
 * - 通知带 repoPath+sn（逐条构建通知）→ 直达 /repos/<path>?tab=builds&sn=xxx；
 * - 否则（摘要/离线补推/测试通知/字段缺失）→ 打开应用内通知面板兜底。
 *
 * 依赖注入的说明：router 在本文件内联创建且未导出（项目约定不导出
 * router 实例），面板开关 ref 也不该被点击处理模块反向依赖——因此
 * navigate/openPanel 都以回调形式注入（见 useBuildNotificationAction），
 * 该设计同时让事件处理逻辑可以脱离 vue-router 做单测。
 *
 * 浏览器 dev（pnpm dev 直开网页）下 initBuildNotificationActionHandler
 * 会因无 Tauri 运行时直接跳过，不会注册监听也不报错。
 */
initBuildNotificationActionHandler({
  navigate: (target) => router.push(target),
  openPanel: () => {
    // 直接置位模块级面板开关 ref（与组件内 useDashboard 返回的是同一份
    // 单例引用，铃铛面板打开状态自然同步）
    isNotificationsSlideoverOpen.value = true
  },
}).catch((err) => {
  // 注册失败只影响"点击直达"这一个入口（通知本身照常弹出），不阻断启动
  console.warn('[wocnb] 注册系统通知点击处理失败：', err)
})

// 401 统一拦截：任意 CNB API 请求返回 401（令牌失效）时，
// 清除本地登录态并跳转登录页；携带 redirect 供登录后原路返回，
// expired 标记供登录页展示"登录已过期"提示。
// 已在登录页时跳过跳转（登录页自身的校验请求不走 cnbFetch，正常不会触发；
// 此判断作为兜底防止循环重定向）。
setUnauthorizedHandler((fromPath) => {
  if (router.currentRoute.value.path === '/login') {
    return
  }
  router.push({ path: '/login', query: { redirect: fromPath, expired: '1' } })
})

// 自动路由热更新兜底（dev 专用）：
// vue-router 的 auto-routes HMR 回调内部会先 router.clearRoutes() 再逐条重放
// "由文件生成的路由"，因此手工追加的 legacy-org 会被一并清除 —— 现象是 dev 下
// 改任意 src/pages/** 文件后访问 /org 直接 404（控制台 "No match found for
// location with path /org"）。handleHotUpdate 的第 2 个参数正是为此提供的补挂
// 点，它在重放之后调用，这里幂等补回 legacy-org（已存在则跳过）。
// 注：重放的是"未套 setupLayouts"的原始路由，热更新后布局会丢，属既有缺陷，
// 与本次术语改造无关；凡改/重命名 src/pages/** 后应整页刷新再验证。
if (import.meta.hot) {
  handleHotUpdate(router, () => {
    if (!router.hasRoute(LEGACY_ORG_ROUTE_NAME)) {
      router.addRoute(legacyOrgRedirect)
    }
  })
}
