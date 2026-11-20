import './assets/css/main.css'

import { createApp, watch } from 'vue'
import type { RouteRecordRaw } from 'vue-router'
import { createRouter, createWebHistory } from 'vue-router'
import { routes, handleHotUpdate } from 'vue-router/auto-routes'
import { setupLayouts } from 'virtual:generated-layouts'
import { createHead } from '@unhead/vue/client'
import { invoke } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'
import { restoreSession, cnbToken, cnbUser, setUnauthorizedHandler } from './composables/useCnbAuth'
import { refreshCliTokenIfNeeded } from './composables/useCnbCliAuth'
import { initBuildWatcher } from './composables/useCnbBuildWatch'
import { initBuildNotificationActionHandler } from './composables/useBuildNotificationAction'
import { initNoticeDbSync } from './composables/useNoticeRestore'
import { isNotificationsSlideoverOpen } from './composables/useDashboard'
import { localePref, resolvedLocale } from './composables/useAppLocale'
import { i18n } from './i18n'
import { LEGACY_ORG_ROUTE_NAME, legacyOrgRedirect } from './router/legacy-org'
import ui from '@nuxt/ui/vue-plugin'

// CNB 官方图标（cnb:logo）注册为 Iconify 本地集合 —— 侧边栏/菜单/⌘K
// 里的 `i-cnb-logo` 都依赖这次全局注册，必须在应用挂载前执行
import { registerCnbIcons } from './utils/cnbIcon'

registerCnbIcons()

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
 * 清除 WebView 卡住的 :hover 状态。
 *
 * 背景：点击「使用反馈 / 代码仓库」等外链时，系统浏览器接管焦点、Webview
 * 窗口失焦，WebKit 在窗口失焦期间不再派发 mouseleave —— 用户回到应用后，
 * 最后悬停的那个链接仍带着鼠标移入时的样式（CSS :hover 是引擎内部状态，
 * JS 无法直接清除）。
 *
 * 技巧：短暂将 body 的 pointer-events 置为 none 再恢复。hover 命中测试只
 * 作用于 pointer-events 可命中的元素，toggle 这个属性会强制 WebKit 重算
 * hover 链 —— 窗口重新聚焦时卡住的样式立即消失；用户再次移动鼠标后由
 * 真实事件接管，无副作用。
 */
window.addEventListener('blur', () => {
  document.body.style.pointerEvents = 'none'
})
window.addEventListener('focus', () => {
  // rAF 等一帧再恢复：确保重算发生在 WebKit 处理完失焦期间的积压事件之后
  requestAnimationFrame(() => {
    document.body.style.pointerEvents = ''
  })
})

/**
 * 自绘悬浮滚动条（全局单例滑块，参考 zoro 的 OverlayScrollbar 方案）。
 *
 * 原生滚动条已在 CSS 里全局隐藏（WebKit 里自定义 ::-webkit-scrollbar 会
 * 把 overlay 条降级成经典条 / 滑块设透明则"永不显示"，见 main.css 注释），
 * 这里用一个 fixed 定位的圆角 div 画滑块：
 * - 活跃容器 = 最近悬停或最近滚动的可滚动元素；
 * - 光标移入容器 / 滚动进行中淡入；指针移出且停止滚动 700ms 后淡出
 *   （与 macOS 原生节奏一致）；
 * - 几何跟随容器 boundingClientRect，弹窗内滚动、窗口缩放都正确；
 * - 不依赖 ::-webkit-scrollbar 伪元素，Chromium / WebKit 行为完全一致。
 */
const sbThumb = document.createElement('div')
sbThumb.style.cssText = [
  'position: fixed',
  'width: 5px',
  'border-radius: 9999px',
  'pointer-events: none',
  'opacity: 0',
  // 只过渡透明度（显示/隐藏淡入淡出）；几何（top/height/left）不过渡 ——
  // 带几何过渡时首次出现会从 0 位移滑到目标位置，看起来像"变形"
  'transition: opacity 200ms ease-out',
  'z-index: 9999',
  'top: 0',
  'left: 0',
].join(';')
document.body.appendChild(sbThumb)

/** 滑块几何参数（与容器边缘的间距，观感对齐 macOS） */
const SB_THUMB_W = 5
const SB_GAP = 3
const SB_TRACK_PAD = 4
const SB_MIN_H = 32

let sbActive: HTMLElement | null = null
let sbHovering = false
let sbScrolling = false
let sbScrollTimer: ReturnType<typeof setTimeout> | null = null
/** 暗色类变化监听（主题切换时滑块配色跟着换，无需轮询） */
let sbDarkObserver: MutationObserver | null = null
/** 活跃容器尺寸/内容变化监听（列表增删导致 scrollHeight 变化时重算几何） */
let sbResizeObserver: ResizeObserver | null = null

