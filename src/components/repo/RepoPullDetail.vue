<script setup lang="ts">
/**
 * PR 详情（PRD P0-C2/C3/C4/C5 + P1 合并；REQ-05 扩展为可编辑）。
 *
 * 组成：标题/状态/草稿徽标 → base←head + mergeable_state → 描述 →
 * **CI 状态徽标区（新增）** → 评审人状态 → **处理人区（新增）** →
 * 提交列表 → 变更文件 diff → 评论区 → 合并入口（P1）。
 *
 * 数据并行加载：详情 / 文件 / 提交 / CI 状态 / 处理人 同时发出；
 * 文件/提交/CI/处理人失败各自降级对应区块（403 缺 repo-pr:r 时 CI 区块
 * StateAlert 呈现，不影响 PR 主体），只有详情失败才整页报错。
 *
 * REQ-05 新增写入口（canManage 预判，403 只兜底）：
 * - 顶部「编辑」→ UModal（标题 / 正文）→ updatePull（PATCH 有 body → cnbFetch）。
 *   目标分支不可编辑：swagger api.PatchPullRequest 无 base 字段（仅新建时可指定）；
 * - 处理人区 USelectMenu creatable（当前用户 + 已有处理人 + 手输用户名）+ canAssignPull 校验，
 *   增删走 setPullAssignees / removePullAssignees（均有 body → cnbFetch）；
 * - **CI 徽标复用 CommitStatusBadge + commitStatusMeta GitLab 六态独立映射，
 *   禁止复用构建四态**（踩坑#5）；新建分支选择由 CreatePullModal 的
 *   RepoBranchSelect selectMode='emit' 承担（不写 ?ref=）。
 */
import { computed, reactive, ref, watch } from 'vue'
import { SCOPE_REPO_NOTES, SCOPE_REPO_PR, useScopeGate } from '../../composables/useCnbWriteGate'
import { useI18n } from 'vue-i18n'
import {
  canAssignPull,
  fetchPullCommitStatuses,
  fetchRepoPull,
  fetchPullFiles,
  fetchPullCommits,
  listPullAssignees,
  removePullAssignees,
  repoSiteUrl,
  setPullAssignees,
  updatePull,
  type CommitStatusResult,
  type RepoDetail,
  type RepoLabel,
  type RepoPull,
  type RepoUser,
  type PullFile,
  type CommitItem,
} from '../../composables/useCnbRepo'
import { cnbUser } from '../../composables/useCnbAuth'
// PR 标签五端点在 useCnbPullReviews（与评审同域）：list 读 / PUT 整体覆盖写；
// diffLabelSelection 是保存前的差分纯函数（无变化不发请求）
import {
  diffLabelSelection,
  listPullLabels,
  setPullLabels,
} from '../../composables/useCnbPullReviews'
// 标签字典与 Issue 侧共用 listRepoLabels（同一份数据源，避免两处漂移）
import { listRepoLabels } from '../../composables/useCnbRepoLabels'
import { useRepoRoute } from '../../composables/useRepoRoute'
import { formatDateTime } from '../../utils'
import StateAlert from './StateAlert.vue'
import MarkdownView from './MarkdownView.vue'
import PullDiffView from './PullDiffView.vue'
import CommentSection from './CommentSection.vue'
import MergePullModal from './MergePullModal.vue'
import CommitStatusBadge from './CommitStatusBadge.vue'
import PullReviewPanel from './PullReviewPanel.vue'
import { useAppToast } from '../../composables/useAppToast'

const props = defineProps<{
  repoPath: string
  number: string
  /** 仓库详情：写入口按 canManage 预判（repo-pr:rw），归档时禁用 */
  detail?: RepoDetail | null
}>()

const { t } = useI18n()
const { backToList } = useRepoRoute()
const toast = useAppToast()

/** 是否可编辑（Master/Owner 单点预判，403 只作兜底） */
const canManage = computed(() => !!props.detail?.canManage)

