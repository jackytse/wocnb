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
// Vue 组合式 API 与 i18n
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
// 数据层：Issue/PR 两组评论端点（读列表/读单条/新建/编辑），按 kind 分派
import {
  fetchIssueComment,
  updateIssueComment,
  fetchIssueComments,
  createIssueComment,
  fetchPullComments,
  createPullComment,
  type RepoComment,
} from '../../composables/useCnbRepo'
// 当前登录用户（编辑权限判断："只允许编辑自己发的评论"）
import { cnbUser } from '../../composables/useCnbAuth'
// 用户内容统一走 DOMPurify 消毒渲染（安全红线）
import MarkdownView from './MarkdownView.vue'
import { formatDateTime } from '../../utils'
import { useAppToast } from '../../composables/useAppToast'

const props = defineProps<{
  /** 仓库完整路径（org/repo） */
  repoPath: string
  /** Issue / PR 编号 */
  number: string
  /** 资源类型（决定调用哪组端点） */
  kind: 'issues' | 'pulls'
  /**
   * 是否可发表评论（canManage 预判）：评论是写操作（repo-notes:rw），
   * 令牌缺授权范围时提交必 403 —— 无权限时不渲染输入框，改为说明文案
   * 引导到 CNB 网页端（读评论不受影响，列表照常展示）。
   */
  canManage?: boolean
}>()

const { t } = useI18n()
// useToast 为 Nuxt UI 全局自动导入（见 auto-imports.d.ts）
const toast = useAppToast()

/** 评论列表与加载状态 */
const comments = ref<RepoComment[]>([]) // 归一化后的评论列表
const loading = ref(false) // 列表加载中（渲染骨架屏）
const error = ref<Error | null>(null) // 列表加载失败（错误条 + 重试）

