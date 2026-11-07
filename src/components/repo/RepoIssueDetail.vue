<script setup lang="ts">
/**
 * Issue 详情（PRD P0-B2/B4/B5）。
 *
 * 组成：标题/状态/编号 → 正文 Markdown → 标签/处理人/优先级 →
 * 关闭/重开（二次确认，失败回滚 UI 状态）→ 动态时间线 → 评论区。
 * 数据并行加载：详情 + 评论 + 动态三个请求同时发出。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  fetchRepoIssue,
  fetchIssueActivities,
  updateIssueState,
  repoSiteUrl,
  type RepoIssue,
  type IssueActivity,
} from '../../composables/useCnbRepo'
import { useRepoRoute } from '../../composables/useRepoRoute'
import { formatDateTime } from '../../utils'
import StateAlert from './StateAlert.vue'
import MarkdownView from './MarkdownView.vue'
import CommentSection from './CommentSection.vue'
import IssueTimeline from './IssueTimeline.vue'

const props = defineProps<{
  repoPath: string
  number: string
}>()

const { t } = useI18n()
const toast = useToast()
const { backToList } = useRepoRoute()

// ---------------------------------------------------------------------------
// 数据加载（详情 / 动态并行；评论区内部自管）
// ---------------------------------------------------------------------------

const issue = ref<RepoIssue | null>(null)
const activities = ref<IssueActivity[]>([])
const loading = ref(false)
const error = ref<Error | null>(null)

async function load() {
  if (!props.repoPath || !props.number) {
    return
  }
  loading.value = true
  error.value = null
  try {
    // 详情与动态无依赖并行；动态失败不阻塞详情（activities 置空）
    const [detail, acts] = await Promise.all([
      fetchRepoIssue(props.repoPath, props.number),
      fetchIssueActivities(props.repoPath, props.number).catch(() => [] as IssueActivity[]),
    ])
    issue.value = detail
    activities.value = acts
  }
  catch (err) {
    issue.value = null
    error.value = err as Error
  }
  finally {
    loading.value = false
  }
}

watch(() => `${props.repoPath}|${props.number}`, () => void load(), { immediate: true })

/** 外跳兜底：cnb.cool 的 Issue 页 */
const siteUrl = computed(() => repoSiteUrl(props.repoPath, `/-/issues/${props.number}`))

// ---------------------------------------------------------------------------
// 关闭 / 重开（二次确认 + 失败回滚）
// ---------------------------------------------------------------------------

/** 确认弹窗开关与目标状态 */
const confirmState = ref<'open' | 'closed' | null>(null)
/** 状态变更提交中 */
const changingState = ref(false)

const confirmTitle = computed(() =>
  confirmState.value === 'closed' ? t('issues.closeConfirmTitle') : t('issues.reopenConfirmTitle'),
)
const confirmDesc = computed(() =>
  confirmState.value === 'closed'
    ? t('issues.closeConfirmDesc', { number: props.number, title: issue.value?.title || '' })
    : t('issues.reopenConfirmDesc', { number: props.number, title: issue.value?.title || '' }),
)

/**
 * 执行关闭/重开。
 * 为什么不乐观更新：接口可能 403（缺 repo-issue:rw）或冲突，失败时
 * 状态徽标回滚比"先改再撤"的实现更不易出错；成功后本地直接改 state
 * （局部刷新，不整页 reload）并重新拉取动态。
 */
async function doChangeState() {
  const target = confirmState.value
  if (!target || !issue.value || changingState.value) {
    return
  }
  changingState.value = true
  try {
    await updateIssueState(props.repoPath, props.number, target)
    issue.value = { ...issue.value, state: target }
    toast.add({
      title: target === 'closed' ? t('issues.closeSuccess') : t('issues.reopenSuccess'),
      color: 'success',
      duration: 2000,
    })
    // 状态变化会触发新的动态，静默重取（失败不打扰用户）
    fetchIssueActivities(props.repoPath, props.number)
      .then(acts => (activities.value = acts))
      .catch(() => {})
  }
  catch (err) {
    // 失败：状态徽标不变（无回滚动作，因为从未乐观更新），透出原因
    toast.add({
      title: t('issues.stateChangeFailed'),
      description: (err as Error)?.message || '',
      color: 'error',
      duration: 5000,
    })
  }
  finally {
    changingState.value = false
    confirmState.value = null
  }
}
</script>