function sbApplyColor() {
  const dark = document.documentElement.classList.contains('dark')
  sbThumb.style.background = dark ? 'rgba(255,255,255,0.32)' : 'rgba(0,0,0,0.3)'
}

/** 由活跃容器当前状态重算滑块几何与可见性 */
function sbUpdate() {
  const el = sbActive
  // 与 nearestScrollable 同一门槛：滚动事件里也要过一遍，防止矮条/噪声
  if (!el || !el.isConnected || !sbIsVerticallyScrollable(el)) {
    sbThumb.style.opacity = '0'
    return
  }
  const rect = el.getBoundingClientRect()
  if (rect.height <= 0 || rect.width <= 0) {
    sbThumb.style.opacity = '0'
    return
  }
  const trackH = Math.max(0, rect.height - SB_TRACK_PAD * 2)
  // 滑块长度 ∝ 可视占比，最短 32px（接近 macOS 观感）
  const thumbH = Math.min(trackH, Math.max(SB_MIN_H, (el.clientHeight / el.scrollHeight) * trackH))
  const maxScroll = el.scrollHeight - el.clientHeight
  const ratio = maxScroll > 0 ? el.scrollTop / maxScroll : 0
  sbThumb.style.top = `${rect.top + SB_TRACK_PAD + ratio * (trackH - thumbH)}px`
  sbThumb.style.height = `${thumbH}px`
  sbThumb.style.left = `${rect.right - SB_THUMB_W - SB_GAP}px`
  sbThumb.style.opacity = sbHovering || sbScrolling ? '1' : '0'
}

function sbWatchActive(el: HTMLElement | null) {
  sbResizeObserver?.disconnect()
  sbResizeObserver = null
  if (el) {
    sbResizeObserver = new ResizeObserver(() => sbUpdate())
    sbResizeObserver.observe(el)
  }
  sbUpdate()
}

function nearestScrollable(start: Element | null): HTMLElement | null {
  let cur: Element | null = start
  while (cur) {
    if (cur instanceof HTMLElement && sbIsVerticallyScrollable(cur)) {
      return cur
    }
    cur = cur.parentElement
  }
  return null
}

/**
 * 是否值得绘制竖向滑块。
 *
 * 门槛刻意收紧（吃过教训）：`overflow-x-auto` 的容器（如设置页工具栏）
 * 另一轴会计算为 auto，1~3px 的亚像素溢出就会让它"可滚动"，从而在工具栏
 * 右侧冒出一个毫无意义的小滑块。因此要求：
 * - 竖向溢出 ≥ 8px（1~7px 属布局舍入噪声，一律忽略）；
 * - 容器可视高度 ≥ 60px（工具栏/标签行这类矮条不画滑块）。
 */
function sbIsVerticallyScrollable(el: HTMLElement): boolean {
  return el.scrollHeight - el.clientHeight >= 8 && el.clientHeight >= 60
}

document.addEventListener('mouseover', (event) => {
  const el = nearestScrollable(event.target as Element | null)
  sbHovering = !!el
  if (el === sbActive) {
    sbUpdate()
    return
  }
  sbActive = el
  sbWatchActive(el)
}, { passive: true })

// 指针离开窗口：滑块随窗口切走而隐藏
document.documentElement.addEventListener('mouseleave', () => {
  sbHovering = false
  sbUpdate()
})

// 滚动中：淡入 + 持续刷新几何；停止 700ms 后淡出（capture 捕获全站滚动）
document.addEventListener('scroll', (event) => {
  const el = event.target instanceof HTMLElement ? event.target : null
  // 横向滚动容器（标签条等）与噪声级溢出不参与：不抢当前活跃容器，
  // 也不会在矮条上画滑块
  if (!el || !sbIsVerticallyScrollable(el)) {
    return
  }
  if (el !== sbActive) {
    sbActive = el
    sbWatchActive(el)
  }
  sbScrolling = true
  sbUpdate()
  if (sbScrollTimer) {
    clearTimeout(sbScrollTimer)
  }
  sbScrollTimer = setTimeout(() => {
    sbScrolling = false
    sbUpdate()
  }, 700)
}, { capture: true, passive: true })

window.addEventListener('resize', () => sbUpdate())
window.addEventListener('blur', () => {
  sbHovering = false
  sbScrolling = false
  sbUpdate()
})

// 暗色类切换（html.dark）时重算滑块配色
sbApplyColor()
sbDarkObserver = new MutationObserver(() => sbApplyColor())
sbDarkObserver.observe(document.documentElement, { attributeFilter: ['class'] })

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

/**
 * 同步托盘菜单语言到 Rust 侧（跟随应用语言设置）。
 *
 * 托盘菜单是 Rust 侧的原生 muda 菜单，感知不到 WebView 里的语言状态；
 * 这里把最终生效语言（resolvedLocale：偏好为 system 时已推断成具体值）
 * 经 set_tray_locale 命令传给 Rust —— 持久化并立即重建菜单文案。
 *
 * 调用时机：启动一次（覆盖上次会话残留）+ 每次语言变化（watch）。
 * 浏览器 dev（无 Tauri runtime）跳过；调用失败只 console.warn 静默降级
 * （托盘文案是低价值 UI，失败不该打扰用户）。
 */
