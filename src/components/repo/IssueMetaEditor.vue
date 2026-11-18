<script setup lang="ts">
/**
 * Issue 标签 / 处理人编辑器（REQ-04 / T05）。
 *
 * 由 RepoIssueDetail 侧栏「编辑」按钮以 UModal 挂载。P0 阶段处理人候选源按
 * 主理人 Q3 裁决：当前登录用户 + 已有处理人 + USelectMenu 的 create-item
 * 手动输入用户名，提交前逐个 canAssignIssue 校验（P1 仓库成员端点落地后
 * 可把候选源替换为成员列表）。
 *
 * 写后一致性（§8.4）：任一写成功后 emit('updated')，由 RepoIssueDetail 调
 * 本页 load() 重拉详情，保证侧栏与服务端一致（不跨组件 provide/inject）。
 * 所有写端点通道按 §8.2 逐条选择（见各函数注释）。
 */
// 数据层：Issue 标签 / 处理人写端点（各函数注释标明通道依据 §8.2）
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
// Issue 标签差分写（add/remove 集合）与处理人可分配性探测（canAssignIssue）
import {
  addIssueLabels,
  canAssignIssue,
  removeIssueAssignees,
  removeIssueLabels,
  setIssueAssignees,
  type RepoLabel,
  type RepoUser,
} from '../../composables/useCnbRepo'
// 仓库标签字典（与 RepoLabelManager 共用数据源，避免两处漂移）
import { listRepoLabels } from '../../composables/useCnbRepoLabels'
// 当前登录用户（处理人候选之一；未登录时由父级隐藏本入口）
import { cnbUser } from '../../composables/useCnbAuth'
import StateAlert from './StateAlert.vue'

const props = defineProps<{
  /** 仓库完整路径（org/repo，路径编码由数据层负责） */
  repoPath: string
  /** Issue 编号（路径段，数据层负责编码） */
  number: string
  /** 当前 Issue 标签（已归一化） */
  labels: RepoLabel[]
  /** 当前 Issue 处理人（已归一化） */
  assignees: RepoUser[]
}>()

const emit = defineEmits<{
  /** 任一写成功：父组件重拉详情保证侧栏一致（§8.4 写后重拉） */
  (e: 'updated'): void
  /** 关闭回调（预留） */
  (e: 'close'): void
}>()

// i18n 文案与全局 toast（成功提示 / 失败透出服务端原因）
const { t } = useI18n()
const toast = useToast()

/** 标签字典（仓库全部可选标签，与 Issue 列表标签管理共用数据源） */
const labelOptions = ref<RepoLabel[]>([])
/** 字典加载中（下拉骨架/禁用态） */
const labelLoading = ref(false)
/** 字典加载异常（可重试，不阻塞处理人编辑） */
const labelError = ref<Error | null>(null)
/** 已选标签名（camelCase 值，USelectMenu value-key=name） */
const selectedLabels = ref<string[]>(props.labels.map(l => l.name)) // 回填服务端当前值

/** 处理人候选：当前用户 + 已有处理人（去重）；create-item 允许手输其他用户名 */
const assigneeOptions = computed(() => {
  // 候选并集：当前登录用户 + Issue 已有处理人（两者可能重叠，需去重）
  const names = [cnbUser.value?.username || '', ...props.assignees.map(a => a.username)]
  return [...new Set(names)].filter(Boolean) // Set 去重 + 剔除空串（未登录兜底）
})
/** 已选处理人用户名 */
const selectedAssignees = ref<string[]>(props.assignees.map(a => a.username)) // 回填服务端当前值

/** 上限（swagger api.IssueDetail 描述：处理人 8 / 标签 10），超限前端先拦截 */
const ASSIGNEE_LIMIT = 8 // 处理人数量上限
const LABEL_LIMIT = 10 // 标签数量上限

/** 行内错误（数量超限 / 可分配性校验失败等，标签与处理人两个区块共用） */
const inlineError = ref('') // 保存前校验失败时呈现（toast 不适合此类即时提示）
const submitting = ref(false) // 处理人保存进行中（按钮 loading，防重复提交）

// 仓库或 Issue 变化：已选集合同步重置（服务端最新值），并懒加载标签字典
watch(
  () => `${props.repoPath}|${props.number}`,
  () => {
    selectedLabels.value = props.labels.map(l => l.name) // 回填服务端最新标签
    selectedAssignees.value = props.assignees.map(a => a.username) // 回填最新处理人
    void loadLabels()
  },
  { immediate: true }, // 首次挂载即加载（弹窗打开即呈现数据）
)

/** 拉取仓库标签字典（数据源与 RepoLabelManager 共用 listRepoLabels） */
async function loadLabels() {
  // 仓库路径为空：无从请求，直接跳过
  if (!props.repoPath) {
    return
  }
  labelLoading.value = true
  labelError.value = null
  try {
    labelOptions.value = await listRepoLabels(props.repoPath)
  }
  catch (err) {
    // 字典加载失败不阻塞弹窗：报错态可重试，处理人编辑不受影响
    labelOptions.value = []
    labelError.value = err as Error
  }
  finally {
    labelLoading.value = false
  }
}

/**
 * 保存标签：先做数量上限预校验（BUG-05：超过 10 个在提交前拦截，避免服务端
 * 400），再差分提交（新增 addIssueLabels / 移除 removeIssueLabels 集合 Void）。
 */
