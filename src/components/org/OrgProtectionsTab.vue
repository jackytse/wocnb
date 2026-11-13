<script setup lang="ts">
/**
 * 组织「保护分支规则」页签（设计文档 §2.8 / §3 / §5）。
 *
 * 能力：
 * - 根组织：列表（GET，scope group-manage:r）+ 新建（POST）+ 编辑（PATCH）+
 *   删除（DELETE，scope 均为 group-manage:rw），三条写操作都返回 200 空 body，
 *   数据层统一走 cnbFetchVoid（用 cnbFetch 会把成功报成失败）；
 * - 子组织：**不发请求**，直接引导去根组织 —— 端点描述明确是「根组织保护分支
 *   规则」，子组织路径调用必然 400（设计文档 §1 D4）；
 * - 上限：每个组织最多 10 条（POST 超限 422），已有 10 条时「新建」按钮直接
 *   disabled 并给出提示；若仍被服务端拒绝，把 422 的 errmsg 原样透出，
 *   不做「失败」这种不可诊断的兜底文案；
 * - 降级：403（缺 group-manage:r）→ StateAlert error（带缺失 scope 提示 +
 *   管理令牌外跳）+ 重试；空列表 → StateAlert empty；`canManage === false`
 *   → 隐藏所有写入口，表格降级为只读。
 *
 * 契约（调用方 group.vue 已固定）：props { slug, canManage }；本组件自行负责
 * 加载/错误/空态/写操作，不向父组件抛异常，403 只在本页签内降级。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import {
  BRANCH_PROTECTION_LIMIT,
  BRANCH_PROTECTION_MERGE_FLAGS,
  BRANCH_PROTECTION_PUSH_FLAGS,
  createBranchProtection,
  createEmptyBranchProtection,
  deleteBranchProtection,
  fetchBranchProtections,
  updateBranchProtection,
  type BranchProtectionBooleanKey,
  type BranchProtectionRule,
} from '../../composables/useCnbBranchProtections'
import { CNB_TOKEN_MANAGE_URL } from '../../composables/useCnbAuth'
import ConfirmDialog from '../common/ConfirmDialog.vue'
import StateAlert from '../repo/StateAlert.vue'

const props = defineProps<{
  /** 组织路径（'org' 或 'org/sub'） */
  slug: string
  /** 是否有组织管理权限（false 时隐藏全部写入口，表格只读） */
  canManage: boolean
}>()

const { t } = useI18n()
const router = useRouter()
const toast = useToast()

// ---------------------------------------------------------------------------
// 根组织守卫（设计文档 §1 D4）
// ---------------------------------------------------------------------------

/**
 * 是否子组织：`slug` 含 `/` 即为子组织（如 `org/sub`）。
 * 判定口径与 CNB 路径语义一致（组织路径段用 `/` 分隔），无需额外请求探测。
 */
const isSubGroup = computed(() => props.slug.includes('/'))

/** 根组织路径（子组织取第一段）；空串时按钮不渲染 */
const rootSlug = computed(() => props.slug.split('/')[0] || '')

/**
 * 跳到根组织：走站内路由 `?slug=`，由 group.vue 的 slug watch 同步
 * selectedGroup（侧边栏/成员页随之联动）。不用 emit —— 父页面已有统一的
 * URL 驱动下钻通道，组件直接复用即可，避免再加一条状态回路。
 */
function goRootGroup() {
  if (!rootSlug.value) {
    return
  }
  void router.push({ path: '/group', query: { slug: rootSlug.value } })
}

// ---------------------------------------------------------------------------
// 列表加载
// ---------------------------------------------------------------------------

/** 规则列表（空数组 = 尚未配置任何规则） */
const rules = ref<BranchProtectionRule[]>([])
/** 加载中 */
const loading = ref(false)
/** 加载失败对象（CnbApiError.kind 决定 403/网络分支，交给 StateAlert） */
const loadError = ref<Error | null>(null)

/**
 * 拉取规则列表。
 * 子组织 / 空 slug 直接跳过 —— 子组织请求必然 400，发出去只是浪费一次往返
 * 并让用户看到无意义的错误。
 */