function syncTrayLocale(loc: string): void {
  // 浏览器 dev 无 Tauri 运行时，跳过
  if (!('__TAURI_INTERNALS__' in window)) {
    return
  }
  invoke('set_tray_locale', { locale: loc }).catch((err) => {
    console.warn('[wocnb] 同步托盘菜单语言失败:', err)
  })
}
syncTrayLocale(resolvedLocale.value)

/**
 * 同步登录态到托盘菜单（Rust 按 登录/未登录 渲染不同条目）。
 *
 * 约定：username 空串 = 未登录（菜单显示"登录"条目，点击直达登录页）；
 * 非空 = 已登录（菜单显示禁态用户名）。Rust 侧会持久化到 tray-auth.txt，
 * 让应用下次启动时、前端会话恢复完成之前就能渲染正确的登录态条目。
 *
 * 同步三态（避免误报）：
 * - 无令牌 → 明确传空串（登出后菜单切回"登录"条目）；
 * - 有令牌且用户名已知 → 传用户名；
 * - 有令牌但用户信息尚未恢复完成（restoreSession 网络请求进行中）→
 *   跳过本次同步，保留 Rust 侧上次会话的持久化值，避免菜单短暂闪回
 *   "登录"条目；恢复完成后 watch 触发再同步真值。
 *
 * 调用时机：启动一次 + 令牌/用户名任一变化（watch）。浏览器 dev 无
 * Tauri runtime 时跳过；失败只 console.warn（低价值 UI，不打扰用户）。
 */
function syncTrayAuth(): void {
  if (!('__TAURI_INTERNALS__' in window)) {
    return
  }
  if (!cnbToken.value) {
    invoke('set_tray_auth', { username: '' }).catch((err) => {
      console.warn('[wocnb] 同步托盘登录态失败:', err)
    })
    return
  }
  const username = cnbUser.value?.username
  if (!username) {
    return
  }
  invoke('set_tray_auth', { username }).catch((err) => {
    console.warn('[wocnb] 同步托盘登录态失败:', err)
  })
}
syncTrayAuth()
watch([cnbToken, () => cnbUser.value?.username], () => {
  syncTrayAuth()
})

watch(resolvedLocale, (loc) => {
  i18n.global.locale.value = loc
  document.documentElement.setAttribute('lang', loc)
  // 语言变化实时同步托盘菜单文案（Rust 侧持久化 + 主线程重建）
  syncTrayLocale(loc)
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
 *
 * 说明：托盘快捷面板是独立入口（tray-panel.html → src/tray-panel/），
 * 不经过本文件的路由，因此这里无需为它开白名单。
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
 * 通知持久化联动（SQLite）：监听登录用户变化，登录/恢复会话时按账号
 * 回灌历史通知与未读数，登出/换账号时清空内存 feed（数据库默认保留，
 * 登出弹窗勾选「清空数据」才物理删除）。内部对浏览器 dev 环境自动跳过。
 */
initNoticeDbSync()

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

// macOS 应用菜单栏「关于 WOCNB」点击：Rust 侧 handle_app_menu_event emit
// `cnb://menu-about`，这里转成应用内路由跳转到「设置 · 关于」页（含检查
// 更新入口，比系统原生 about 面板更有用）。菜单事件在 Rust 主线程，拿不到
// webview 路由，必须经 IPC 转交；浏览器 dev 无 Tauri runtime，跳过注册。
if ('__TAURI_INTERNALS__' in window) {
  import('@tauri-apps/api/event')
    .then(({ listen }) => listen('cnb://menu-about', () => router.push('/settings/about')))
    .catch((err) => {
      // 注册失败只影响"菜单直达关于页"这一个入口，不阻断启动
      console.warn('[wocnb] 注册应用菜单「关于」跳转失败：', err)
    })
  // 托盘面板"点击项目 / 去更新"跳转：Rust 侧 tray_panel_open_target 命令
  // 隐藏面板 + 前置主窗口后 emit 本事件，payload 是完整路由字符串
  // （如 /repos/a%2Fb?tab=builds&sn=xxx），直接 router.push 即可。
  // 只在主窗口注册（面板窗口收到也无意义）。
  import('@tauri-apps/api/event')
    .then(({ listen }) => listen<string>('cnb://panel-navigate', (event) => {
      void router.push(event.payload)
    }))
    .catch((err) => {
      // 注册失败只影响"面板直达"这一个入口，不阻断启动
      console.warn('[wocnb] 注册托盘面板跳转失败：', err)
    })
}

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
