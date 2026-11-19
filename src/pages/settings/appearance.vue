<script setup lang="ts">
/**
 * 设置 · 外观（useColorMode：auto / light / dark）。
 *
 * ⚠️ 存储值必须用 'auto' 表示"跟随系统"（VueUse useColorMode 的合法
 * 三值就是 auto/light/dark，index.html 内联脚本首屏判定也读 'auto'）；
 * 早期版本误用 'system'，属于非法值不会命中任何模式 —— 读取时在下方
 * migration 归一。
 *
 * 与用户菜单的主题切换同源（@vueuse/core useColorMode，Nuxt UI 深色
 * 模式依赖 .dark class），选择立即生效并持久化，重启保留。
 */
import { useI18n } from 'vue-i18n'
import { computed } from 'vue'
import { useColorMode } from '@vueuse/core'

const { t } = useI18n()
const colorMode = useColorMode()

/**
 * 供 v-model 使用的「用户存储偏好」视图。
 *
 * ⚠️ 不能直接 v-model="colorMode"：useColorMode 返回的 .value 是
 * 「解析后的实际模式」—— 跟随系统（store='auto'）时会被解析成
 * light/dark，单选框就会错误地落在 light/dark 上，且写回会把
 * "跟随系统"悄悄固化成具体模式。必须读写 store（存储偏好）：
 * - get：store.value（合法值 auto/light/dark，'auto' 即跟随系统）
 * - set：写回 store.value，由 VueUse 落盘并应用 .dark class
 * 另外模板中嵌套的 ref 不会被自动解包（colorMode.store 是
 * 挂在返回对象上的 computed ref），所以必须在脚本层包一层 computed。
 */
const themePreference = computed({
  get: () => colorMode.store.value,
  set: v => colorMode.store.value = v,
})

/** 三选项（value 与 useColorMode 存储值一致） */
const options = [
  { label: t('settings.appearance.system'), value: 'auto', icon: 'i-lucide-monitor' },
  { label: t('settings.appearance.light'), value: 'light', icon: 'i-lucide-sun' },
  { label: t('settings.appearance.dark'), value: 'dark', icon: 'i-lucide-moon' },
]
</script>

<template>
  <UPageCard
    :title="t('settings.appearance.title')"
    :description="t('settings.appearance.desc')"
    variant="naked"
  />

  <UPageCard variant="subtle">
    <URadioGroup
      v-model="themePreference"
      :items="options"
      value-key="value"
      variant="card"
      :ui="{ fieldset: 'w-full' }"
    />
  </UPageCard>
</template>
