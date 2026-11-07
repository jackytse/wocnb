/**
 * vue-i18n 实例（应用全局唯一）。
 *
 * 设计说明：
 * - legacy: false 使用 Composition API 模式，i18n.global 是一个 reactive
 *   Composer，直接对 i18n.global.locale.value 赋值即可全局热切换语言，
 *   无需刷新页面；
 * - fallbackLocale: 'en'，任何语言包缺失的键自动回退英文，保证界面不出现
 *   裸键名；
 * - 语言包独立放在 src/locales/ 下（en / zh-CN / zh-TW），键结构一一对应，
 *   新增语言只需添加同结构文件并在 messages 中注册。
 */
import { createI18n } from 'vue-i18n'
import en from './locales/en'
import zhCN from './locales/zh-CN'
import zhTW from './locales/zh-TW'

export const i18n = createI18n({
  legacy: false,
  // 初始语言仅为占位，main.ts 启动时会立即按用户偏好/系统语言覆盖
  locale: 'en',
  fallbackLocale: 'en',
  messages: {
    en,
    'zh-CN': zhCN,
    'zh-TW': zhTW,
  },
})
