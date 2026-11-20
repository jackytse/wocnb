<script setup lang="ts">
/**
 * 设置 · 快捷键（只列真实存在的键位，PRD 待确认问题 5 的拍板口径）。
 *
 * 键位来源（与应用内实际注册一致，改 useDashboard/搜索组件需同步本页）：
 * - Cmd/Ctrl+K：UDashboardSearch 全局搜索（Nuxt UI 内置 meta_k）；
 *   Nuxt UI 的 defineShortcuts 在非 macOS 平台会把 meta 改写为 Ctrl
 *   （见其 shortcuts 源码：!macOS && metaKey && !ctrlKey → ctrlKey = true），
 *   所以 macOS 显示 ⌘、Windows/Linux 显示 Ctrl，与实际触发键一致；
 * - Esc：关闭弹窗/抽屉/下拉（reka-ui 组件默认行为）；
 * - G H / G S：跳首页 / 设置（useDashboard 的 defineShortcuts）；
 * - Cmd/Ctrl+,：打开设置（useDashboard 的 meta_,，同 meta 跨平台自适应）；
 * - Cmd/Ctrl+W：关闭主窗口（隐藏到托盘；close 触发 Rust CloseRequested）；
 * - N：通知面板开关（useDashboard）。
 * 不列不存在的键位（如 Cmd+R 刷新 —— 未实现）。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

/** 平台判定：Tauri WebView 的 UA 里 macOS 是 "Macintosh"、Windows 是 "Windows NT" */
const isMac = /Mac|iPhone|iPad/i.test(navigator.userAgent)

/** 修饰键按平台显示：macOS 用 ⌘，Windows/Linux 用 Ctrl（与实际触发一致） */
const modKey = isMac ? '⌘' : 'Ctrl'

/** 真实键位清单（shortcut 展示串 + 说明文案键） */
const shortcuts = computed(() => [
  { keys: [modKey, 'K'], desc: 'settings.shortcuts.search' },
  { keys: [modKey, ','], desc: 'settings.shortcuts.openSettings' },
  { keys: [modKey, 'W'], desc: 'settings.shortcuts.closeWindow' },
  { keys: ['Esc'], desc: 'settings.shortcuts.esc' },
  { keys: ['G', 'H'], desc: 'settings.shortcuts.goHome' },
  { keys: ['G', 'S'], desc: 'settings.shortcuts.goSettings' },
  { keys: ['N'], desc: 'settings.shortcuts.notifications' },
])
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
