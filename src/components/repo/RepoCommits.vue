<script setup lang="ts">
/**
 * 提交历史视图（分页列表 + 提交详情展开，PRD P0-A8/A9）。
 *
 * - 列表：GET /-/git/commits?sha=<ref>&page=（短 SHA / 标题 / 作者 / 时间）；
 * - 详情：?sha= 存在时请求 GET /-/git/commits/{sha} 展示完整 message、
 *   作者与父提交（父提交 SHA 可点跳转；首个提交不显示父提交区）；
 * - 分页：page 写回 query（replace），pageSize 30，末页以返回条数判断。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  fetchRepoCommit,
  fetchRepoCommits,
  repoSiteUrl,
  type CommitItem,
} from '../../composables/useCnbRepo'
import { useRepoRoute } from '../../composables/useRepoRoute'
import { formatDateTime } from '../../utils'
import StateAlert from './StateAlert.vue'

const props = defineProps<{
  repoPath: string
  /** 当前生效 ref（?ref= 或默认分支名） */
  gitRef: string
}>()

const { t } = useI18n()
const { page, sha, setPage, openCommit, backToList } = useRepoRoute()

const PAGE_SIZE = 30

/** 提交列表与加载状态 */
const commits = ref<CommitItem[]>([])
const loading = ref(false)
const error = ref<Error | null>(null)
/** 是否还有下一页（返回满页视为可能还有，允许试翻） */
const hasNext = computed(() => commits.value.length >= PAGE_SIZE)

async function load() {
  if (!props.repoPath) {
    return
  }
  loading.value = true
  error.value = null
  try {
    commits.value = await fetchRepoCommits(props.repoPath, {
      ref: props.gitRef || undefined,
      page: page.value,
      pageSize: PAGE_SIZE,
    })
  }
  catch (err) {
    commits.value = []
    error.value = err as Error
  }
  finally {
    loading.value = false
  }
}

// ref 或页码变化重新加载；ref 变化时由 useRepoRoute.switchRef 清 sha
watch(() => `${props.repoPath}|${props.gitRef}|${page.value}`, () => void load(), { immediate: true })

// ---------------------------------------------------------------------------
// 提交详情（?sha= 展开）
// ---------------------------------------------------------------------------

const detail = ref<CommitItem | null>(null)
const detailLoading = ref(false)
const detailError = ref<Error | null>(null)

async function loadDetail() {
  detail.value = null
  detailError.value = null
  if (!sha.value || !props.repoPath) {
    return
  }
  detailLoading.value = true
  try {
    detail.value = await fetchRepoCommit(props.repoPath, sha.value)
  }
  catch (err) {
    detailError.value = err as Error
  }
  finally {
    detailLoading.value = false
  }
}

watch(() => `${props.repoPath}|${sha.value}`, () => void loadDetail(), { immediate: true })

/** 短 SHA（7 位，GitHub 惯例） */
function shortSha(value: string): string {
  return value.slice(0, 7)
}

/** 提交站点页地址（外跳兜底） */
const siteUrl = computed(() =>
  sha.value
    ? repoSiteUrl(props.repoPath, `/-/commit/${sha.value}`)
    : repoSiteUrl(props.repoPath, '/-/commits'),
)
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- 提交详情（?sha= 展开）：面包屑式返回列表 -->
    <div v-if="sha" class="border border-default rounded-lg p-4">
      <div class="flex items-center gap-2 mb-3">
        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          icon="i-lucide-arrow-left"
          :label="t('state.backToList')"
          @click="backToList"
        />
        <UBadge
          color="neutral"
          variant="subtle"
          size="sm"
          :label="shortSha(sha)"
          class="font-mono"
        />
      </div>

      <StateAlert
        v-if="detailLoading"
        state="loading"
        loading-variant="detail"
      />
      <StateAlert
        v-else-if="detailError"
        state="error"
        :error="detailError"
        :site-url="siteUrl"
        :retry="loadDetail"
        @back="backToList"
      />
      <template v-else-if="detail">
        <h3 class="text-sm font-semibold text-highlighted break-words">
          {{ detail.title }}
        </h3>
        <p class="mt-1 text-xs text-muted">
          {{ t('repo.commits.author') }}: {{ detail.authorName || '-' }}
          <span v-if="detail.authorTime"> · {{ formatDateTime(detail.authorTime) }}</span>
        </p>
        <!-- 完整提交信息（多行保留空白） -->
        <pre
          v-if="detail.message"
          class="mt-3 text-xs text-muted whitespace-pre-wrap font-mono bg-elevated/40 rounded-md p-3"
        >{{ detail.message }}</pre>
        <!-- 父提交区：首个提交（无父提交）不显示，改为提示文案 -->
        <div v-if="detail.parents.length > 0" class="mt-3 flex items-center gap-2 flex-wrap">
          <span class="text-xs text-dimmed">{{ t('repo.commits.parents') }}:</span>
          <UButton
            v-for="parent in detail.parents"
            :key="parent.sha"
            size="xs"
            color="neutral"
            variant="soft"
            class="font-mono"
            :label="shortSha(parent.sha)"
            :title="t('repo.commits.openParent')"
            @click="openCommit(parent.sha)"
          />
        </div>
        <p v-else class="mt-3 text-xs text-dimmed">
          {{ t('repo.commits.noParent') }}
        </p>
      </template>
    </div>

    <!-- 列表 -->
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
      v-else-if="commits.length === 0"
      state="empty"
      :empty-text="t('repo.commits.empty')"
      :empty-desc="t('repo.commits.emptyDesc')"
    />
    <div v-else class="flex flex-col border border-default rounded-lg divide-y divide-default overflow-hidden">
      <button
        v-for="commit in commits"
        :key="commit.sha"
        type="button"
        class="flex items-center gap-3 px-4 py-2.5 text-left hover:bg-elevated/50 cursor-pointer"
        :class="commit.sha === sha ? 'bg-elevated/60' : ''"
        @click="openCommit(commit.sha)"
      >
        <UIcon name="i-lucide-git-commit-horizontal" class="size-4 text-muted shrink-0" />
        <span class="text-sm text-highlighted truncate flex-1">{{ commit.title }}</span>
        <span class="text-xs text-dimmed shrink-0 hidden sm:inline">{{ commit.authorName }}</span>
        <time
          v-if="commit.authorTime"
          :datetime="commit.authorTime"
          class="text-xs text-dimmed shrink-0"
        >{{ formatDateTime(commit.authorTime) }}</time>
        <UBadge
          color="neutral"
          variant="subtle"
          size="sm"
          :label="shortSha(commit.sha)"
          class="font-mono shrink-0"
        />
      </button>
    </div>

    <!-- 分页：前进 / 后退（replace 写回 ?page=） -->
    <div v-if="!loading && !error && (page > 1 || hasNext)" class="flex items-center justify-center gap-3">
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
