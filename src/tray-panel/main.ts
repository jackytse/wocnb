/**
 * 托盘快捷面板的独立应用入口（与主应用 SPA 完全分离）。
 *
 * # 为什么要独立入口
 *
 * 面板窗口此前复用主应用的 index.html：同一份 SPA 会在小窗口里加载
 * 路由、布局、会话恢复、构建轮询等全部主窗口逻辑，只能靠 window.label
 * 分支逐项跳过——既脆弱（漏一处就双份轮询）又容易在开发态因为 dev
 * server 残留把整个应用渲染进弹窗。改为独立 HTML 入口后：
 * - 面板只依赖 Vue + i18n + Nuxt UI 插件 + 面板页本身；
 * - 不存在"渲染到主应用页面"的可能（路由都不存在）；
 * - 启动开销更小，弹窗更跟手。
 *
 * # 只做三件事
 *
 * 1. 注入全局样式（与主应用同一份 Tailwind/Nuxt UI 主题，保证配色一致）；
 * 2. 初始化语言（沿用主窗口落盘的偏好，启动即正确语言）；
 * 3. 跟随系统深浅色（与主应用同一套 .dark 类机制）。
 */
import '../assets/css/main.css'

import { createApp, watch } from 'vue'
import ui from '@nuxt/ui/vue-plugin'
import { i18n } from '../i18n'
import { resolvedLocale } from '../composables/useAppLocale'
import TrayPanel from './TrayPanel.vue'

/**
 * 应用最终生效语言。
 *
 * 面板不需要语言切换 UI，但必须与主窗口同语言：resolvedLocale 读取的是
 * 同一个 localStorage 偏好（cnb-locale），并自动按系统语言推断。
 */
i18n.global.locale.value = resolvedLocale.value

/** 主窗口切换语言后，面板下次打开时也应跟随（热更新 + 监听双保险） */
watch(resolvedLocale, (loc) => {
  i18n.global.locale.value = loc
  document.documentElement.setAttribute('lang', loc)
})
document.documentElement.setAttribute('lang', resolvedLocale.value)

/**
 * 深浅色跟随系统。
 *
 * 主应用由 Nuxt UI 的 color-mode 机制管理 .dark 类；面板是独立应用实例，
 * 不会自动接入，这里用 matchMedia 手动同步——面板只在打开瞬间可见，
 * 一次系统主题变化即可即时生效，无需额外状态存储。
 */
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')
function applyColorMode(isDark: boolean): void {
  document.documentElement.classList.toggle('dark', isDark)
}
applyColorMode(darkQuery.matches)
darkQuery.addEventListener('change', event => applyColorMode(event.matches))

const app = createApp(TrayPanel)
app.use(i18n)
app.use(ui)
app.mount('#tray-panel')
