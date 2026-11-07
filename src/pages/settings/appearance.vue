<script setup lang="ts">
/**
 * 设置 · 外观（useColorMode：system / light / dark）。
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
  { label: t('settings.appearance.system'), value: 'system', icon: 'i-lucide-monitor' },
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
