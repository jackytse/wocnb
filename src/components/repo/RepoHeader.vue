<script setup lang="ts">
/**
 * 仓库详情头部（返回按钮 + 路径 + 可见性/语言徽标 + 元信息条 + 设置下拉 + 外跳）。
 *
 * 数据来自 GET /{repo}（useCnbRepo.fetchRepoDetail），缺失字段以 '-' 占位
 * 不报错（PRD P0-A2）。外跳按钮是所有深度页面的兜底出口。
 *
 * 本次增量（T03）：
 * - 右上「在浏览器打开」左侧新增设置下拉（编辑设置 / 归档 / 解除归档），
 *   仅 canManage（Master/Owner）可见 —— 写入口可见性预判，403 只作兜底；
 * - 归档态在标题旁显示归档徽标（detail.archived 单向下发，§8.5）。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { openUrl } from '@tauri-apps/plugin-opener'
import { visibilityBadge, repoSiteUrl, type RepoDetail } from '../../composables/useCnbRepo'
import { formatDateTime } from '../../utils'
import RepoSettingsDrawer from './RepoSettingsDrawer.vue'

const props = defineProps<{
  /** 仓库详情（加载中为 null，头部渲染骨架） */
  detail: RepoDetail | null
  loading: boolean
}>()

const emit = defineEmits<{
  /** 设置保存 / 归档状态变更成功（父页 loadRepo 重拉详情） */
  (e: 'updated'): void
}>()

const { t } = useI18n()

/** 仓库站点地址（外跳兜底出口） */
const siteUrl = computed(() => props.detail?.webUrl || repoSiteUrl(props.detail?.path || ''))

/** 语言色点颜色（缺失时用中性灰，与列表卡片一致） */
const langColor = computed(() => props.detail?.languageColor || '#8b949e')

/** 可见性徽标（共享实现，与仓库列表同源） */
const badge = computed(() => props.detail ? visibilityBadge(props.detail.visibility) : null)

/** 归档态：菜单里"归档"换为"解除归档" */
const archived = computed(() => !!props.detail?.archived)

/** 是否展示设置下拉：canManage 预判（Master/Owner），加载中不展示 */
const showSettings = computed(() => !!props.detail?.canManage)

/** 设置抽屉开关 */
const settingsOpen = ref(false)

/** 设置下拉条目（UDropdownMenu items；label 用函数保证语言热切换） */
const settingsItems = computed(() => [
  [{
    label: t('repo.settings.edit'),
    icon: 'i-lucide-settings',
    onSelect: () => {
      settingsOpen.value = true
    },
  }],
  [{
    label: archived.value ? t('repo.settings.unarchive') : t('repo.settings.archive'),
    icon: archived.value ? 'i-lucide-archive-restore' : 'i-lucide-archive',
    // 归档/解除归档在设置抽屉内完成（含 ConfirmDialog 二次确认）
    onSelect: () => {
      settingsOpen.value = true
    },
  }],
])

/** 在系统浏览器打开仓库页（非 Tauri 环境兜底 window.open） */
function openExternal() {
  const url = siteUrl.value
  if (!url) {
    return
  }
  if ('__TAURI_INTERNALS__' in window) {
    void openUrl(url)
  }
  else {
    window.open(url, '_blank')
  }
}
</script>

<template>
  <div class="mb-4">
    <!-- 加载中：头部骨架 -->
    <template v-if="loading || !detail">
      <div class="flex items-center gap-3">
        <USkeleton class="h-7 w-64 rounded-md" />
        <USkeleton class="h-5 w-14 rounded-full" />
      </div>
      <USkeleton class="h-4 w-96 mt-3 rounded-md" />
    </template>

    <template v-else>
      <!-- 第一行：路径 + 可见性 + 归档 + 语言 + 设置下拉 + 外跳 -->
      <div class="flex items-center gap-2 flex-wrap">
        <UIcon name="i-lucide-book-marked" class="size-5 text-muted shrink-0" />
        <h1 class="text-lg font-semibold text-highlighted truncate">
          {{ detail.path }}
        </h1>
        <UBadge
          v-if="badge"
          :color="badge.color"
          variant="subtle"
          size="sm"
          :label="badge.label"
        />
        <!-- 归档徽标（detail.archived 单向下发，§8.5） -->
        <UBadge
          v-if="detail.archived"
          color="warning"
          variant="subtle"
          size="sm"
          :label="t('repo.settings.archivedBadge')"
        />
        <span v-if="detail.language" class="inline-flex items-center gap-1 text-sm text-muted">
          <span class="size-2.5 rounded-full inline-block" :style="{ backgroundColor: langColor }" />
          {{ detail.language }}
        </span>
        <!-- 设置下拉：仅 Master/Owner 可见（写入口权限预判） -->
        <UDropdownMenu
          v-if="showSettings"
          :items="settingsItems"
          :content="{ align: 'end' }"
        >
          <UButton
            size="sm"
            color="neutral"
            variant="outline"
            icon="i-lucide-settings"
            :label="t('repo.settings.title')"
          />
        </UDropdownMenu>
        <!-- 外跳兜底：所有深度页面右上角保留"在浏览器打开"（PRD 7.2.6） -->
        <UButton
          class="ms-auto"
          size="sm"
          color="neutral"
          variant="outline"
          icon="i-lucide-external-link"
          :label="t('common.openInBrowser')"
          @click="openExternal"
        />
      </div>

      <!-- 第二行：描述 + 元信息条 -->
      <p v-if="detail.description" class="mt-1.5 text-sm text-muted line-clamp-2">
        {{ detail.description }}
      </p>
      <div class="mt-2 flex items-center gap-4 text-xs text-muted flex-wrap">
        <span class="inline-flex items-center gap-1">
          <UIcon name="i-lucide-star" class="size-3.5" />
          {{ detail.starCount }}
        </span>
        <span class="inline-flex items-center gap-1">
          <UIcon name="i-lucide-git-fork" class="size-3.5" />
          {{ detail.forkCount }}
        </span>
        <span class="inline-flex items-center gap-1">
          <UIcon name="i-lucide-circle-dot" class="size-3.5" />
          {{ detail.issueCount }}
        </span>
        <span class="inline-flex items-center gap-1">
          <UIcon name="i-lucide-git-pull-request" class="size-3.5" />
          {{ detail.prCount }}
        </span>
        <span v-if="detail.license" class="inline-flex items-center gap-1">
          <UIcon name="i-lucide-scale" class="size-3.5" />
          {{ detail.license }}
        </span>
        <span v-if="detail.updatedAt">
          {{ t('home.updatedAt', { time: formatDateTime(detail.updatedAt) }) }}
        </span>
      </div>
    </template>

    <!-- 设置抽屉（挂在头部组件内，保存/归档成功后向上冒泡 updated） -->
    <RepoSettingsDrawer
      v-model:open="settingsOpen"
      :detail="detail"
      @updated="emit('updated')"
    />
  </div>
</template>
