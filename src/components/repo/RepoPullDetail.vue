<script setup lang="ts">
/**
 * PR 详情（PRD P0-C2/C3/C4/C5 + P1 合并）。
 *
 * 组成：标题/状态/草稿徽标 → base←head + mergeable_state 说明 → 描述 →
 * 评审人状态 → 提交列表 → 变更文件 diff → 评论区 → 合并入口（P1）。
 * 数据并行加载：详情 / 文件 / 提交 / 评论四请求同时发出（评论失败不阻塞）。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  fetchRepoPull,
  fetchPullFiles,
  fetchPullCommits,
  repoSiteUrl,
  type RepoPull,
  type PullFile,
  type CommitItem,
} from '../../composables/useCnbRepo'
import { useRepoRoute } from '../../composables/useRepoRoute'
import { formatDateTime } from '../../utils'
import StateAlert from './StateAlert.vue'
import MarkdownView from './MarkdownView.vue'
import PullDiffView from './PullDiffView.vue'
import CommentSection from './CommentSection.vue'
import MergePullModal from './MergePullModal.vue'

const props = defineProps<{
  repoPath: string
  number: string
}>()

const { t } = useI18n()
const { backToList } = useRepoRoute()

// ---------------------------------------------------------------------------
// 数据加载（详情为主，文件/提交/评论并行降级）
// ---------------------------------------------------------------------------

const pull = ref<RepoPull | null>(null)
const files = ref<PullFile[]>([])
const commits = ref<CommitItem[]>([])
const loading = ref(false)
const error = ref<Error | null>(null)

async function load() {
  if (!props.repoPath || !props.number) {
    return
  }
  loading.value = true
  error.value = null
  try {
    // 详情必成（失败整页报错）；文件/提交失败降级为对应区块空态；
    // 评论由 CommentSection 组件内部自管（避免重复请求）
    const [detail, f, c] = await Promise.all([
      fetchRepoPull(props.repoPath, props.number),
      fetchPullFiles(props.repoPath, props.number).catch(() => []),
      fetchPullCommits(props.repoPath, props.number).catch(() => []),
    ])
    pull.value = detail
    files.value = f
    commits.value = c
  }
  catch (err) {
    pull.value = null
    error.value = err as Error
  }
  finally {
    loading.value = false
  }
}

watch(() => `${props.repoPath}|${props.number}`, () => void load(), { immediate: true })

const siteUrl = computed(() => repoSiteUrl(props.repoPath, `/-/pulls/${props.number}`))

// ---------------------------------------------------------------------------
// 状态展示
// ---------------------------------------------------------------------------

/** PR 状态徽标（merged 用 info 紫；Nuxt UI 无原生 purple 语义色） */
const stateBadge = computed(() => {
  const value = pull.value?.state
  if (value === 'merged') {
    return { color: 'info' as const, label: t('pulls.merged') }
  }
  if (value === 'closed') {
    return { color: 'error' as const, label: t('pulls.stateClosed') }
  }
  return { color: 'success' as const, label: t('pulls.stateOpen') }
})

/** mergeable_state 的人类可读说明（非干净态特别提示，PRD P0-C2） */
const mergeableText = computed(() => {
  const value = pull.value?.mergeableState
  if (!value || value === 'mergeable') {
    return ''
  }
  return t(`pulls.mergeableState.${value}`)
})

/** 评审状态徽标色（pending 中性 / approved 绿 / changes_requested 红） */
function reviewColor(state: string): 'neutral' | 'success' | 'error' | 'warning' {
  switch (state) {
    case 'approved':
      return 'success'
    case 'changes_requested':
      return 'error'
    case 'commented':
      return 'warning'
    default:
      return 'neutral'
  }
}

// ---------------------------------------------------------------------------
// 合并（P1）
// ---------------------------------------------------------------------------

const showMergeModal = ref(false)

/** 是否可合并（仅 open 且非 WIP 时给入口；服务端仍会校验冲突） */
const canMerge = computed(() =>
  pull.value?.state === 'open' && !pull.value.isWip,
)

/** 合并成功：关闭弹窗 + 重载详情（状态变 merged、动态刷新） */
function onMerged() {
  void load()
}
</script>

