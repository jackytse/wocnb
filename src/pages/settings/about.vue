<script setup lang="ts">
/**
 * 设置 · 关于：应用版本（Tauri getVersion）、开源仓库、CNB 反馈、许可证。
 */
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { openUrl } from '@tauri-apps/plugin-opener'

const { t } = useI18n()

/** 应用版本号（Tauri API，非 Tauri 环境显示 '-'） */
const version = ref('-')
onMounted(async () => {
  if ('__TAURI_INTERNALS__' in window) {
    try {
      const { getVersion } = await import('@tauri-apps/api/app')
      version.value = await getVersion()
    }
    catch {
      version.value = '-'
    }
  }
})

/** 本项目源码仓库（与侧边栏"View page source"一致） */
const repoUrl = 'https://cnb.cool/jackytse/wocnb'
/** CNB 官方反馈仓库 */
const feedbackUrl = 'https://cnb.cool/cnb/feedback'

/** 在系统浏览器打开链接（非 Tauri 环境兜底 window.open） */
function openExternal(url: string) {
  if ('__TAURI_INTERNALS__' in window) {
    void openUrl(url)
  }
  else {
    window.open(url, '_blank')
  }
}
</script>

<template>
  <UPageCard
    :title="t('settings.about.title')"
    variant="naked"
  />

  <!-- 版本 + 许可证 -->
  <UPageCard variant="subtle">
    <div class="flex items-center justify-between py-1">
      <span class="text-sm text-muted">{{ t('settings.about.version') }}</span>
      <span class="font-mono text-sm text-highlighted">{{ version }}</span>
    </div>
    <USeparator />
    <div class="flex items-center justify-between py-1">
      <span class="text-sm text-muted">{{ t('settings.about.license') }}</span>
      <span class="text-sm text-highlighted">{{ t('settings.about.licenseValue') }}</span>
    </div>
  </UPageCard>

  <!-- 开源仓库 / 反馈入口 -->
  <UPageCard variant="subtle">
    <div class="flex flex-col gap-3">
      <UButton
        block
        color="neutral"
        variant="outline"
        icon="i-lucide-github"
        :label="t('settings.about.repo')"
        @click="openExternal(repoUrl)"
      />
      <UButton
        block
        color="neutral"
        variant="outline"
        icon="i-lucide-message-circle"
        :label="t('settings.about.feedback')"
        @click="openExternal(feedbackUrl)"
      />
    </div>
  </UPageCard>
</template>
