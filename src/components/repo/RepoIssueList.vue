<script setup lang="ts">
/**
 * Issue 列表（open/closed 两段切换 + 关键词搜索 + 分页）。
 *
 * 接口限制：GET /{repo}/-/issues 的 state 仅支持 open/closed 两值，
 * 界面按 PRD 拍板用两段切换控件（不提供"全部"）。
 * 新建入口：右上「新建 Issue」按钮（UModal 内联表单，成功跳新编号详情）。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  fetchRepoIssues,
  repoSiteUrl,
  type RepoIssue,
} from '../../composables/useCnbRepo'
import { useRepoRoute } from '../../composables/useRepoRoute'
import { formatRelativeTime } from '../../utils'
import StateAlert from './StateAlert.vue'
import NewIssueModal from './NewIssueModal.vue'

const props = defineProps<{
  repoPath: string
}>()

const { t } = useI18n()
const { state, keyword, page, setState, setKeyword, setPage, openIssue } = useRepoRoute()

const PAGE_SIZE = 30

/** 当前状态筛选（非法值归一 open；两段切换控件受控绑定） */
const currentState = computed<'open' | 'closed'>(() => state.value === 'closed' ? 'closed' : 'open')

/** 列表数据与加载状态 */
const issues = ref<RepoIssue[]>([])
const loading = ref(false)
const error = ref<Error | null>(null)
const hasNext = computed(() => issues.value.length >= PAGE_SIZE)

/** 关键词输入框的本地草稿（回车才写入 query，避免每击键发请求） */
const keywordDraft = ref(keyword.value)
watch(keyword, value => (keywordDraft.value = value))

async function load() {
  if (!props.repoPath) {
    return
  }
  loading.value = true
  error.value = null
  try {
    issues.value = await fetchRepoIssues(props.repoPath, {
      state: currentState.value,
      keyword: keyword.value || undefined,
      page: page.value,
      pageSize: PAGE_SIZE,
    })
  }
  catch (err) {
    issues.value = []
    error.value = err as Error
  }
  finally {
    loading.value = false
  }
}

// state/keyword/page/repoPath 任一变化重新加载（keyword 变化时 page 已被重置）
watch(
  () => `${props.repoPath}|${currentState.value}|${keyword.value}|${page.value}`,
  () => void load(),
  { immediate: true },
)

/** 关键词回车：写 query（replace + 重置页码） */
function onKeywordEnter() {
  setKeyword(keywordDraft.value.trim())
}

/** 空态区分：有关键词/筛选 → "无搜索结果"；否则 → "确实没有 Issue" */
const emptyText = computed(() =>
  keyword.value ? t('issues.emptyFiltered') : t('issues.empty'),
)

/** 新建 Issue 弹窗开关 */
const showNewIssue = ref(false)

/** 新建成功：跳转到新 Issue 详情（拿不到编号时由列表刷新兜底，见 NewIssueModal） */
function onCreated(number?: string) {
  showNewIssue.value = false
  if (number) {
    openIssue(number)
  }
  else {
    void load()
  }
}

const siteUrl = computed(() =>
  repoSiteUrl(props.repoPath,
    `/-/issues?state=${currentState.value}${keyword.value ? `&keyword=${encodeURIComponent(keyword.value)}` : ''}`),
)
</script>

<template>
  <div>
    <!-- 筛选条：状态两段切换 + 关键词搜索 + 新建按钮 -->
    <div class="flex items-center gap-2 flex-wrap mb-3">
      <!-- 两段切换（open/closed）：受控于 ?state=，切换 replace 且重置页码 -->
      <div class="inline-flex rounded-lg border border-default overflow-hidden">
        <button
          type="button"
          class="px-3 py-1.5 text-sm cursor-pointer"
          :class="currentState === 'open'
            ? 'bg-elevated text-highlighted font-medium'
            : 'text-muted hover:bg-elevated/50'"
          @click="setState('open')"
        >
          {{ t('issues.stateOpen') }}
        </button>
        <button
          type="button"
          class="px-3 py-1.5 text-sm cursor-pointer border-s border-default"
          :class="currentState === 'closed'
            ? 'bg-elevated text-highlighted font-medium'
            : 'text-muted hover:bg-elevated/50'"
          @click="setState('closed')"
        >
          {{ t('issues.stateClosed') }}
        </button>
      </div>

      <!-- 关键词搜索（回车触发，接口 keyword 为模糊匹配标题与内容） -->
      <UInput
        v-model="keywordDraft"
        size="sm"
        variant="soft"
        icon="i-lucide-search"
        :placeholder="t('issues.searchPlaceholder')"
        class="flex-1 min-w-48 max-w-sm"
        @keydown.enter="onKeywordEnter"
      />

      <UButton
        class="ms-auto"
        size="sm"
        icon="i-lucide-plus"
        :label="t('issues.newIssue')"
        @click="showNewIssue = true"
      />
    </div>

    <!-- 列表三态 -->
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
      v-else-if="issues.length === 0"
      state="empty"
      :empty-text="emptyText"
    />
    <div v-else class="flex flex-col border border-default rounded-lg divide-y divide-default overflow-hidden">
      <button
        v-for="issue in issues"
        :key="issue.number"
        type="button"
        class="flex items-center gap-3 px-4 py-3 text-left hover:bg-elevated/50 cursor-pointer"
        @click="openIssue(issue.number)"
      >
        <!-- 状态图标：open 绿点 / closed 紫勾（GitHub 语义） -->
        <UIcon
          :name="issue.state === 'open' ? 'i-lucide-circle-dot' : 'i-lucide-circle-check-big'"
          class="size-4 shrink-0"
          :class="issue.state === 'open' ? 'text-success' : 'text-purple-500'"
        />
        <div class="flex-1 min-w-0">
          <p class="text-sm text-highlighted truncate">
            {{ issue.title }}
            <span class="text-dimmed font-mono">#{{ issue.number }}</span>
          </p>
          <p class="mt-0.5 flex items-center gap-2 text-xs text-dimmed flex-wrap">
            <span>{{ t('issues.createdBy', { name: issue.authorName || '-', time: formatRelativeTime(issue.createdAt) }) }}</span>
            <UBadge
              v-if="issue.priority"
              color="warning"
              variant="subtle"
              size="sm"
              :label="issue.priority"
            />
            <UBadge
              v-for="label in issue.labels.slice(0, 3)"
              :key="label.name"
              variant="subtle"
              size="sm"
              :label="label.name"
              :style="label.color ? { color: label.color, backgroundColor: `${label.color}1a` } : undefined"
            />
            <span v-if="issue.assignees.length" class="truncate">
              {{ t('issues.assignees') }}: {{ issue.assignees.map(a => a.nickname).join(', ') }}
            </span>
          </p>
        </div>
        <!-- 评论数 -->
        <span v-if="issue.commentCount > 0" class="inline-flex items-center gap-1 text-xs text-dimmed shrink-0">
          <UIcon name="i-lucide-message-square" class="size-3.5" />
          {{ issue.commentCount }}
        </span>
      </button>
    </div>

    <!-- 分页 -->
    <div
      v-if="!loading && !error && issues.length > 0 && (page > 1 || hasNext)"
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

    <!-- 新建 Issue 弹窗 -->
    <NewIssueModal v-model:open="showNewIssue" :repo-path="repoPath" @created="onCreated" />
  </div>
</template>