<template>
  <div>
    <!-- 加载 / 错误三态 -->
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

    <template v-else-if="issue">
      <!-- 顶部：返回列表 + 状态徽标 -->
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
          :color="issue.state === 'open' ? 'success' : 'neutral'"
          variant="subtle"
          size="sm"
          :label="issue.state === 'open' ? t('issues.stateOpen') : t('issues.stateClosed')"
        />
        <UBadge
          v-if="issue.priority"
          color="warning"
          variant="subtle"
          size="sm"
          :label="`${t('issues.priority')}: ${issue.priority}`"
        />
        <!-- 关闭/重开按钮（按当前状态二选一，弹二次确认） -->
        <UButton
          class="ms-auto"
          size="xs"
          :color="issue.state === 'open' ? 'neutral' : 'success'"
          variant="outline"
          :icon="issue.state === 'open' ? 'i-lucide-circle-check-big' : 'i-lucide-rotate-ccw'"
          :label="issue.state === 'open' ? t('issues.close') : t('issues.reopen')"
          @click="confirmState = issue.state === 'open' ? 'closed' : 'open'"
        />
      </div>

      <!-- 标题 + 编号 + 作者/时间 -->
      <h2 class="text-xl font-semibold text-highlighted break-words">
        {{ issue.title }}
        <span class="text-dimmed font-mono text-base">#{{ issue.number }}</span>
      </h2>
      <p class="mt-1 text-xs text-muted">
        {{ t('issues.createdBy', { name: issue.authorName || '-', time: formatDateTime(issue.createdAt) }) }}
        <span v-if="issue.closedAt"> · {{ t('issues.closedBy', { name: issue.authorName || '-', time: formatDateTime(issue.closedAt) }) }}</span>
      </p>

      <!-- 标签 / 处理人 -->
      <div class="mt-3 flex items-center gap-2 flex-wrap text-xs">
        <UBadge
          v-for="label in issue.labels"
          :key="label.name"
          variant="subtle"
          size="sm"
          :label="label.name"
          :style="label.color ? { color: label.color, backgroundColor: `${label.color}1a` } : undefined"
        />
        <span v-if="issue.assignees.length" class="text-dimmed inline-flex items-center gap-1">
          <UIcon name="i-lucide-user-check" class="size-3.5" />
          {{ t('issues.assignees') }}:
          <span>{{ issue.assignees.map(a => a.nickname).join(', ') }}</span>
        </span>
      </div>

      <!-- 正文（Markdown 消毒渲染；空正文给占位文案）。
           ctx 传 null：Issue 正文图片多为 CNB 附件绝对地址，
           相对图片无可靠的 ref/dir 解析基准，不做本地化 -->
      <div class="mt-4 border border-default rounded-lg p-4">
        <MarkdownView
          v-if="issue.body"
          :source="issue.body"
        />
        <p v-else class="text-sm text-dimmed">
          {{ t('issues.bodyEmpty') }}
        </p>
      </div>

      <!-- 动态时间线 -->
      <div class="mt-6 border border-default rounded-lg p-4">
        <IssueTimeline :activities="activities" />
      </div>

      <!-- 评论区（局部自管加载与发表） -->
      <div class="mt-6">
        <CommentSection :repo-path="repoPath" :number="number" kind="issues" />
      </div>
    </template>

    <!-- 关闭/重开 二次确认弹窗（UModal，确认按钮用明确动词） -->
    <UModal
      :open="!!confirmState"
      :title="confirmTitle"
      @update:open="(value: boolean) => { if (!value) confirmState = null }"
    >
      <template #body>
        <p class="text-sm text-muted">
          {{ confirmDesc }}
        </p>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2 w-full">
          <UButton
            color="neutral"
            variant="ghost"
            :label="t('common.cancel')"
            @click="confirmState = null"
          />
          <UButton
            :color="confirmState === 'closed' ? 'error' : 'primary'"
            :loading="changingState"
            :label="confirmState === 'closed' ? t('issues.close') : t('issues.reopen')"
            @click="doChangeState"
          />
        </div>
      </template>
    </UModal>
  </div>
</template>
