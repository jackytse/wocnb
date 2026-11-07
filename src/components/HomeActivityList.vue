<script setup lang="ts">
/**
 * 动态列表（通用组件）。
 *
 * 数据由调用方传入（fetchCnbActivities 的归一化结果），本组件只负责
 * 展示与交互：骨架屏 / 失败重试 / 空态 / 点击在系统浏览器打开对应页面。
 *
 * 复用方：NotificationsSlideover（通知面板）、index.vue（Home「动态」选项卡）。
 * 图标与动作文案的映射原来只在通知面板内使用，现提取至此共享。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { formatTimeAgo } from '@vueuse/core'
import { openUrl } from '@tauri-apps/plugin-opener'
import type { CnbActivityItem, CnbActivityKind } from '../composables/useCnbAuth'

/** 组件属性：列表数据 + 加载状态（数据拉取逻辑留在调用方，便于按需触发） */
const props = defineProps<{
  /** 动态条目列表（已归一化） */
  items: CnbActivityItem[]
  /** 加载中状态（显示骨架屏） */
  loading: boolean
  /** 加载失败标记（显示重试入口，点击触发 retry 事件） */
  loadError: boolean
}>()

/** 重试事件：由调用方重新拉取数据 */
const emit = defineEmits<{ retry: [] }>()

// 界面文案翻译（动态类型描述/失败与空态均随语言切换）
const { t } = useI18n()

/** 动态类型的图标映射 */
const kindIcon: Record<CnbActivityKind, string> = {
  commit: 'i-lucide-git-commit-horizontal',
  pull_request: 'i-lucide-git-pull-request',
  issue: 'i-lucide-circle-dot',
  code_review: 'i-lucide-eye',
  create_repo: 'i-lucide-folder-plus',
  join_group: 'i-lucide-users',
}

/** 动态类型的动作文案（count 为提交/PR 等的次数；复数由 vue-i18n 的 `|` 规则处理） */
function kindText(item: CnbActivityItem): string {
  switch (item.kind) {
    case 'commit':
      return t('notifications.pushedCommits', item.count)
    case 'pull_request':
      return t('notifications.pullRequest', item.count)
    case 'issue':
      return t('notifications.issue', item.count)
    case 'code_review':
      return t('notifications.codeReview', item.count)
    case 'create_repo':
      return t('notifications.createRepo')
    case 'join_group':
      return t('notifications.joinGroup')
  }
}

/** 是否有可展示的动态 */
const hasItems = computed(() => props.items.length > 0)

/** 在系统浏览器打开动态对应的仓库/组织页面（非 Tauri 环境兜底 window.open） */
function openTarget(path: string) {
  if (!path) {
    return
  }
  const url = `https://cnb.cool/${path}`
  if ('__TAURI_INTERNALS__' in window) {
    void openUrl(url)
  }
  else {
    window.open(url, '_blank')
  }
}
</script>

<template>
  <!-- 加载中：骨架屏 -->
  <div v-if="loading" class="flex flex-col gap-3">
    <USkeleton v-for="i in 5" :key="i" class="h-12 w-full rounded-md" />
  </div>

  <!-- 加载失败：提示 + 重试 -->
  <UAlert
    v-else-if="loadError"
    icon="i-lucide-cloud-alert"
    color="error"
    variant="soft"
    :title="t('notifications.loadFailedTitle')"
    :description="t('notifications.loadFailedDesc')"
  >
    <template #actions>
      <UButton
        size="sm"
        color="error"
        variant="soft"
        icon="i-lucide-refresh-cw"
        @click="emit('retry')"
      >
        {{ t('common.retry') }}
      </UButton>
    </template>
  </UAlert>

  <!-- 空态 -->
  <div v-else-if="!hasItems" class="flex flex-col items-center gap-2 py-12 text-center">
    <UIcon name="i-lucide-inbox" class="size-10 text-dimmed" />
    <p class="text-sm text-muted">
      {{ t('notifications.emptyTitle') }}
    </p>
    <p class="text-xs text-dimmed">
      {{ t('notifications.emptyDesc') }}
    </p>
  </div>

  <!-- 动态列表：点击在系统浏览器打开对应仓库/组织页 -->
  <div v-else class="flex flex-col gap-1">
    <button
      v-for="(item, index) in items"
      :key="`${item.kind}-${item.targetPath}-${index}`"
      type="button"
      class="w-full text-left px-3 py-2.5 rounded-md hover:bg-elevated/50 flex items-center gap-3 relative -mx-3 cursor-pointer"
      @click="openTarget(item.targetPath)"
    >
      <span class="size-8 shrink-0 rounded-full bg-elevated flex items-center justify-center">
        <UIcon :name="kindIcon[item.kind]" class="size-4 text-muted" />
      </span>

      <div class="text-sm flex-1 min-w-0">
        <p class="flex items-center justify-between gap-2">
          <span class="text-highlighted font-medium truncate">{{ item.targetPath }}</span>
          <time
            v-if="item.time"
            :datetime="item.time"
            class="text-muted text-xs shrink-0"
            v-text="formatTimeAgo(new Date(item.time))"
          />
        </p>
        <p class="text-dimmed">
          {{ kindText(item) }}
        </p>
      </div>
    </button>
  </div>
</template>