/**
 * scope 闸（令牌维度，与 canManage 角色维度正交）：
 * - prScope：编辑/合并/标签/处理人（repo-pr:rw）；
 * - notesScope：评论与评审提交（repo-notes:rw，与 PR 本体不同 scope）。
 */
const prScope = useScopeGate(SCOPE_REPO_PR)
const notesScope = useScopeGate(SCOPE_REPO_NOTES)
/** 评论区可见性 = 角色 + 令牌双预判（评论写端点 repo-notes:rw） */
const canComment = computed(() => canManage.value && !notesScope.denied.value)
const archived = computed(() => !!props.detail?.archived)

// ---------------------------------------------------------------------------
// 数据加载（详情为主，文件/提交/CI/处理人并行降级）
// ---------------------------------------------------------------------------

const pull = ref<RepoPull | null>(null)
const files = ref<PullFile[]>([])
const commits = ref<CommitItem[]>([])
/** PR 处理人（详情接口不返回 assignees，走独立端点） */
const pullAssignees = ref<RepoUser[]>([])
/** PR 标签（详情接口不返回 labels，走 GET /pulls/{n}/labels 独立端点） */
const pullLabels = ref<RepoLabel[]>([])
/** PR 维度 CI 状态（无记录时 state='' → CommitStatusBadge 不渲染） */
const ciStatus = ref<CommitStatusResult | null>(null)
const ciError = ref<Error | null>(null)
const loading = ref(false)
const error = ref<Error | null>(null)

