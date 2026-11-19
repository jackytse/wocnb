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
import { useColorMode } from '@vueuse/core'

const { t } = useI18n()
const colorMode = useColorMode()

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
      v-model="colorMode"
      :items="options"
      value-key="value"
      variant="card"
      :ui="{ fieldset: 'w-full' }"
    />
  </UPageCard>
</template>
