<script setup lang="ts">
/**
 * 通用评论区（Issue 与 PR 共用，PRD P0-B3/C5）。
 *
 * 交互约定：
 * - 空 content 禁用提交；提交中 loading + 禁用防重复；
 * - 成功：局部刷新评论列表（不整页 reload）+ 清空输入 + toast；
 * - 失败：保留草稿（不清空输入）+ toast 透出服务端 errmsg；
 * - 403（缺 repo-notes:rw）不登出，仅提示权限不足（红线）。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  fetchIssueComments,
  createIssueComment,
  fetchPullComments,
  createPullComment,
  type RepoComment,
} from '../../composables/useCnbRepo'
import MarkdownView from './MarkdownView.vue'
import { formatDateTime } from '../../utils'

const props = defineProps<{
  repoPath: string
  /** Issue / PR 编号 */
  number: string
  /** 资源类型（决定调用哪组端点） */
  kind: 'issues' | 'pulls'
}>()

const { t } = useI18n()
// useToast 为 Nuxt UI 全局自动导入（见 auto-imports.d.ts）
const toast = useToast()

/** 评论列表与加载状态 */
const comments = ref<RepoComment[]>([])
const loading = ref(false)
const error = ref<Error | null>(null)

/** 拉取评论列表（发表成功后的局部刷新也走这里） */
async function load() {
  if (!props.repoPath || !props.number) {
    return
  }
  loading.value = true
  error.value = null
  try {
    comments.value = props.kind === 'issues'
      ? await fetchIssueComments(props.repoPath, props.number)
      : await fetchPullComments(props.repoPath, props.number)
  }
  catch (err) {
    comments.value = []
    error.value = err as Error
  }
  finally {
    loading.value = false
  }
}

// 编号/仓库/类型变化（详情页切换目标）时重新加载
watch(
  () => `${props.repoPath}|${props.number}|${props.kind}`,
  () => void load(),
  { immediate: true },
)

// ---------------------------------------------------------------------------
// 发表评论
// ---------------------------------------------------------------------------

const draft = ref('')
/** 提交中标记（空内容禁用 + 提交中禁用，PRD 7.2.4） */
const submitting = ref(false)

const canSubmit = computed(() => draft.value.trim().length > 0 && !submitting.value)

async function submit() {
  if (!canSubmit.value) {
    return
  }
  const content = draft.value
  submitting.value = true
  try {
    // 按类型分派写端点（POST body 均为 { body }，经 Rust 通道透传）
    if (props.kind === 'issues') {
      await createIssueComment(props.repoPath, props.number, content)
    }
    else {
      await createPullComment(props.repoPath, props.number, content)
    }
    // 成功：清空草稿 + 局部刷新（不整页 reload）
    draft.value = ''
    toast.add({ title: t('issues.sendSuccess'), color: 'success', duration: 2000 })
    await load()
  }
  catch (err) {
    // 失败：保留草稿（draft 不动），透出服务端信息
    toast.add({
      title: t('issues.sendFailed'),
      description: (err as Error)?.message || '',
      color: 'error',
      duration: 5000,
    })
  }
  finally {
    submitting.value = false
  }
}
</script>

<template>
  <section class="flex flex-col gap-4">
    <h3 class="text-sm font-semibold text-highlighted flex items-center gap-2">
      <UIcon name="i-lucide-messages-square" class="size-4 text-muted" />
      {{ t('issues.comments') }}
      <UBadge
        v-if="comments.length"
        color="neutral"
        variant="subtle"
        size="sm"
        :label="String(comments.length)"
      />
    </h3>

    <!-- 加载骨架 / 失败重试 -->
    <div v-if="loading" class="flex flex-col gap-3">
      <div v-for="i in 2" :key="i" class="flex gap-3">
        <USkeleton class="size-8 rounded-full shrink-0" />
        <USkeleton class="h-16 flex-1 rounded-md" />
      </div>
    </div>
    <UAlert
      v-else-if="error"
      icon="i-lucide-cloud-alert"
      color="error"
      variant="soft"
      :title="t('state.error')"
      :description="t('state.errorDesc')"
    >
      <template #actions>
        <UButton
          size="sm"
          color="error"
          variant="soft"
          icon="i-lucide-refresh-cw"
          @click="load"
        >
          {{ t('common.retry') }}
        </UButton>
      </template>
    </UAlert>

    <p v-else-if="comments.length === 0" class="text-sm text-dimmed">
      {{ t('issues.commentsEmpty') }}
    </p>

    <!-- 评论列表 -->
    <div v-else class="flex flex-col gap-4">
      <article
        v-for="comment in comments"
        :key="comment.id"
        class="border border-default rounded-lg p-4"
      >
        <header class="flex items-center gap-2 mb-2 flex-wrap">
          <span class="text-sm font-medium text-highlighted">{{ comment.authorName || '-' }}</span>
          <time v-if="comment.createdAt" class="text-xs text-dimmed">{{ formatDateTime(comment.createdAt) }}</time>
        </header>
        <!-- 用户内容：一律经 DOMPurify 消毒渲染（安全红线，禁止 v-html 原始字段） -->
        <MarkdownView :source="comment.body" />
      </article>
    </div>

    <!-- 发表输入：失败保留草稿（draft 不清空），空内容禁用 -->
    <div class="border border-default rounded-lg p-3">
      <UTextarea
        v-model="draft"
        :rows="3"
        autoresize
        variant="none"
        :placeholder="t('issues.commentPlaceholder')"
        class="w-full"
      />
      <div class="flex justify-end mt-2">
        <UButton
          size="sm"
          :loading="submitting"
          :disabled="!canSubmit"
          icon="i-lucide-send"
          :label="submitting ? t('issues.sending') : t('issues.send')"
          @click="submit"
        />
      </div>
    </div>
  </section>
</template>