async function load() {
  if (!props.slug || isSubGroup.value) {
    rules.value = []
    loadError.value = null
    loading.value = false
    return
  }
  loading.value = true
  loadError.value = null
  try {
    rules.value = await fetchBranchProtections(props.slug)
  }
  catch (err) {
    rules.value = []
    loadError.value = (err as Error) ?? new Error(String(err))
  }
  finally {
    loading.value = false
  }
}

/** 是否已达规则条数上限（10 条）：达到后「新建」按钮 disabled，避免必然的 422 */
const limitReached = computed(() => rules.value.length >= BRANCH_PROTECTION_LIMIT)

/** 标题右侧的条数徽标（如「3 / 10」）；子组织/加载中/出错时不展示 */
const countLabel = computed(() =>
  t('org.protections.countLabel', {
    count: rules.value.length,
    limit: BRANCH_PROTECTION_LIMIT,
  }),
)

/** 是否展示写入口（有管理权限且当前是根组织） */
const showWriteEntry = computed(() => props.canManage && !isSubGroup.value)

// ---------------------------------------------------------------------------
// 新建 / 编辑弹窗（复用同一个 UModal）
// ---------------------------------------------------------------------------

/** 表单状态里的布尔开关集合（键与 BranchProtectionRule 的布尔字段一一对应） */
type FlagRecord = Record<BranchProtectionBooleanKey, boolean>

/** 表单状态（数字用字符串承载：UInput 的数字值形态随地输入法/清空而变化，统一在提交时解析校验） */
interface ProtectionFormState {
  /** 规则名（必填） */
  rule: string
  /** 必需评审人数（原始输入文本，提交时解析为 1~5 的整数） */
  reviewCountText: string
  /** 评审通过率（原始输入文本，提交时解析为 1~100 的整数） */
  reviewRatioText: string
  /** 18 个布尔开关 */
  flags: FlagRecord
}

/** 全部分组的开关键（提交时统一写回规则对象） */
const ALL_FLAG_KEYS: readonly BranchProtectionBooleanKey[] = [
  ...BRANCH_PROTECTION_PUSH_FLAGS,
  ...BRANCH_PROTECTION_MERGE_FLAGS,
]

/** 构造空表单（默认值取数据层的空规则：最严格策略 + 合法数字区间） */
function emptyFormState(): ProtectionFormState {
  const base = createEmptyBranchProtection()
  const flags = {} as FlagRecord
  for (const key of ALL_FLAG_KEYS) {
    flags[key] = base[key]
  }
  return {
    rule: base.rule,
    reviewCountText: String(base.requiredApprovedReviewCount),
    reviewRatioText: String(base.requiredApprovedReviewRatio),
    flags,
  }
}

const formOpen = ref(false)
/** 正在编辑的规则 id（空串 = 新建模式） */
const editingId = ref('')
const form = ref<ProtectionFormState>(emptyFormState())
const submitting = ref(false)

/** 新建：清空表单并进入新建模式 */
function openCreate() {
  if (limitReached.value) {
    return
  }
  editingId.value = ''
  form.value = emptyFormState()
  formOpen.value = true
}

/** 编辑：把规则回填进表单（数字转字符串，布尔逐键复制） */
function openEdit(rule: BranchProtectionRule) {
  const flags = {} as FlagRecord
  for (const key of ALL_FLAG_KEYS) {
    flags[key] = rule[key] === true
  }
  editingId.value = rule.id
  form.value = {
    rule: rule.rule,
    reviewCountText: String(rule.requiredApprovedReviewCount),
    reviewRatioText: String(rule.requiredApprovedReviewRatio),
    flags,
  }
  formOpen.value = true
}

/** 严格整数解析（空串/小数/带字母一律 NaN，不静默取整欺骗用户） */
function parseStrictInt(text: string): number {
  const trimmed = text.trim()
  if (!/^-?\d+$/.test(trimmed)) {
    return Number.NaN
  }
  return Number(trimmed)
}

