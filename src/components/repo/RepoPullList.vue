<script setup lang="ts">
/**
 * PR 列表（state 筛选 open/closed/all + 分页，PRD P0-C1）。
 * 界面沿用 Issue 列表的条目样式；base←head 与评审数/评论数做次级信息。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  fetchRepoPulls,
  repoSiteUrl,
  type RepoPull,
} from '../../composables/useCnbRepo'
import { useRepoRoute } from '../../composables/useRepoRoute'
import { formatRelativeTime } from '../../utils'
import StateAlert from './StateAlert.vue'

const props = defineProps<{
  repoPath: string
}>()

const { t } = useI18n()
const { state, page, setState, setPage, openPull } = useRepoRoute()

const PAGE_SIZE = 30

/** 当前状态筛选（open/closed/all，非法值归一 open） */
const currentState = computed<'open' | 'closed' | 'all'>(() => {
  const value = state.value
  return value === 'closed' || value === 'all' ? value : 'open'
})

/** 状态切换选项（三段，与 Issue 两段不同） */
const stateOptions = computed(() => [
  { label: t('pulls.stateOpen'), value: 'open' },
  { label: t('pulls.stateClosed'), value: 'closed' },
  { label: t('pulls.stateAll'), value: 'all' },
])

const pulls = ref<RepoPull[]>([])
const loading = ref(false)
const error = ref<Error | null>(null)
const hasNext = computed(() => pulls.value.length >= PAGE_SIZE)

async function load() {
  if (!props.repoPath) {
    return
  }
  loading.value = true
  error.value = null
  try {
    pulls.value = await fetchRepoPulls(props.repoPath, {
      state: currentState.value,
      page: page.value,
      pageSize: PAGE_SIZE,
    })
  }
  catch (err) {
    pulls.value = []
    error.value = err as Error
  }
  finally {
    loading.value = false
  }
}

watch(() => `${props.repoPath}|${currentState.value}|${page.value}`, () => void load(), { immediate: true })

/** PR 状态图标与颜色：open 绿 / closed 红 / merged 紫（GitHub 语义） */
function stateMeta(pull: RepoPull): { icon: string, class: string } {
  if (pull.state === 'merged') {
    return { icon: 'i-lucide-git-merge', class: 'text-purple-500' }
  }
  if (pull.state === 'closed') {
    return { icon: 'i-lucide-git-pull-request-closed', class: 'text-error' }
  }
  return { icon: 'i-lucide-git-pull-request-arrow', class: 'text-success' }
}

const siteUrl = computed(() => repoSiteUrl(props.repoPath, `/-/pulls?state=${currentState.value}`))
</script>

<template>
  <div>
    <!-- 筛选条：state 三段切换 -->
    <div class="flex items-center gap-2 mb-3">
      <div class="inline-flex rounded-lg border border-default overflow-hidden">
        <button
          v-for="option in stateOptions"
          :key="option.value"
          type="button"
          class="px-3 py-1.5 text-sm cursor-pointer"
          :class="[
            option.value !== 'open' ? 'border-s border-default' : '',
            currentState === option.value
              ? 'bg-elevated text-highlighted font-medium'
              : 'text-muted hover:bg-elevated/50',
          ]"
          @click="setState(option.value)"
        >
          {{ option.label }}
        </button>
      </div>
    </div>

    <!-- 三态 -->
    <StateAlert
      v-if="loading"
      state="loading"
      loading-variant="list"
    />
    <StateAlert
      v-else-if="error"
      state="error"
      :error="error"
      :site-url="siteUrl"
      :retry="load"
    />
    <StateAlert
      v-else-if="pulls.length === 0"
      state="empty"
      :empty-text="t('pulls.empty')"
    />
    <div v-else class="flex flex-col border border-default rounded-lg divide-y divide-default overflow-hidden">
      <button
        v-for="pull in pulls"
        :key="pull.number"
        type="button"
        class="flex items-center gap-3 px-4 py-3 text-left hover:bg-elevated/50 cursor-pointer"
        @click="openPull(pull.number)"
      >
        <UIcon :name="stateMeta(pull).icon" class="size-4 shrink-0" :class="stateMeta(pull).class" />
        <div class="flex-1 min-w-0">
          <p class="text-sm text-highlighted truncate">
            {{ pull.title }}
            <span class="text-dimmed font-mono">#{{ pull.number }}</span>
          </p>
          <p class="mt-0.5 flex items-center gap-2 text-xs text-dimmed flex-wrap">
            <span class="font-mono">{{ t('pulls.baseHead', { base: pull.baseRef, head: pull.headRef }) }}</span>
            <UBadge
              v-if="pull.isWip"
              color="neutral"
              variant="subtle"
              size="sm"
              :label="t('pulls.draft')"
            />
            <UBadge
              v-for="label in pull.labels.slice(0, 3)"
              :key="label.name"
              variant="subtle"
              size="sm"
              :label="label.name"
              :style="label.color ? { color: label.color, backgroundColor: `${label.color}1a` } : undefined"
            />
          </p>
        </div>
        <span class="text-xs text-dimmed shrink-0">
          {{ formatRelativeTime(pull.updatedAt) }}
        </span>
        <span v-if="pull.commentCount > 0" class="inline-flex items-center gap-1 text-xs text-dimmed shrink-0">
          <UIcon name="i-lucide-message-square" class="size-3.5" />
          {{ pull.commentCount }}
        </span>
      </button>
    </div>

    <!-- 分页 -->
    <div
      v-if="!loading && !error && pulls.length > 0 && (page > 1 || hasNext)"
      class="flex items-center justify-center gap-3 mt-4"
    >
      <UButton
        size="sm"
        color="neutral"
        variant="outline"
        icon="i-lucide-arrow-left"
        :disabled="page <= 1"
        @click="setPage(page - 1)"
      >
        {{ t('common.prevPage') }}
      </UButton>
      <span class="text-xs text-dimmed">{{ t('common.pageInfo', { page }) }}</span>
      <UButton
        size="sm"
        color="neutral"
        variant="outline"
        trailing-icon="i-lucide-arrow-right"
        :disabled="!hasNext"
        @click="setPage(page + 1)"
      >
        {{ t('common.nextPage') }}
      </UButton>
    </div>
  </div>
</template>
