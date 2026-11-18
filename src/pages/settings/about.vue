<script setup lang="ts">
/**
 * 设置 · 关于：应用版本（Tauri getVersion）、检查更新、开源仓库、CNB 反馈、许可证。
 *
 * 检查更新链路（useAppUpdate）：
 * - 手动：本页「检查更新」按钮 → checkForUpdate()，结果按状态机渲染在
 *   版本行下方（available 时给「前往下载」外跳按钮）；
 * - 自动：启动后由 layouts/default.vue 延迟静默检查（24h 节流），发现
 *   新版本在首页弹 toast —— 两处共享 useAppUpdate 的模块级单例 state。
 */
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useAppUpdate } from '../../composables/useAppUpdate'

const { t } = useI18n()

// 更新检测单例 state（与启动 toast 链路共享同一份数据）
const { status, latestRelease, lastError, checkForUpdate } = useAppUpdate()

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

/** 最新 Release 的 tag（供"发现新版本 vX"展示；无 Release 时显示 '-'） */
const latestTag = (): string => latestRelease.value?.tagName || '-'

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

/** 手动检查更新：checkForUpdate 不抛异常，结果由状态机渲染（含错误） */
function onManualCheck() {
  void checkForUpdate()
}
</script>

<template>
  <UPageCard
    :title="t('settings.about.title')"
    variant="naked"
  />

  <!-- 版本 + 检查更新 + 许可证 -->
  <UPageCard variant="subtle">
    <div class="flex items-center justify-between py-1">
      <span class="text-sm text-muted">{{ t('settings.about.version') }}</span>
      <span class="font-mono text-sm text-highlighted">{{ version }}</span>
    </div>
    <USeparator />
    <!-- 检查更新行：按钮右侧对齐；检查中由 loading 态自旋（防重复点击） -->
    <div class="py-1">
      <div class="flex items-center justify-between gap-3">
        <span class="text-sm text-muted">{{ t('settings.about.checkUpdate') }}</span>
        <UButton
          size="xs"
          color="neutral"
          variant="outline"
          icon="i-lucide-refresh-cw"
          :loading="status === 'checking'"
          :label="t('settings.about.checkUpdate')"
          :disabled="status === 'checking'"
          @click="onManualCheck"
        />
      </div>
      <!-- 状态提示：四态各有独立文案（发现新版本最高优先级展示） -->
      <div v-if="status === 'available'" class="mt-2 flex items-center justify-between gap-3">
        <p class="text-sm text-primary">
          {{ t('settings.about.newVersionFound', { version: latestTag() }) }}
        </p>
        <UButton
          size="xs"
          color="primary"
          variant="soft"
          icon="i-lucide-download"
          trailing-icon="i-lucide-arrow-up-right"
          :label="t('settings.about.goDownload')"
          @click="openExternal('https://cnb.cool/jackytse/wocnb/-/releases')"
        />
      </div>
      <p v-else-if="status === 'upToDate'" class="mt-2 text-xs text-dimmed">
        {{ t('settings.about.upToDate') }}
      </p>
      <p v-else-if="status === 'checking'" class="mt-2 text-xs text-dimmed">
        {{ t('settings.about.checking') }}
      </p>
      <!-- 错误态：带服务端原文（403 缺 scope 时用户能直接看到缺哪个权限） -->
      <p v-else-if="status === 'error'" class="mt-2 text-xs text-error break-all">
        {{ t('settings.about.checkFailed') }}{{ lastError ? `: ${lastError}` : '' }}
      </p>
      <p v-else class="mt-2 text-xs text-dimmed">
        {{ t('settings.about.autoCheckHint') }}
      </p>
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