/** 必需评审人数（服务端约束 1~5） */
const reviewCountValue = computed(() => parseStrictInt(form.value.reviewCountText))
/** 评审通过率（服务端约束 1~100） */
const reviewRatioValue = computed(() => parseStrictInt(form.value.reviewRatioText))
const reviewCountValid = computed(() =>
  Number.isInteger(reviewCountValue.value)
  && reviewCountValue.value >= 1
  && reviewCountValue.value <= 5,
)
const reviewRatioValid = computed(() =>
  Number.isInteger(reviewRatioValue.value)
  && reviewRatioValue.value >= 1
  && reviewRatioValue.value <= 100,
)
/** 规则名必填（服务端以它作为唯一可读标识，空值没有意义） */
const ruleNameValid = computed(() => form.value.rule.trim().length > 0)
/** 整体可提交（任一校验不过就禁用保存，不让用户白跑一次 422） */
const formValid = computed(() => ruleNameValid.value && reviewCountValid.value && reviewRatioValid.value)

/** 规则名错误提示（仅在用户清空后出现，避免打开弹窗就红一片） */
const ruleError = computed(() => (ruleNameValid.value ? '' : t('org.protections.ruleRequired')))

/** 表单状态 → 规则对象（id 留空：POST 由服务端生成，PATCH 走路径段） */
function buildRuleFromForm(): BranchProtectionRule {
  const rule = createEmptyBranchProtection()
  rule.rule = form.value.rule.trim()
  rule.requiredApprovedReviewCount = reviewCountValue.value
  rule.requiredApprovedReviewRatio = reviewRatioValue.value
  for (const key of ALL_FLAG_KEYS) {
    rule[key] = form.value.flags[key] === true
  }
  return rule
}

/** 提交（新建 POST / 编辑 PATCH）；失败保留弹窗与输入，便于改完再试 */
async function onSubmit() {
  if (!props.slug || submitting.value || !formValid.value) {
    return
  }
  const editing = editingId.value !== ''
  submitting.value = true
  try {
    const payload = buildRuleFromForm()
    if (editing) {
      await updateBranchProtection(props.slug, editingId.value, payload)
    }
    else {
      await createBranchProtection(props.slug, payload)
    }
    toast.add({
      title: editing ? t('org.protections.updated') : t('org.protections.created'),
      description: payload.rule,
      color: 'success',
      duration: 3000,
    })
    formOpen.value = false
    await load()
  }
  catch (err) {
    // 422 的两种可能（已达 10 条上限 / 字段非法）必须让用户看见服务端原文，
    // 否则「失败」二字无法指向任何可行动作
    const status = (err as { status?: number }).status
    const title = status === 422
      ? t('org.protections.rejected422')
      : editing
        ? t('org.protections.updateFailed')
        : t('org.protections.createFailed')
    toast.add({
      title,
      description: (err as Error)?.message || '',
      color: 'error',
      duration: 6000,
    })
  }
  finally {
    submitting.value = false
  }
}

// ---------------------------------------------------------------------------
// 删除（ConfirmDialog + 输入规则名二次确认）
// ---------------------------------------------------------------------------

const deleteOpen = ref(false)
/** 待删除的规则（null = 未选中） */
const deleteTarget = ref<BranchProtectionRule | null>(null)
const deleting = ref(false)
/**
 * 二次确认输入（受控）：ConfirmDialog 自己只在「取消」时清空，而删除成功后
 * 我们是直接置 open=false 的 —— 不接管这个 model 的话，下次打开会残留上一条
 * 规则名，用户必须手动清空才能确认。
 */
const deleteTyped = ref('')

/** 打开删除确认（typeToConfirm 用规则名，并清空上次残留的输入） */
function askDelete(rule: BranchProtectionRule) {
  deleteTyped.value = ''
  deleteTarget.value = rule
  deleteOpen.value = true
}

/** 确认删除：成功后刷新列表；失败保留弹窗并透出服务端原文 */
async function onDeleteConfirm() {
  const target = deleteTarget.value
  if (!props.slug || !target || deleting.value) {
    return
  }
  deleting.value = true
  try {
    await deleteBranchProtection(props.slug, target.id)
    toast.add({
      title: t('org.protections.deleted'),
      description: target.rule,
      color: 'success',
      duration: 3000,
    })
    deleteOpen.value = false
    deleteTarget.value = null
    await load()
  }
  catch (err) {
    toast.add({
      title: t('org.protections.deleteFailed'),
      description: (err as Error)?.message || '',
      color: 'error',
      duration: 6000,
    })
  }
  finally {
    deleting.value = false
  }
}

