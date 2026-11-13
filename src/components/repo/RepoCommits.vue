<script setup lang="ts">
/**
 * 提交历史视图（分页列表 + 提交详情展开，PRD P0-A8/A9）。
 *
 * - 列表：GET /-/git/commits?sha=<ref>&page=（短 SHA / 标题 / 作者 / 时间）；
 * - 详情：?sha= 存在时请求 GET /-/git/commits/{sha} 展示完整 message、
 *   作者与父提交（父提交 SHA 可点跳转；首个提交不显示父提交区）；
 * - 分页：page 写回 query（replace），pageSize 30，末页以返回条数判断。
 *
 * CI 状态徽标（T10）：**懒加载** —— 列表渲染时不为每行立即请求
 * commit-statuses，行进入视口（IntersectionObserver，rootMargin 预取
 * 100px）才拉取；结果缓存 Map<sha, CommitStatusResult>（组件生命周期内
 * 翻页/切 ref 不重复拉取，sha 全局唯一所以缓存跨 ref 安全）；
 * 单行失败静默跳过（徽标不渲染），绝不打断列表本身。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  fetchCommitStatuses,
  fetchRepoCommit,
  fetchRepoCommits,
  repoSiteUrl,
  type CommitItem,
  type CommitStatusResult,
} from '../../composables/useCnbRepo'
import { useRepoRoute } from '../../composables/useRepoRoute'
import { formatDateTime } from '../../utils'
import StateAlert from './StateAlert.vue'
import CommitStatusBadge from './CommitStatusBadge.vue'
import RepoCompare from './RepoCompare.vue'

const props = defineProps<{
  repoPath: string
  /** 当前生效 ref（?ref= 或默认分支名） */
  gitRef: string
}>()

const { t } = useI18n()
const { page, sha, compare, setPage, openCommit, openCompare, backToList } = useRepoRoute()

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
// CI 状态懒加载（T10 验收 1）：IntersectionObserver + Map 缓存 + 并发 4
// ---------------------------------------------------------------------------

/** 状态缓存：key=sha，null=拉取中/失败（徽标不渲染），其余为已加载结果 */
const statusMap = ref<Record<string, CommitStatusResult | null>>({})

/** 待拉取队列与并发控制（翻页瞬时进入视口的行可能一次排入几十个） */
const STATUS_CONCURRENCY = 4
const statusQueue: string[] = []
const statusQueued = new Set<string>()
let statusActive = 0

/** 单个 sha 的状态拉取：失败静默（记 null，徽标不渲染），不重试不打断 */
function requestCommitStatus(targetSha: string) {
  // 已缓存（含失败过的 null）或已在队列：跳过 —— 每个提交至多请求一次
  if (targetSha in statusMap.value || statusQueued.has(targetSha)) {
    return
  }
  statusQueued.add(targetSha)
  statusQueue.push(targetSha)
  pumpStatusQueue()
}

/** 队列泵：并发上限 4，出队立即补位（防止首页 30 行 + 预取一次性 30 连发） */
function pumpStatusQueue() {
  while (statusActive < STATUS_CONCURRENCY && statusQueue.length > 0) {
    const targetSha = statusQueue.shift()
    if (!targetSha) {
      break
    }
    statusActive++
    fetchCommitStatuses(props.repoPath, targetSha)
      .then((result) => {
        statusMap.value[targetSha] = result
      })
      .catch(() => {
        // 403（缺 repo-code:r）/404（无 CI）/网络错误：静默，徽标不渲染
        statusMap.value[targetSha] = null
      })
      .finally(() => {
        statusQueued.delete(targetSha)
        statusActive--
        pumpStatusQueue()
      })
  }
}

/** IntersectionObserver 实例（组件生命周期内单例，行卸载时逐个 unobserve） */
let statusObserver: IntersectionObserver | null = null

/** 行进入视口 → 入队拉取并停止观察该行（只拉一次） */
function onRowsIntersect(entries: IntersectionObserverEntry[]) {
  for (const entry of entries) {
    if (!entry.isIntersecting) {
      continue
    }
    const rowSha = (entry.target as HTMLElement).getAttribute('data-status-sha')
    if (rowSha) {
      requestCommitStatus(rowSha)
    }
    statusObserver?.unobserve(entry.target)
  }
}

/** 模板 :ref 回调：注册行元素到观察器（sha 写入 data 属性供回调读取） */
function registerStatusRow(rowSha: string) {
  return (el: unknown) => {
    const element = el as Element | null
    if (!element || !statusObserver) {
      return
    }
    element.setAttribute('data-status-sha', rowSha)
    statusObserver.observe(element)
  }
}

onMounted(() => {
  // SSR/老 WebView 防御：IO 不存在时徽标保持不渲染（列表功能不受影响）
  if (typeof IntersectionObserver === 'undefined') {
    return
  }
  statusObserver = new IntersectionObserver(onRowsIntersect, { rootMargin: '100px' })
})

onBeforeUnmount(() => {
  statusObserver?.disconnect()
  statusObserver = null
})

/** 提交详情的 CI 状态（复用同一缓存） */
const detailStatus = computed(() => (sha.value ? statusMap.value[sha.value] ?? null : null))

// 详情展开的 sha 可能不在当前分页（未进入观察器）—— 显式拉取一次
watch(detailStatus, (value) => {
  if (!value && sha.value) {
    requestCommitStatus(sha.value)
  }
}, { immediate: true })

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
    <!-- 提交比较视图（?compare=1 下钻，T11）：替换列表/详情 -->
    <RepoCompare
      v-if="compare"
      :repo-path="repoPath"
      :git-ref="gitRef"
    />

    <template v-else>
      <!-- 比较入口（T11）：仅在列表视图显示 -->
      <div
        v-if="!sha"
        class="flex justify-end"
      >
        <UButton
          size="sm"
          color="neutral"
          variant="outline"
          icon="i-lucide-git-compare"
          :label="t('repo.compare.title')"
          @click="openCompare"
        />
      </div>

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
          <div class="flex items-center gap-2 flex-wrap">
            <h3 class="text-sm font-semibold text-highlighted break-words">
              {{ detail.title }}
            </h3>
            <CommitStatusBadge :status="detailStatus" />
          </div>
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
          :ref="registerStatusRow(commit.sha)"
          type="button"
          class="flex items-center gap-3 px-4 py-2.5 text-left hover:bg-elevated/50 cursor-pointer"
          :class="commit.sha === sha ? 'bg-elevated/60' : ''"
          @click="openCommit(commit.sha)"
        >
          <UIcon name="i-lucide-git-commit-horizontal" class="size-4 text-muted shrink-0" />
          <span class="text-sm text-highlighted truncate flex-1">{{ commit.title }}</span>
          <CommitStatusBadge :status="statusMap[commit.sha] ?? null" />
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
    </template>
  </div>
</template>