async function saveLabels() {
  // 先清上次的行内错误（每次保存独立校验，不残留旧提示）
  inlineError.value = ''
  if (selectedLabels.value.length > LABEL_LIMIT) {
    // 数量超限：前端先拦（BUG-05），不发请求
    inlineError.value = t('repo.issues.labelLimit', { max: LABEL_LIMIT })
    return
  }
  const original = props.labels.map(l => l.name)
  const added = selectedLabels.value.filter(name => !original.includes(name)) // 新增项
  const removed = original.filter(name => !selectedLabels.value.includes(name)) // 移除项
  if (added.length === 0 && removed.length === 0) {
    // 无差分：不发请求（避免空写触发服务端不必要的校验）
    return
  }
  try {
    if (added.length) {
      // POST /labels：200 api.Label（有 body）→ 数据层 cnbFetch
      await addIssueLabels(props.repoPath, props.number, added)
    }
    if (removed.length) {
      // DELETE /labels（集合）：204 空 body → 数据层 cnbFetchVoid
      await removeIssueLabels(props.repoPath, props.number, removed)
    }
    toast.add({ title: t('repo.issues.saveSuccess'), color: 'success', duration: 2000 })
    // 写后一致性（§8.4）：通知父级重拉详情，侧栏与服务端保持一致
    emit('updated')
  }
  catch (err) {
    toast.add({
      title: t('repo.issues.saveFailed'),
      description: (err as Error)?.message || '',
      color: 'error',
      duration: 6000,
    })
  }
}

/** 保存处理人：先逐个校验可分配性，再差分提交（POST 增 / DELETE 删，均有 body → cnbFetch） */
async function saveAssignees() {
  // 先清上次的行内错误（每次保存独立校验）
  inlineError.value = ''
  // 数量上限预校验（服务端同样限制 8 个，前端先拦避免无效请求）
  if (selectedAssignees.value.length > ASSIGNEE_LIMIT) {
    inlineError.value = t('repo.issues.assigneeLimit', { max: ASSIGNEE_LIMIT })
    return
  }
  const original = props.assignees.map(a => a.username)
  const added = selectedAssignees.value.filter(name => !original.includes(name)) // 新增项
  const removed = original.filter(name => !selectedAssignees.value.includes(name)) // 移除项

  // 校验新增用户名是否可被分配（404→false；500/网络错误继续抛出，不静默过滤）
  for (const username of added) {
    let assignable = false // 探测结果：true = 该用户可被分配到本 Issue
    try {
      // 探测端点 GET /assignees/{username}：204→true / 404→false
      assignable = await canAssignIssue(props.repoPath, props.number, username)
    }
    catch (err) {
      // 探测端点 5xx：整体中止保存并提示（不能带着未验证用户名盲提交）
      toast.add({
        title: t('repo.issues.checkFailed'),
        description: (err as Error)?.message || '',
        color: 'error',
        duration: 6000,
      })
      return
    }
    if (!assignable) {
      inlineError.value = t('repo.issues.assigneeNotAllowed', { username })
      return
    }
  }
  // 无差分：不发请求（避免空写触发服务端不必要的校验）
  if (added.length === 0 && removed.length === 0) {
    return
  }
  submitting.value = true // 请求进行中（保存按钮 loading，防重复提交）
  try {
    if (added.length) {
      // POST /assignees：201 api.IssueDetail（有 body）→ 数据层 cnbFetch
      await setIssueAssignees(props.repoPath, props.number, added)
    }
    if (removed.length) {
      // DELETE /assignees：200 api.IssueDetail（有 body）→ 数据层 cnbFetch
      await removeIssueAssignees(props.repoPath, props.number, removed)
    }
    toast.add({ title: t('repo.issues.saveSuccess'), color: 'success', duration: 2000 })
    emit('updated')
  }
  catch (err) {
    toast.add({
      title: t('repo.issues.saveFailed'),
      description: (err as Error)?.message || '',
      color: 'error',
      duration: 6000,
    })
  }
  finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- 标签编辑：数据源与仓库标签管理共用 listRepoLabels -->
    <div>
      <h3 class="text-sm font-semibold text-highlighted mb-2">
        {{ t('issues.labels') }}
      </h3>
      <StateAlert v-if="labelLoading" state="loading" loading-variant="plain" />
      <StateAlert
        v-else-if="labelError"
        state="error"
        :error="labelError"
        :retry="loadLabels"
      />
      <USelectMenu
        v-else
        v-model="selectedLabels"
        :items="labelOptions"
        value-key="name"
        label-key="name"
        multiple
        :placeholder="t('repo.issues.selectLabels')"
        class="w-full"
      />
      <p class="mt-1 text-xs text-dimmed">
        {{ t('repo.issues.labelHint', { max: LABEL_LIMIT }) }}
      </p>
      <UButton
        size="sm"
        color="primary"
        variant="soft"
        :label="t('common.save')"
        class="mt-2"
        @click="saveLabels"
      />
    </div>

    <!-- 处理人编辑：creatable（Nuxt UI v4 用 create-item）手动输入用户名 + canAssign 校验 -->
    <div>
      <h3 class="text-sm font-semibold text-highlighted mb-2">
        {{ t('issues.assignees') }}
      </h3>
      <USelectMenu
        v-model="selectedAssignees"
        :items="assigneeOptions"
        multiple
        create-item
        :placeholder="t('repo.issues.selectAssignees')"
        class="w-full"
      />
      <p class="mt-1 text-xs text-dimmed">
        {{ t('repo.issues.assigneeHint', { max: ASSIGNEE_LIMIT }) }}
      </p>
      <UButton
        size="sm"
        color="primary"
        variant="soft"
        :label="t('common.save')"
        :loading="submitting"
        class="mt-2"
        @click="saveAssignees"
      />
    </div>

    <!-- 行内错误（BUG-05 后标签与处理人共用）：上限超限 / 可分配性校验失败 -->
    <UAlert
      v-if="inlineError"
      color="error"
      variant="soft"
      icon="i-lucide-circle-alert"
      :title="inlineError"
    />
  </div>
</template>