/** 拉取评论列表（发表成功后的局部刷新也走这里） */
async function load() {
  // 路径/编号未就绪：不发请求（详情页切换的瞬间）
  if (!props.repoPath || !props.number) {
    return
  }
  loading.value = true // 列表骨架屏
  error.value = null
  try {
    // 按类型分派读端点：Issue 与 PR 的评论是两组不同端点
    comments.value = props.kind === 'issues'
      ? await fetchIssueComments(props.repoPath, props.number)
      : await fetchPullComments(props.repoPath, props.number)
  }
  catch (err) {
    // 失败：清列表 + 记错误（错误条重试走回本函数）
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
  { immediate: true }, // 挂载即加载（详情页评论区常驻）
)

// ---------------------------------------------------------------------------
// 发表评论
// ---------------------------------------------------------------------------

const draft = ref('') // 评论草稿（失败保留不清空）
/** 提交中标记（空内容禁用 + 提交中禁用，PRD 7.2.4） */
const submitting = ref(false)

/** 可提交 = 有内容且不在提交中（按钮 disabled 的数据源） */
const canSubmit = computed(() => draft.value.trim().length > 0 && !submitting.value)
async function submit() {
  // 不可提交（空内容/重复点击）：直接返回
  if (!canSubmit.value) {
    return
  }
  const content = draft.value // 先取快照：失败后草稿保留原值
  submitting.value = true // 防重复提交（按钮 loading）
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
    await load() // 局部重拉评论列表
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

// ---------------------------------------------------------------------------
// 评论编辑（批次 2 · REQ-09）
//
// 仅 Issue 评论支持编辑（PATCH /issues/{n}/comments/{id}）；PR 评论单条 PATCH
// 属 P2 backlog，本组件在 kind='pulls' 时不渲染编辑入口，避免发到未实现端点。
// 只允许编辑**自己发的**评论（服务端也按作者校验，前端事前隐藏更友好）。
// ---------------------------------------------------------------------------

/** 当前登录用户名（用于判断"是否自己的评论"） */
const currentUsername = computed(() => cnbUser.value?.username || '')

/** 该评论是否可编辑：Issue + 作者是自己 + 非提交中 */
function canEditComment(comment: RepoComment): boolean {
  // 三个条件缺一不可：PR 评论无编辑端点；非本人评论服务端也会拒
  return props.kind === 'issues'
    && !!currentUsername.value
    && comment.authorUsername === currentUsername.value
}

/** 正在编辑的评论 id（空串 = 没有编辑态） */
const editingId = ref('')
/** 编辑草稿 */
const editDraft = ref('')
const editSaving = ref(false) // 保存请求进行中
const editError = ref('') // 拉最新正文失败 / 保存失败的行内提示

/**
 * 进入编辑态：先 GET 单条拿最新正文（列表快照可能已过期，
 * 直接用旧值保存会覆盖他人修改）。
 */
async function startEdit(comment: RepoComment) {
  editingId.value = comment.id
  editDraft.value = comment.body // 先用列表值展示，最新值到达后覆盖
  editError.value = ''
  try {
    const latest = await fetchIssueComment(props.repoPath, props.number, comment.id)
    editDraft.value = latest.body // 以服务端最新正文为准
  }
  catch (err) {
    // 拉最新失败不阻塞：仍可用列表里的正文编辑，但要告知可能存在延迟
    editError.value = (err as Error)?.message || ''
  }
}

/** 取消编辑：清空态与草稿 */
function cancelEdit() {
  editingId.value = ''
  editDraft.value = ''
  editError.value = ''
}

/**
 * 保存编辑：成功后原地替换该条正文（不整页重拉）；
 * 失败保留编辑态与草稿，让用户改完再试（与发表评论同一交互约定）。
 */
async function saveEdit(comment: RepoComment) {
  const body = editDraft.value
  // 空正文 / 已在保存中：直接返回
  if (!body.trim() || editSaving.value) {
    return
  }
  editSaving.value = true
  editError.value = ''
  try {
    const updated = await updateIssueComment(props.repoPath, props.number, comment.id, body)
    // 原地更新：保留原条目位置，替换正文与更新时间
    comments.value = comments.value.map(item =>
      item.id === comment.id
        ? { ...item, body: updated.body || body, updatedAt: updated.updatedAt || item.updatedAt }
        : item,
    )
    editingId.value = ''
    // key 用 repo.issues.*：与 issue 其它提示同族（issues.* 顶层命名空间不存在，
    // 曾因写成 issues.editSuccess 导致 toast 直接显示原始键名）
    toast.add({ title: t('repo.issues.editSuccess'), color: 'success', duration: 2000 })
  }
  catch (err) {
    editError.value = (err as Error)?.message || ''
    toast.add({
      title: t('repo.issues.editFailed'),
      description: editError.value,
      color: 'error',
      duration: 5000,
    })
  }
  finally {
    editSaving.value = false
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
          <!-- 编辑入口：仅自己的 Issue 评论（事后隐藏优于事后报 403） -->
          <UButton
            v-if="canEditComment(comment) && editingId !== comment.id"
            size="xs"
            color="neutral"
            variant="ghost"
            icon="i-lucide-pencil"
            class="ms-auto"
            :aria-label="t('common.edit')"
            @click="startEdit(comment)"
          />
        </header>

        <!-- 编辑态：行内 textarea + 保存/取消；失败保留输入并内联报错 -->
        <div v-if="editingId === comment.id" class="flex flex-col gap-2">
          <UTextarea
            v-model="editDraft"
            :rows="4"
            autoresize
            class="w-full"
          />
          <p v-if="editError" class="text-xs text-error">
            {{ editError }}
          </p>
          <div class="flex justify-end gap-2">
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              :label="t('common.cancel')"
              @click="cancelEdit"
            />
            <UButton
              size="xs"
              color="primary"
              :loading="editSaving"
              :disabled="!editDraft.trim()"
              :label="t('common.save')"
              @click="saveEdit(comment)"
            />
          </div>
        </div>
        <!-- 用户内容：一律经 DOMPurify 消毒渲染（安全红线，禁止 v-html 原始字段） -->
        <!-- ctx 传 { repoPath }：评论里的根相对附件链接（/-/files/...）
             需要仓库前缀才能改写为可访问的 cnb.cool 绝对地址（wav 白屏
             修复的链接改写依赖它）；ref 缺省 → 图片不本地化 -->
        <MarkdownView
          v-else
          :source="comment.body"
          :ctx="{ repoPath }"
        />
      </article>
    </div>

    <!-- 发表输入：失败保留草稿（draft 不清空），空内容禁用。
         canManage 事前预判：无权限（令牌缺 repo-notes:rw）时不渲染输入框，
         改为说明文案引导网页端 —— 点了提交才吃 403 的体验不可接受 -->
    <div v-if="canManage" class="border border-default rounded-lg p-3">
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
    <p v-else class="flex items-center gap-1.5 text-xs text-dimmed px-1">
      <UIcon name="i-lucide-lock" class="size-3.5 shrink-0" />
      {{ t('issues.commentNoPerm') }}
    </p>
  </section>
</template>
