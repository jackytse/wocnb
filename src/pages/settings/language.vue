<script setup lang="ts">
/**
 * 设置 · 语言（与 localePref 同源的四选项）。
 *
 * 与用户菜单的语言切换共用 useAppLocale 的 localePref（localStorage
 * key cnb-locale），选择立即生效（main.ts watch 热切换）并重启保留。
 * 语言名称以"母语自称"展示（与 UserMenu 约定一致），不随当前语言翻译。
 */
import { useI18n } from 'vue-i18n'
import { localePref, type LocalePref } from '../../composables/useAppLocale'

const { t } = useI18n()

/** 四选项：system 为跟随系统；其余为显式语言 */
const options: { label: string, value: LocalePref }[] = [
  { label: t('settings.language.system'), value: 'system' },
  { label: 'English', value: 'en' },
  { label: '简体中文', value: 'zh-CN' },
  { label: '繁體中文', value: 'zh-TW' },
]
</script>

<template>
  <UPageCard
    :title="t('settings.language.title')"
    :description="t('settings.language.desc')"
    variant="naked"
  />

  <UPageCard variant="subtle">
    <URadioGroup
      v-model="localePref"
      :items="options"
      value-key="value"
      variant="card"
      :ui="{ fieldset: 'w-full' }"
    />
  </UPageCard>
</template>