<template>
  <div>
    <StateAlert
      v-if="loading"
      state="loading"
      loading-variant="detail"
    />
    <StateAlert
      v-else-if="error"
      state="error"
      :error="error"
      :site-url="siteUrl"
      :retry="load"
      @back="backToList"
    />

    <template v-else-if="pull">
      <!-- 顶部：返回 + 状态徽标 + 草稿 + 合并入口 -->
      <div class="flex items-center gap-2 mb-3 flex-wrap">
        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          icon="i-lucide-arrow-left"
          :label="t('state.backToList')"
          @click="backToList"
        />
        <UBadge
          :color="stateBadge.color"
          variant="subtle"
          size="sm"
          :label="stateBadge.label"
        />
        <UBadge
          v-if="pull.isWip"
          color="neutral"
          variant="subtle"
          size="sm"
          :label="t('pulls.draft')"
        />
        <!-- 合并入口（P1）：open 且非 WIP 才展示 -->
        <UButton
          v-if="canMerge"
          class="ms-auto"
          size="xs"
          color="primary"
          variant="outline"
          icon="i-lucide-git-merge"
          :label="t('pulls.merge')"
          @click="showMergeModal = true"
        />
      </div>

      <!-- 标题 + base←head -->
      <h2 class="text-xl font-semibold text-highlighted break-words">
        {{ pull.title }}
        <span class="text-dimmed font-mono text-base">#{{ pull.number }}</span>
      </h2>
      <p class="mt-1 text-xs text-muted flex items-center gap-2 flex-wrap">
        <span class="font-mono">{{ t('pulls.baseHead', { base: pull.baseRef, head: pull.headRef }) }}</span>
        <span>· {{ pull.authorName || '-' }}</span>
        <time v-if="pull.createdAt">· {{ formatDateTime(pull.createdAt) }}</time>
      </p>
      <!-- mergeable_state 非干净态说明 -->
      <UAlert
        v-if="mergeableText"
        icon="i-lucide-git-merge"
        color="neutral"
        variant="soft"
        :title="mergeableText"
        class="mt-3"
      />

      <!-- 描述（ctx 传 null：PR 描述图片多为附件绝对地址，不做相对路径本地化） -->
      <div class="mt-4 border border-default rounded-lg p-4">
        <MarkdownView
          v-if="pull.body"
          :source="pull.body"
        />
        <p v-else class="text-sm text-dimmed">
          {{ t('pulls.bodyEmpty') }}
        </p>
      </div>

      <!-- 评审人状态 -->
      <div v-if="pull.reviewers.length" class="mt-4 border border-default rounded-lg p-4">
        <h3 class="text-sm font-semibold text-highlighted mb-2 flex items-center gap-2">
          <UIcon name="i-lucide-user-check" class="size-4 text-muted" />
          {{ t('pulls.reviewers') }}
        </h3>
        <div class="flex flex-wrap gap-2">
          <span
            v-for="reviewer in pull.reviewers"
            :key="reviewer.username"
            class="inline-flex items-center gap-1.5 text-xs"
          >
            <span class="text-muted">{{ reviewer.nickname }}</span>
            <UBadge
              :color="reviewColor(reviewer.reviewState)"
              variant="subtle"
              size="sm"
              :label="t(`pulls.reviewState.${reviewer.reviewState}`)"
            />
          </span>
        </div>
      </div>

      <!-- 提交列表 -->
      <div v-if="commits.length" class="mt-4 border border-default rounded-lg divide-y divide-default overflow-hidden">
        <div
          v-for="commit in commits"
          :key="commit.sha"
          class="flex items-center gap-3 px-4 py-2 text-sm"
        >
          <UIcon name="i-lucide-git-commit-horizontal" class="size-4 text-muted shrink-0" />
          <span class="text-highlighted truncate flex-1">{{ commit.title }}</span>
          <span class="text-xs text-dimmed shrink-0">{{ commit.authorName }}</span>
          <UBadge
            color="neutral"
            variant="subtle"
            size="sm"
            :label="commit.sha.slice(0, 7)"
            class="font-mono shrink-0"
          />
        </div>
      </div>

      <!-- 变更文件 diff -->
      <div v-if="files.length" class="mt-4">
        <h3 class="text-sm font-semibold text-highlighted mb-2 flex items-center gap-2">
          <UIcon name="i-lucide-file-diff" class="size-4 text-muted" />
          {{ t('pulls.files') }}
          <UBadge
            color="neutral"
            variant="subtle"
            size="sm"
            :label="String(files.length)"
          />
        </h3>
        <PullDiffView :files="files" />
      </div>

      <!-- 评论区（Issue/PR 共用组件；加载成功的评论由组件内刷新，这里传入服务端初始数据无必要） -->
      <div class="mt-6">
        <CommentSection :repo-path="repoPath" :number="number" kind="pulls" />
      </div>

      <!-- 合并确认弹窗（P1） -->
      <MergePullModal
        v-model:open="showMergeModal"
        :pull="pull"
        :repo-path="repoPath"
        @merged="onMerged"
      />
    </template>
  </div>
</template>
