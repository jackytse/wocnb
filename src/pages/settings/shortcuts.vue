<script setup lang="ts">
/**
 * 设置 · 快捷键（只列真实存在的键位，PRD 待确认问题 5 的拍板口径）。
 *
 * 键位来源（与应用内实际注册一致，改 useDashboard/搜索组件需同步本页）：
 * - Cmd/Ctrl+K：UDashboardSearch 全局搜索（Nuxt UI 内置 meta_k）；
 * - Esc：关闭弹窗/抽屉/下拉（reka-ui 组件默认行为）；
 * - G H / G S：跳首页 / 设置（useDashboard 的 defineShortcuts）；
 * - N：通知面板开关（useDashboard）。
 * 不列不存在的键位（如 Cmd+R 刷新 —— 未实现）。
 */
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

/** 真实键位清单（shortcut 展示串 + 说明文案键） */
const shortcuts = [
  { keys: ['⌘', 'K'], desc: 'settings.shortcuts.search' },
  { keys: ['Esc'], desc: 'settings.shortcuts.esc' },
  { keys: ['G', 'H'], desc: 'settings.shortcuts.goHome' },
  { keys: ['G', 'S'], desc: 'settings.shortcuts.goSettings' },
  { keys: ['N'], desc: 'settings.shortcuts.notifications' },
]
</script>

<template>
  <UPageCard
    :title="t('settings.shortcuts.title')"
    :description="t('settings.shortcuts.desc')"
    variant="naked"
  />

  <UPageCard variant="subtle">
    <div class="flex flex-col divide-y divide-default">
      <div
        v-for="item in shortcuts"
        :key="item.desc"
        class="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0"
      >
        <span class="text-sm text-muted">{{ t(item.desc) }}</span>
        <span class="flex items-center gap-1 shrink-0">
          <UKbd v-for="key in item.keys" :key="key" :value="key" />
        </span>
      </div>
    </div>
  </UPageCard>
</template>
