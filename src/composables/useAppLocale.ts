/**
 * 应用语言偏好组合函数（多语言切换的状态中枢）。
 *
 * 需求：支持「系统语言 / English / 简体中文 / 繁體中文」四种选项，
 * 默认跟随系统语言。
 *
 * 实现要点：
 * - 用户偏好持久化到 localStorage（key: cnb-locale），重启应用后保留；
 *   'system' 表示跟随系统，不落盘具体语言（系统语言变化后仍保持跟随）；
 * - resolvedLocale 为最终生效语言（computed）：偏好为 system 时按
 *   navigator.language(s) 推断（zh-TW/HK/MO/Hant → zh-TW，zh* → zh-CN，
 *   其余 → 英文），否则直接使用所选语言；
 * - main.ts 中 watch resolvedLocale 同步到 i18n 实例，实现全局热切换。
 */
import { computed } from 'vue'
import { useStorage } from '@vueuse/core'

/** 用户可选的语言偏好：system 为跟随系统，其余为显式指定 */
export type LocalePref = 'system' | 'en' | 'zh-CN' | 'zh-TW'

/** 最终生效的应用语言（i18n 实例实际使用的语言） */
export type AppLocale = Exclude<LocalePref, 'system'>

/**
 * 语言偏好（localStorage 持久化 + 响应式）。
 * 默认 'system'：未手动选择过语言时始终跟随系统。
 */
export const localePref = useStorage<LocalePref>('cnb-locale', 'system')

/**
 * 从浏览器语言列表推断系统语言。
 *
 * 顺序遍历 navigator.languages（按用户系统偏好排序，取第一个可识别项）：
 * - 明确的繁体地区（zh-TW / zh-HK / zh-MO / zh-Hant*）→ 繁体中文；
 * - 其余 zh 开头（zh-CN / zh-SG / 裸 zh 等）→ 简体中文；
 * - en 开头 → 英文；均无法识别时兜底英文（与应用 fallbackLocale 一致）。
 */
function detectSystemLocale(): AppLocale {
  const candidates = navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const raw of candidates) {
    const lang = (raw || '').toLowerCase()
    if (!lang) {
      continue
    }
    // 繁体优先判断：zh-HK/zh-MO/zh-TW/zh-Hant 均视为繁体用户
    if (lang === 'zh-tw' || lang === 'zh-hk' || lang === 'zh-mo'
      || lang.startsWith('zh-hant') || lang.startsWith('zh-tw') || lang.startsWith('zh-hk') || lang.startsWith('zh-mo')) {
      return 'zh-TW'
    }
    if (lang.startsWith('zh')) {
      return 'zh-CN'
    }
    if (lang.startsWith('en')) {
      return 'en'
    }
  }
  return 'en'
}

/** 最终生效语言：跟随系统时实时推断，显式选择时直接返回（computed 保持响应式） */
export const resolvedLocale = computed<AppLocale>(() =>
  localePref.value === 'system' ? detectSystemLocale() : localePref.value,
)