// ---------------------------------------------------------------------------
// 生命周期：slug 变化（切组织 / 子组织下钻）→ 关闭弹窗并重拉列表
//
// 注意：本 watch 刻意放在所有 ref 声明之后 —— 带 immediate 的 watch 在 setup
// 期间同步执行回调，若放在 formOpen / deleteTarget 的 const 声明之前会命中
// 暂时性死区（TDZ），组件挂载即抛 ReferenceError。
// ---------------------------------------------------------------------------

watch(() => props.slug, () => {
  formOpen.value = false
  deleteOpen.value = false
  deleteTarget.value = null
  void load()
}, { immediate: true })

// ---------------------------------------------------------------------------
// 表格布尔列展示（用图标而非 true/false 文本，避免一眼全是字）
// ---------------------------------------------------------------------------

/** 布尔值 → 图标名（启用 check / 未启用短横线） */
function flagIcon(value: boolean): string {
  return value ? 'i-lucide-check' : 'i-lucide-minus'
}

/** 布尔值 → 图标样式（启用绿色 / 未启用弱化灰） */
function flagClass(value: boolean): string {
  return value ? 'size-4 text-success' : 'size-4 text-dimmed'
}

/** 布尔值 → 无障碍标签（图标本身无文本，读屏需要它） */
function flagLabel(value: boolean): string {
  return value ? t('org.protections.enabled') : t('org.protections.disabled')
}
</script>