async function load() {
  if (!props.repoPath || !props.number) {
    return
  }
  loading.value = true
  error.value = null
  ciError.value = null
  try {
    // 详情必成（失败整页报错）；文件/提交/CI/处理人/标签失败降级各自区块；
    // 评论由 CommentSection 组件内部自管（避免重复请求）
    const [detail, f, c, assignees, labels, ci] = await Promise.all([
      fetchRepoPull(props.repoPath, props.number),
      fetchPullFiles(props.repoPath, props.number).catch(() => []),
      fetchPullCommits(props.repoPath, props.number).catch(() => []),
      listPullAssignees(props.repoPath, props.number).catch(() => [] as RepoUser[]),
      // 标签读取失败（403 缺 repo-pr:r 等）降级为空列表：区块显示"暂无标签"
      listPullLabels(props.repoPath, props.number).catch(() => [] as RepoLabel[]),
      fetchPullCommitStatuses(props.repoPath, props.number)
        .catch((err: unknown) => {
          ciError.value = err as Error
          return null
        }),
    ])
    pull.value = detail
    files.value = f
    commits.value = c
    pullAssignees.value = assignees
    pullLabels.value = labels
    ciStatus.value = ci
    // ci=null 时 ciError 已由上面的 .catch() 写入（缺 repo-pr:r → 区块级 StateAlert 降级）
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

/** 评审状态徽标色（pending 中性 / approved 绿 / changes_requested 红）—— 既有只读区保留 */
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
// 编辑 PR（REQ-05）：UModal 表单 → PATCH /pulls/{n}（200 有 body → cnbFetch）
// ---------------------------------------------------------------------------

const editOpen = ref(false)
/**
 * 编辑表单字段说明：swagger api.PatchPullRequest 仅支持 title/body/state，
 * **不含 base（目标分支）**——已核对 .workbuddy/context/cnb-swagger.json。
 * 因此编辑弹窗只提供标题与正文；目标分支只能在新建时选择（api.PullCreationForm
 * 有 base 字段）。这是设计文档 UI 描述与 swagger 的冲突，按 swagger + §5.2
 * updatePull 签名（patch 无 base）实现，避免向服务端提交未声明字段。
 */
const editForm = reactive({ title: '', body: '' })
const editing = ref(false)

function openEdit() {
  const current = pull.value
  if (!current) {
    return
  }
  editForm.title = current.title
  editForm.body = current.body || ''
  editOpen.value = true
}

const editTitleError = computed(() => {
  const len = editForm.title.trim().length
  if (len < 2) {
    return t('repo.pulls.titleRequired')
  }
  if (len > 255) {
    return t('repo.pulls.titleTooLong')
  }
  return null
})

async function onSubmitEdit() {
  if (editTitleError.value || editing.value) {
    return
  }
  editing.value = true
  try {
    await updatePull(props.repoPath, props.number, {
      title: editForm.title.trim(),
      body: editForm.body,
    })
    toast.add({ title: t('repo.pulls.editSuccess'), color: 'success', duration: 2500 })
    editOpen.value = false
    await load() // 写后重拉详情（§8.4）
  }
  catch (err) {
    toast.add({
      title: t('repo.pulls.editFailed'),
      description: (err as Error)?.message || '',
      color: 'error',
      duration: 6000,
    })
  }
  finally {
    editing.value = false
  }
}

// ---------------------------------------------------------------------------
// 处理人编辑（REQ-05）：creatable + canAssignPull 校验 + 差分写
// ---------------------------------------------------------------------------

const assigneeEditOpen = ref(false)
const assigneeDraft = ref<string[]>([])
const assigneeOptions = computed(() => {
  const names = [cnbUser.value?.username || '', ...pullAssignees.value.map(a => a.username)]
  return [...new Set(names)].filter(Boolean)
})
const assigneeError = ref('')
const savingAssignees = ref(false)
const ASSIGNEE_LIMIT = 8

function openAssigneeEdit() {
  assigneeDraft.value = pullAssignees.value.map(a => a.username)
  assigneeError.value = ''
  assigneeEditOpen.value = true
}

async function saveAssignees() {
  assigneeError.value = ''
  if (assigneeDraft.value.length > ASSIGNEE_LIMIT) {
    assigneeError.value = t('repo.pulls.assigneeLimit', { max: ASSIGNEE_LIMIT })
    return
  }
  const original = pullAssignees.value.map(a => a.username)
  const added = assigneeDraft.value.filter(name => !original.includes(name))
  const removed = original.filter(name => !assigneeDraft.value.includes(name))

  // 提交前逐个校验可分配性（404→false；500 抛出，不静默吞）
  for (const username of added) {
    let assignable = false
    try {
      assignable = await canAssignPull(props.repoPath, props.number, username)
    }
    catch (err) {
      toast.add({
        title: t('repo.pulls.checkFailed'),
        description: (err as Error)?.message || '',
        color: 'error',
        duration: 6000,
      })
      return
    }
    if (!assignable) {
      assigneeError.value = t('repo.pulls.assigneeNotAllowed', { username })
      return
    }
  }
  if (added.length === 0 && removed.length === 0) {
    assigneeEditOpen.value = false
    return
  }
  savingAssignees.value = true
  try {
    if (added.length) {
      // POST /assignees：201 api.Pull（有 body）→ cnbFetch
      await setPullAssignees(props.repoPath, props.number, added)
    }
    if (removed.length) {
      // DELETE /assignees：200 api.Pull（有 body）→ cnbFetch
      await removePullAssignees(props.repoPath, props.number, removed)
    }
    toast.add({ title: t('repo.pulls.saveSuccess'), color: 'success', duration: 2000 })
    assigneeEditOpen.value = false
    await load()
  }
  catch (err) {
    toast.add({
      title: t('repo.pulls.saveFailed'),
      description: (err as Error)?.message || '',
      color: 'error',
      duration: 6000,
    })
  }
  finally {
    savingAssignees.value = false
  }
}

// ---------------------------------------------------------------------------
// 标签编辑（QA 批次 2 遗留①）：标签展示 + canManage 编辑入口
// ---------------------------------------------------------------------------

/**
 * 交互与 Issue 标签同范式：编辑器用仓库标签字典（listRepoLabels，与 Issue
 * 标签管理共用数据源）；保存走 **PUT 整体覆盖**（setPullLabels 的
 * api.PutPullLabelsForm.labels 是"最终列表"语义），一次写同时完成增与删，
 * 因此保存前用 diffLabelSelection 判断无变化就不发请求。
 */
const labelEditOpen = ref(false)
/** 编辑草稿（已选标签名列表；打开时回填当前标签） */
const labelDraft = ref<string[]>([])
/** 仓库标签字典（候选源；失败降级空列表，仅影响候选不影响已选展示） */
const labelOptions = ref<RepoLabel[]>([])
const labelOptionsLoading = ref(false)
const savingLabels = ref(false)

/** 打开编辑器：回填当前标签并拉取字典（字典已在本会话加载过则复用） */
async function openLabelEdit() {
  labelDraft.value = pullLabels.value.map(label => label.name)
  labelEditOpen.value = true
  if (labelOptions.value.length === 0 && !labelOptionsLoading.value) {
    labelOptionsLoading.value = true
    try {
      labelOptions.value = await listRepoLabels(props.repoPath)
    }
    catch {
      // 字典拉取失败：候选为空，编辑器内给出"去 Issue 标签管理创建"的提示
      labelOptions.value = []
    }
    finally {
      labelOptionsLoading.value = false
    }
  }
}

/** 保存标签：差分为零直接关闭；否则 PUT 整体覆盖为草稿列表 */
async function saveLabels() {
  if (savingLabels.value) {
    return
  }
  const original = pullLabels.value.map(label => label.name)
  const { added, removed } = diffLabelSelection(original, labelDraft.value)
  if (added.length === 0 && removed.length === 0) {
    // 无变化：不发请求（避免空写触发服务端校验与无意义刷新）
    labelEditOpen.value = false
    return
  }
  savingLabels.value = true
  try {
    // PUT /pulls/{n}/labels：200 api.Label（有 body）→ 数据层 cnbFetch；
    // body 是"最终列表"——增删在同一次写里生效（而非 POST/DELETE 组合）
    await setPullLabels(props.repoPath, props.number, labelDraft.value)
    toast.add({ title: t('repo.pulls.saveSuccess'), color: 'success', duration: 2000 })
    labelEditOpen.value = false
    await load() // 写后重拉（§8.4）：标签区与详情保持一致
  }
  catch (err) {
    toast.add({
      title: t('repo.pulls.saveFailed'),
      description: (err as Error)?.message || '',
      color: 'error',
      duration: 6000,
    })
  }
  finally {
    savingLabels.value = false
  }
}

// ---------------------------------------------------------------------------
// 合并（P1）
// ---------------------------------------------------------------------------

const showMergeModal = ref(false)

/**
 * 是否可合并：open 且非 WIP **且 canManage**。
 * canManage 是后补的（repo-pr:rw 事前预判）：合并是写操作，原来只判状态，
 * 任何访客都能看到合并按钮、点了就 403 —— 与本页其他写入口红线统一。
 * 服务端冲突校验仍然兜底（canManage ≠ 一定能合并）。
 */
const canMerge = computed(() =>
  canManage.value
  && !prScope.denied.value
  && pull.value?.state === 'open'
  && !pull.value.isWip,
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
      <!-- 顶部：返回 + 状态徽标 + 草稿 + 编辑/合并入口 -->
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
        <!-- 编辑 PR（PATCH /pulls/{n} = repo-pr:rw）：角色 + scope 闸双预判 -->
        <UButton
          v-if="canManage && !prScope.denied.value"
          size="xs"
          color="neutral"
          variant="soft"
          icon="i-lucide-pencil"
          :label="t('repo.pulls.edit')"
          :disabled="archived"
          class="ms-auto"
          @click="openEdit"
        />
        <!-- 合并入口（P1）：open 且非 WIP 才展示 -->
        <UButton
          v-if="canMerge"
          size="xs"
          :class="canManage ? '' : 'ms-auto'"
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

      <!-- 标签行（QA 批次 2 遗留①）：只读展示；canManage 时给编辑入口（不可管理不渲染，事前隐藏） -->
      <div class="mt-2 flex items-center gap-2 flex-wrap">
        <!-- 标签：改用 LabelChip（原先"中性徽标 + 色圆点"与 Issue 页样式不一致，
             且浅色标签点上浮在白底上几乎看不出颜色） -->
        <LabelChip
          v-for="label in pullLabels"
          :key="label.name"
          :name="label.name"
          :color="label.color"
        />
        <span v-if="pullLabels.length === 0" class="text-xs text-dimmed">
          {{ t('repo.pulls.labelsEmpty') }}
        </span>
        <UButton
          v-if="canManage && !prScope.denied.value"
          size="xs"
          color="neutral"
          variant="ghost"
          icon="i-lucide-tags"
          :label="t('repo.pulls.editLabels')"
          :disabled="archived"
          @click="openLabelEdit"
        />
      </div>
      <!-- mergeable_state 非干净态说明 -->
      <UAlert
        v-if="mergeableText"
        icon="i-lucide-git-merge"
        color="neutral"
        variant="soft"
        :title="mergeableText"
        class="mt-3"
      />

      <!-- CI 状态徽标区（REQ-05）：GitLab 六态独立映射 + hover 明细；403 区块降级 -->
      <div class="mt-4 border border-default rounded-lg p-4">
        <h3 class="text-sm font-semibold text-highlighted mb-2 flex items-center gap-2">
          <UIcon name="i-lucide-circle-check-big" class="size-4 text-muted" />
          {{ t('repo.pulls.ciStatus') }}
        </h3>
        <StateAlert
          v-if="ciError"
          state="error"
          :error="ciError"
          :site-url="siteUrl"
          :retry="load"
        />
        <div v-else class="flex items-center gap-2 flex-wrap">
          <CommitStatusBadge :status="ciStatus" />
          <span v-if="!ciStatus?.state" class="text-xs text-dimmed">
            {{ t('repo.pulls.ciEmpty') }}
          </span>
        </div>
      </div>

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

      <!-- 评审人状态（P1 评审区挂点前的只读概览，保留既有验收通过的 UI） -->
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

      <!-- 评审区（批次 2 · REQ-10）：评审正文 + 行级评论树 + 评审人/回复管理。
           只读概览保留在上方，这里是"详细评审"的补充（设计 §3.4 决策）。
           canEdit：PR 处于 open 且当前用户可管理（归档/关闭后不再允许评审）。 -->
      <PullReviewPanel
        :repo-path="repoPath"
        :number="number"
        :can-edit="canManage && !notesScope.denied.value && !archived && pull.state === 'open'"
      />

      <!-- 处理人区（REQ-05）：canManage 预判，写后重拉 -->
      <div class="mt-4 border border-default rounded-lg p-4">
        <h3 class="text-sm font-semibold text-highlighted mb-2 flex items-center gap-2">
          <UIcon name="i-lucide-user-round-check" class="size-4 text-muted" />
          {{ t('repo.pulls.assignees') }}
          <UButton
            v-if="canManage && !prScope.denied.value"
            size="xs"
            color="neutral"
            variant="ghost"
            icon="i-lucide-pencil"
            :label="t('repo.pulls.editAssignees')"
            class="ms-auto"
            :disabled="archived"
            @click="openAssigneeEdit"
          />
        </h3>
        <p v-if="pullAssignees.length" class="text-sm text-muted flex flex-wrap gap-2">
          <span v-for="user in pullAssignees" :key="user.username">{{ user.nickname }}</span>
        </p>
        <p v-else class="text-xs text-dimmed">
          {{ t('repo.pulls.assigneesEmpty') }}
        </p>
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
        <CommentSection
          :repo-path="repoPath"
          :number="number"
          kind="pulls"
          :can-manage="canComment"
        />
      </div>

      <!-- 合并确认弹窗（P1） -->
      <MergePullModal
        v-model:open="showMergeModal"
        :pull="pull"
        :repo-path="repoPath"
        @merged="onMerged"
      />
    </template>

    <!-- 编辑 PR 弹窗 -->
    <UModal
      v-model:open="editOpen"
      :title="t('repo.pulls.edit')"
      :ui="{ content: 'max-w-2xl' }"
    >
      <template #body>
        <div class="flex flex-col gap-4">
          <UFormField :label="t('repo.pulls.titleLabel')" required :error="editTitleError ?? undefined">
            <UInput v-model="editForm.title" class="w-full" autocomplete="off" />
          </UFormField>
          <!-- 目标分支不可编辑：swagger api.PatchPullRequest 无 base 字段（见脚本注释） -->
          <UFormField :label="t('repo.pulls.body')">
            <UTextarea
              v-model="editForm.body"
              class="w-full"
              :rows="5"
              autoresize
            />
          </UFormField>
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2 w-full">
          <UButton
            color="neutral"
            variant="ghost"
            :label="t('common.cancel')"
            @click="editOpen = false"
          />
          <UButton
            color="primary"
            :loading="editing"
            :disabled="!!editTitleError"
            :label="t('common.save')"
            @click="onSubmitEdit"
          />
        </div>
      </template>
    </UModal>

    <!-- 处理人编辑弹窗（creatable 手输 + canAssignPull 校验） -->
    <UModal
      v-model:open="assigneeEditOpen"
      :title="t('repo.pulls.editAssignees')"
      :ui="{ content: 'max-w-lg' }"
    >
      <template #body>
        <div class="flex flex-col gap-3">
          <USelectMenu
            v-model="assigneeDraft"
            :items="assigneeOptions"
            multiple
            create-item
            :placeholder="t('repo.pulls.selectAssignees')"
            class="w-full"
          />
          <p class="text-xs text-dimmed">
            {{ t('repo.pulls.assigneeHint', { max: ASSIGNEE_LIMIT }) }}
          </p>
          <UAlert
            v-if="assigneeError"
            color="error"
            variant="soft"
            icon="i-lucide-circle-alert"
            :title="assigneeError"
          />
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2 w-full">
          <UButton
            color="neutral"
            variant="ghost"
            :label="t('common.cancel')"
            @click="assigneeEditOpen = false"
          />
          <UButton
            color="primary"
            :loading="savingAssignees"
            :label="t('common.save')"
            @click="saveAssignees"
          />
        </div>
      </template>
    </UModal>
    <!-- 标签编辑弹窗（字典多选 + PUT 整体覆盖保存） -->
    <UModal
      v-model:open="labelEditOpen"
      :title="t('repo.pulls.editLabels')"
      :ui="{ content: 'max-w-lg' }"
    >
      <template #body>
        <div class="flex flex-col gap-3">
          <!-- 候选为仓库标签字典（与 Issue 标签管理同一数据源）；字典为空时提示先去创建 -->
          <StateAlert
            v-if="labelOptionsLoading"
            state="loading"
            loading-variant="plain"
          />
          <template v-else>
            <USelectMenu
              v-model="labelDraft"
              :items="labelOptions"
              value-key="name"
              label-key="name"
              multiple
              :placeholder="t('repo.pulls.selectLabels')"
              class="w-full"
            />
            <p v-if="labelOptions.length === 0" class="text-xs text-dimmed">
              {{ t('repo.pulls.labelsDictEmpty') }}
            </p>
            <p v-else class="text-xs text-dimmed">
              {{ t('repo.pulls.labelsHint') }}
            </p>
          </template>
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2 w-full">
          <UButton
            color="neutral"
            variant="ghost"
            :label="t('common.cancel')"
            @click="labelEditOpen = false"
          />
          <UButton
            color="primary"
            :loading="savingLabels"
            :label="t('common.save')"
            @click="saveLabels"
          />
        </div>
      </template>
    </UModal>
  </div>
</template>