<template>
  <UCard
    variant="subtle"
    :ui="{ body: 'flex flex-col gap-4' }"
  >
    <template #header>
      <div class="flex items-center gap-2">
        <UIcon name="i-lucide-shield-check" class="size-4 text-muted" />
        <span class="font-semibold text-highlighted">{{ t('org.protections.title') }}</span>
        <UBadge
          v-if="!isSubGroup && !loading && !loadError"
          color="neutral"
          variant="subtle"
          size="sm"
          :label="countLabel"
        />
        <div class="ms-auto flex items-center gap-1">
          <UButton
            v-if="!isSubGroup"
            size="xs"
            color="neutral"
            variant="ghost"
            icon="i-lucide-refresh-cw"
            :loading="loading"
            :aria-label="t('common.retry')"
            @click="load"
          />
          <UButton
            v-if="showWriteEntry"
            size="xs"
            color="primary"
            variant="soft"
            icon="i-lucide-plus"
            :disabled="limitReached"
            :label="t('org.protections.create')"
            @click="openCreate"
          />
        </div>
      </div>
    </template>

    <!-- ① 子组织：不发请求，直接引导去根组织（设计文档 §1 D4） -->
    <div v-if="isSubGroup" class="flex flex-col items-center gap-3 py-10 text-center">
      <UIcon name="i-lucide-git-branch" class="size-10 text-dimmed" />
      <p class="text-sm font-medium text-highlighted">
        {{ t('org.protections.rootOnlyTitle') }}
      </p>
      <p class="text-xs text-dimmed max-w-md">
        {{ t('org.protections.rootOnlyDesc') }}
      </p>
      <UButton
        size="sm"
        color="primary"
        variant="soft"
        icon="i-lucide-arrow-up-right"
        :label="t('org.protections.goRootGroup')"
        @click="goRootGroup"
      />
    </div>

    <template v-else>
      <!-- ② 403（缺 group-manage:r）/ 网络错误：StateAlert 按 error.kind 分支，
           403 含缺失 scope 与「管理令牌」外跳，且绝不引导登出（红线 §6.1） -->
      <StateAlert
        v-if="loadError"
        state="error"
        :error="loadError"
        :site-url="CNB_TOKEN_MANAGE_URL"
        :retry="load"
      />

      <!-- 加载中：形状匹配列表的骨架屏 -->
      <StateAlert
        v-else-if="loading"
        state="loading"
      />

      <!-- 空态：无规则（可管理时说明建规则的作用） -->
      <StateAlert
        v-else-if="rules.length === 0"
        state="empty"
        :empty-text="t('org.protections.empty')"
        :empty-desc="canManage ? t('org.protections.emptyDesc') : ''"
      />

      <div v-else class="flex flex-col gap-2">
        <!-- 已达上限提示（按钮同时 disabled，双保险：文案解释"为什么点不了"） -->
        <p v-if="showWriteEntry && limitReached" class="text-xs text-warning">
          {{ t('org.protections.limitHint', { limit: BRANCH_PROTECTION_LIMIT }) }}
        </p>

        <!-- 规则表格：规则名 / 评审要求 / 关键布尔项 / 操作
             列取舍：18 个布尔字段全铺开会横向溢出且噪声极大，表格只保留评审链路
             上用户最常核对的 4 个（CodeOwner / 线性历史 / 状态检查 / 必须走 PR），
             其余开关注释在编辑弹窗内按「推送与删除」「合并与评审」两组呈现。
             评审人数与通过率单独成列：它们是唯一的两个数字字段，也是 422 的主要来源。 -->
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="text-left text-xs text-dimmed border-b border-default">
                <th class="py-1.5 font-normal">
                  {{ t('org.protections.colRule') }}
                </th>
                <th class="py-1.5 font-normal text-center">
                  {{ t('org.protections.colReviewCount') }}
                </th>
                <th class="py-1.5 font-normal text-center">
                  {{ t('org.protections.colReviewRatio') }}
                </th>
                <th class="py-1.5 font-normal text-center">
                  {{ t('org.protections.colCodeowner') }}
                </th>
                <th class="py-1.5 font-normal text-center">
                  {{ t('org.protections.colLinearHistory') }}
                </th>
                <th class="py-1.5 font-normal text-center">
                  {{ t('org.protections.colStatusChecks') }}
                </th>
                <th class="py-1.5 font-normal text-center">
                  {{ t('org.protections.colMustPullRequest') }}
                </th>
                <th v-if="canManage" class="py-1.5 font-normal text-right">
                  {{ t('org.protections.colActions') }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="rule in rules"
                :key="rule.id || rule.rule"
                class="border-b border-default last:border-b-0"
              >
                <td class="py-2 font-mono text-xs truncate max-w-80" :title="rule.rule">
                  {{ rule.rule }}
                </td>
                <td class="py-2 text-center tabular-nums">
                  {{ rule.requiredApprovedReviewCount }}
                </td>
                <td class="py-2 text-center tabular-nums">
                  {{ rule.requiredApprovedReviewRatio }}%
                </td>
                <td class="py-2 text-center">
                  <UIcon
                    :name="flagIcon(rule.requiredCodeownerApprove)"
                    :class="flagClass(rule.requiredCodeownerApprove)"
                    :aria-label="flagLabel(rule.requiredCodeownerApprove)"
                  />
                </td>
                <td class="py-2 text-center">
                  <UIcon
                    :name="flagIcon(rule.requiredLinearHistory)"
                    :class="flagClass(rule.requiredLinearHistory)"
                    :aria-label="flagLabel(rule.requiredLinearHistory)"
                  />
                </td>
                <td class="py-2 text-center">
                  <UIcon
                    :name="flagIcon(rule.requiredStatusChecks)"
                    :class="flagClass(rule.requiredStatusChecks)"
                    :aria-label="flagLabel(rule.requiredStatusChecks)"
                  />
                </td>
                <td class="py-2 text-center">
                  <UIcon
                    :name="flagIcon(rule.requiredMustPushViaPullRequest)"
                    :class="flagClass(rule.requiredMustPushViaPullRequest)"
                    :aria-label="flagLabel(rule.requiredMustPushViaPullRequest)"
                  />
                </td>
                <!-- 写入口按 canManage 事前隐藏（红线 §6.2）：无权限时不渲染操作列 -->
                <td v-if="canManage" class="py-2 text-right whitespace-nowrap">
                  <UButton
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    icon="i-lucide-pencil"
                    :disabled="!rule.id"
                    :aria-label="t('org.protections.edit')"
                    @click="openEdit(rule)"
                  />
                  <UButton
                    size="xs"
                    color="error"
                    variant="ghost"
                    icon="i-lucide-trash-2"
                    :disabled="!rule.id"
                    :aria-label="t('org.protections.delete')"
                    @click="askDelete(rule)"
                  />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>

    <!-- ③ 新建 / 编辑弹窗（同一个 UModal，editingId 区分模式） -->
    <UModal
      v-model:open="formOpen"
      :title="editingId ? t('org.protections.edit') : t('org.protections.create')"
      :ui="{ content: 'max-w-2xl' }"
    >
      <template #body>
        <div class="flex flex-col gap-4 max-h-[70vh] overflow-y-auto">
          <!-- 规则名（唯一可读标识，必填；支持通配符） -->
          <UFormField
            :label="t('org.protections.rule')"
            required
            :help="t('org.protections.ruleHint')"
            :error="ruleError || undefined"
          >
            <UInput
              v-model="form.rule"
              class="w-full"
              autocomplete="off"
              :placeholder="t('org.protections.rulePlaceholder')"
            />
          </UFormField>

          <!-- 分组一：推送与删除（9 个 allow_* 开关） -->
          <section class="flex flex-col gap-2 border-t border-default pt-3">
            <h4 class="text-sm font-semibold text-highlighted">
              {{ t('org.protections.groupPush') }}
            </h4>
            <div class="grid gap-2 grid-cols-1 sm:grid-cols-2">
              <USwitch
                v-for="key in BRANCH_PROTECTION_PUSH_FLAGS"
                :key="key"
                v-model="form.flags[key]"
                :label="t(`org.protections.fields.${key}`)"
              />
            </div>
          </section>

          <!-- 分组二：合并与评审（2 个数字 + 9 个布尔开关） -->
          <section class="flex flex-col gap-2 border-t border-default pt-3">
            <h4 class="text-sm font-semibold text-highlighted">
              {{ t('org.protections.groupMerge') }}
            </h4>

            <!-- 两个数字字段：越界即时红框 + 禁用保存（服务端约束 1~5 / 1~100，
                 先在前端拦住，避免白跑一次 422） -->
            <div class="flex flex-wrap items-start gap-4">
              <UFormField
                :label="t('org.protections.fields.requiredApprovedReviewCount')"
                :error="reviewCountValid ? undefined : t('org.protections.reviewCountHint')"
              >
                <UInput
                  v-model="form.reviewCountText"
                  type="number"
                  min="1"
                  max="5"
                  step="1"
                  class="w-32"
                />
              </UFormField>
              <UFormField
                :label="t('org.protections.fields.requiredApprovedReviewRatio')"
                :error="reviewRatioValid ? undefined : t('org.protections.reviewRatioHint')"
              >
                <UInput
                  v-model="form.reviewRatioText"
                  type="number"
                  min="1"
                  max="100"
                  step="1"
                  class="w-32"
                />
              </UFormField>
            </div>

            <div class="grid gap-2 grid-cols-1 sm:grid-cols-2">
              <USwitch
                v-for="key in BRANCH_PROTECTION_MERGE_FLAGS"
                :key="key"
                v-model="form.flags[key]"
                :label="t(`org.protections.fields.${key}`)"
              />
            </div>
          </section>
        </div>
      </template>

      <template #footer>
        <div class="flex justify-end gap-2 w-full">
          <UButton
            color="neutral"
            variant="ghost"
            :label="t('common.cancel')"
            @click="formOpen = false"
          />
          <!-- 校验不过直接禁用：不让用户白跑一次 422 -->
          <UButton
            color="primary"
            :loading="submitting"
            :disabled="!formValid"
            :label="editingId ? t('common.save') : t('org.protections.create')"
            @click="onSubmit"
          />
        </div>
      </template>
    </UModal>

    <!-- ④ 删除确认（破坏性 + 不可逆：确认色 error + 输入规则名） -->
    <ConfirmDialog
      v-model:open="deleteOpen"
      v-model:typed="deleteTyped"
      :title="t('org.protections.deleteTitle')"
      :desc="t('org.protections.deleteDesc', { rule: deleteTarget?.rule || '' })"
      :confirm-label="t('org.protections.delete')"
      confirm-color="error"
      :loading="deleting"
      :type-to-confirm="deleteTarget?.rule || ''"
      :type-to-confirm-label="t('org.protections.deleteTypeLabel', { rule: deleteTarget?.rule || '' })"
      @confirm="onDeleteConfirm"
    />
  </UCard>
</template>
