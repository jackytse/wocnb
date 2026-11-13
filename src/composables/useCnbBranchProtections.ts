/**
 * 组织保护分支规则数据层（设计文档 §2.8 端点契约 / §4.2 数据层契约）。
 *
 * 覆盖端点（swagger 逐条核对，路径前缀 https://api.cnb.cool）：
 * - GET    /{group}/-/git-group-settings/branch-protections       scope group-manage:r  → api.BranchProtection[]
 * - POST   /{group}/-/git-group-settings/branch-protections       scope group-manage:rw → 200 空 body
 * - PATCH  /{group}/-/git-group-settings/branch-protections/{id}  scope group-manage:rw → 200 空 body
 * - DELETE /{group}/-/git-group-settings/branch-protections/{id}  scope group-manage:rw → 200 空 body
 *
 * 三个写操作的响应都是 **200 + 空 body**（swagger 里 200 无 schema）：
 * 必须走 `cnbFetchVoid`，用 `cnbFetch` 会在 `response.json()` 抛
 * "Unexpected end of JSON input"，把成功报成失败（详见 useCnbAuth 的说明）。
 *
 * 为什么本模块只接受**根组织**（设计文档 §1 D4）：端点描述明确写「根组织保护分支规则」
 * （"branch protection rules under the root organization"）。子组织路径调用必然 400，
 * 因此 UI 层（OrgProtectionsTab）对 `slug.includes('/')` 直接给引导、不发请求；
 * 数据层本身不重复守卫（保持纯函数/纯请求，便于单测与将来复用）。
 *
 * 每个组织最多 10 条规则（POST 超限服务端 422），上限常量见
 * `BRANCH_PROTECTION_LIMIT`，UI 据此事前禁用「新建」按钮。
 *
 * 归一化范式与全库一致：snake_case → camelCase、布尔 `=== true`、数字
 * `Number.isFinite` 兜底 + 区间 clamp、字符串 `|| ''`、数组恒 `[]`。
 */
import { cnbFetch, cnbFetchVoid } from './useCnbAuth'

/**
 * 每个组织可创建的规则上限（swagger 原文：每个组织最多可创建 10 条规则）。
 * UI 用它在第 10 条之后禁用「新建」，避免必然的 422。
 */
export const BRANCH_PROTECTION_LIMIT = 10

/** 编码 slug：逐段 encodeURIComponent（'/' 保留为路径分隔符） */
function encodeSlug(slug: string): string {
  return slug.split('/').map(encodeURIComponent).join('/')
}

// ---------------------------------------------------------------------------
// 归一化导出类型（camelCase 镜像，字段全非可选，界面层不判空）
// ---------------------------------------------------------------------------

/**
 * api.BranchProtection 的 camelCase 镜像（22 个字段 = id + 21 个可写字段）。
 *
 * `id` 是服务端生成的只读标识：PATCH / DELETE 时走**路径段**，任何情况下都
 * 不放进请求体（POST/PATCH body 只含下面 21 个可写字段）。
 */
export interface BranchProtectionRule {
  /** 规则唯一标识（只读；PATCH/DELETE 走路径段并 encodeURIComponent） */
  id: string
  /** 规则名（分支匹配模式，支持通配符如 `release/*`）；为空的条目一律丢弃 */
  rule: string

  // —— 9 个 allow_* ：创建 / 删除 / 强推 / 推送的放行策略 ——
  /** 是否允许**所有人**创建保护分支（allow_creation） */
  allowCreation: boolean
  /** 是否允许**所有人**删除保护分支（allow_deletions） */
  allowDeletions: boolean
  /** 是否允许**所有人**强制推送（allow_force_pushes） */
  allowForcePushes: boolean
  /** 是否**仅允许管理员/负责人**创建保护分支（allow_master_creation） */
  allowMasterCreation: boolean
  /** 是否**仅允许管理员/负责人**删除保护分支（allow_master_deletions） */
  allowMasterDeletions: boolean
  /** 是否**仅允许管理员/负责人**强制推送（allow_master_force_pushes） */
  allowMasterForcePushes: boolean
  /** 是否允许管理员/负责人**手动合并**到目标分支（allow_master_manual_merge） */
  allowMasterManualMerge: boolean
  /** 是否**仅允许管理员/负责人**推送到保护分支（allow_master_pushes） */
  allowMasterPushes: boolean
  /** 是否允许**所有人**推送到保护分支（allow_pushes） */
  allowPushes: boolean

  // —— 合并与评审要求（2 个数字 + 9 个布尔）——
  /** 需要的代码评审者人数，取值 `[1,5]`（required_approved_review_count） */
  requiredApprovedReviewCount: number
  /** 需要的评审通过率百分比，取值 `[1,100]`（required_approved_review_ratio） */
  requiredApprovedReviewRatio: number
  /** 是否需至少一个代码所有者（CODEOWNERS）批准（required_codeowner_approve） */
  requiredCodeownerApprove: boolean
  /** 是否仅允许线性提交（禁止 merge commit）（required_linear_history） */
  requiredLinearHistory: boolean
  /** 是否需至少一个仓库管理员批准（required_master_approve） */
  requiredMasterApprove: boolean
  /** 是否仅允许自动合并（禁止手动合并）（required_must_auto_merge） */
  requiredMustAutoMerge: boolean
  /** 是否必须通过合并请求（PR）推送代码（required_must_push_via_pull_request） */
  requiredMustPushViaPullRequest: boolean
  /** 是否需至少一个 NPC 批准（required_npc_approve） */
  requiredNpcApprove: boolean
  /** 合并请求是否必须经过代码评审（required_pull_request_reviews） */
  requiredPullRequestReviews: boolean
  /** 是否必须通过状态检查（required_status_checks） */
  requiredStatusChecks: boolean
  /** 是否禁止批准由**自己的 NPC** 创建的合并请求（forbid_approve_pull_created_by_own_npc） */
  forbidApprovePullCreatedByOwnNpc: boolean
}

// ---------------------------------------------------------------------------
// 字段映射表（camelCase ↔ snake_case）—— 归一化与请求体构造的唯一事实来源
// ---------------------------------------------------------------------------

/** 布尔字段键（camelCase） */
export type BranchProtectionBooleanKey =
  | 'allowCreation'
  | 'allowDeletions'
  | 'allowForcePushes'
  | 'allowMasterCreation'
  | 'allowMasterDeletions'
  | 'allowMasterForcePushes'
  | 'allowMasterManualMerge'
  | 'allowMasterPushes'
  | 'allowPushes'
  | 'requiredCodeownerApprove'
  | 'requiredLinearHistory'
  | 'requiredMasterApprove'
  | 'requiredMustAutoMerge'
  | 'requiredMustPushViaPullRequest'
  | 'requiredNpcApprove'
  | 'requiredPullRequestReviews'
  | 'requiredStatusChecks'
  | 'forbidApprovePullCreatedByOwnNpc'

/** 单个布尔字段的双向映射 */
interface BooleanFieldPair {
  /** 前端字段名（camelCase） */
  camel: BranchProtectionBooleanKey
  /** 服务端字段名（snake_case，swagger 原文） */
  snake: string
}

/**
 * 18 个布尔字段的映射表。
 * 归一化（读）与请求体构造（写）都只读这张表 —— 字段增删改一处生效，
 * 不会出现「读时归一化了、写时漏发」的漂移。
 */
const BOOLEAN_FIELDS: readonly BooleanFieldPair[] = [
  { camel: 'allowCreation', snake: 'allow_creation' },
  { camel: 'allowDeletions', snake: 'allow_deletions' },
  { camel: 'allowForcePushes', snake: 'allow_force_pushes' },
  { camel: 'allowMasterCreation', snake: 'allow_master_creation' },
  { camel: 'allowMasterDeletions', snake: 'allow_master_deletions' },
  { camel: 'allowMasterForcePushes', snake: 'allow_master_force_pushes' },
  { camel: 'allowMasterManualMerge', snake: 'allow_master_manual_merge' },
  { camel: 'allowMasterPushes', snake: 'allow_master_pushes' },
  { camel: 'allowPushes', snake: 'allow_pushes' },
  { camel: 'requiredCodeownerApprove', snake: 'required_codeowner_approve' },
  { camel: 'requiredLinearHistory', snake: 'required_linear_history' },
  { camel: 'requiredMasterApprove', snake: 'required_master_approve' },
  { camel: 'requiredMustAutoMerge', snake: 'required_must_auto_merge' },
  { camel: 'requiredMustPushViaPullRequest', snake: 'required_must_push_via_pull_request' },
  { camel: 'requiredNpcApprove', snake: 'required_npc_approve' },
  { camel: 'requiredPullRequestReviews', snake: 'required_pull_request_reviews' },
  { camel: 'requiredStatusChecks', snake: 'required_status_checks' },
  { camel: 'forbidApprovePullCreatedByOwnNpc', snake: 'forbid_approve_pull_created_by_own_npc' },
]

/**
 * 「推送与删除」分组的开关（9 个 allow_*）。
 * 表单按此顺序渲染，语义由「允许所有人 / 仅管理员」成对呈现。
 */
export const BRANCH_PROTECTION_PUSH_FLAGS: readonly BranchProtectionBooleanKey[] = [
  'allowPushes',
  'allowCreation',
  'allowDeletions',
  'allowForcePushes',
  'allowMasterPushes',
  'allowMasterCreation',
  'allowMasterDeletions',
  'allowMasterForcePushes',
  'allowMasterManualMerge',
]

/**
 * 「合并与评审」分组的开关（9 个 required_* / forbid_*）。
 * 该分组内另有 2 个数字字段（评审人数 / 通过率）由表单单独渲染。
 */
export const BRANCH_PROTECTION_MERGE_FLAGS: readonly BranchProtectionBooleanKey[] = [
  'requiredPullRequestReviews',
  'requiredCodeownerApprove',
  'requiredMasterApprove',
  'requiredNpcApprove',
  'requiredLinearHistory',
  'requiredMustAutoMerge',
  'requiredMustPushViaPullRequest',
  'requiredStatusChecks',
  'forbidApprovePullCreatedByOwnNpc',
]

// ---------------------------------------------------------------------------
// 归一化
// ---------------------------------------------------------------------------

/**
 * 数值归一 + 区间 clamp（整数）。
 *
 * swagger 约束：评审人数 `∈ [1,5]`、通过率 `∈ [1,100]`。缺失 / 非数字 /
 * `null` / 空串（`Number('') === 0`）一律按 0 处理后 clamp 到**下限**：
 * 表单只允许 1~5 / 1~100，若把 0 原样透出，用户一保存就会被服务端拒绝。
 *
 * @param value 服务端原始值
 * @param min 合法下界（clamp 下限，同时是缺失值的兜底）
 * @param max 合法上界（clamp 上限）
 */
function clampInt(value: unknown, min: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return min
  }
  const rounded = Math.round(parsed)
  return Math.min(max, Math.max(min, rounded))
}

/**
 * 构造一条「空规则」（表单新建时的初值）。
 *
 * 默认值取舍：布尔全 false（不放开任何推送/删除能力，也即最严格），
 * 评审人数 1、通过率 100（CNB 控制台默认口径），均在合法区间内，
 * 用户直接提交也不会被服务端 422 拒绝。
 */
export function createEmptyBranchProtection(): BranchProtectionRule {
  const rule: BranchProtectionRule = {
    id: '',
    rule: '',
    allowCreation: false,
    allowDeletions: false,
    allowForcePushes: false,
    allowMasterCreation: false,
    allowMasterDeletions: false,
    allowMasterForcePushes: false,
    allowMasterManualMerge: false,
    allowMasterPushes: false,
    allowPushes: false,
    requiredApprovedReviewCount: 1,
    requiredApprovedReviewRatio: 100,
    requiredCodeownerApprove: false,
    requiredLinearHistory: false,
    requiredMasterApprove: false,
    requiredMustAutoMerge: false,
    requiredMustPushViaPullRequest: false,
    requiredNpcApprove: false,
    requiredPullRequestReviews: false,
    requiredStatusChecks: false,
    forbidApprovePullCreatedByOwnNpc: false,
  }
  return rule
}

/**
 * 归一化单条规则（导出为纯函数，供单测与 fetch 复用）。
 *
 * 防御规则（设计文档 §4.2 + 任务说明逐条对应）：
 * - 入参非对象 → 全字段兜底（不抛错，交给上层过滤）；
 * - 布尔 `=== true`：服务端缺失 / `"false"` 字符串 / 0 一律按 false，
 *   但**显式的 false 与缺失同值**（都是"不启用"），不存在"false 被丢"的问题；
 * - `rule` 缺失 → 空串（该条目由 fetchBranchProtections 丢弃，见其注释）；
 * - 两个数字做区间 clamp（见 clampInt）；
 * - `id` 缺失 → 空串（无 id 的规则 UI 禁用编辑/删除，只可展示）。
 *
 * 注意签名按设计文档 §4.2 恒返回 BranchProtectionRule（不返回 null）：
 * 「丢弃空规则」的职责放在 fetchBranchProtections 的 filter 里，
 * 这样调用方拿到的每条数据都可直接绑定表单。
 */
export function normalizeBranchProtection(raw: unknown): BranchProtectionRule {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const result = createEmptyBranchProtection()
  result.id = typeof source.id === 'string' ? source.id : ''
  result.rule = typeof source.rule === 'string' ? source.rule : ''
  for (const field of BOOLEAN_FIELDS) {
    result[field.camel] = source[field.snake] === true
  }
  result.requiredApprovedReviewCount = clampInt(source.required_approved_review_count, 1, 5)
  result.requiredApprovedReviewRatio = clampInt(source.required_approved_review_ratio, 1, 100)
  return result
}

/**
 * 构造写操作的请求体（POST / PATCH 共用，导出以便单测断言键集合）。
 *
 * 只发 21 个可写字段（swagger 的 api.BranchProtection 共 22 个属性，其中
 * `id` 只读）：
 * - **不含 id** —— PATCH 时 id 走路径段，POST 时由服务端生成；
 *   把 id 塞进 body 没有任何收益，还有被服务端当作"改主键"的风险；
 * - 两个数字字段同样做一次 clamp（表单已校验，这里兜底防调用方绕过）。
 */
export function buildBranchProtectionBody(rule: BranchProtectionRule): Record<string, unknown> {
  const body: Record<string, unknown> = {
    rule: rule.rule,
    required_approved_review_count: clampInt(rule.requiredApprovedReviewCount, 1, 5),
    required_approved_review_ratio: clampInt(rule.requiredApprovedReviewRatio, 1, 100),
  }
  for (const field of BOOLEAN_FIELDS) {
    body[field.snake] = rule[field.camel] === true
  }
  return body
}

// ---------------------------------------------------------------------------
// 读操作
// ---------------------------------------------------------------------------

/**
 * 保护分支规则列表（GET /{group}/-/git-group-settings/branch-protections，
 * scope `group-manage:r`）。
 *
 * 非数组响应（网关异常 / 空 body / 对象包裹）一律按空数组处理 ——
 * 列表页空态比"整页报错"更可诊断。
 *
 * `rule` 为空的条目被丢弃：规则名是唯一可读标识，没有它既无法展示也无法
 * 定位删除目标（服务端不会返回这种条目，属防御式兜底）。
 */
export async function fetchBranchProtections(slug: string): Promise<BranchProtectionRule[]> {
  if (!slug) {
    return []
  }
  const raw = await cnbFetch<unknown>(
    `/${encodeSlug(slug)}/-/git-group-settings/branch-protections`,
  )
  if (!Array.isArray(raw)) {
    return []
  }
  return raw
    .map(normalizeBranchProtection)
    .filter(item => item.rule !== '')
}

// ---------------------------------------------------------------------------
// 写操作（全部走 cnbFetchVoid：200 + 空 body）
// ---------------------------------------------------------------------------

/**
 * 创建保护分支规则（POST /{group}/-/git-group-settings/branch-protections，
 * scope `group-manage:rw`）→ 200 空 body。
 *
 * 失败语义：403 = 令牌缺 group-manage:rw；422 = 已达 10 条上限或字段非法
 * （服务端 die.WebError 的 errmsg 会被 cnbFetch 拼进 message，UI 直接透出）。
 * 本函数不吞任何错误，由组件决定 toast 文案。
 */
export async function createBranchProtection(
  slug: string,
  rule: BranchProtectionRule,
): Promise<void> {
  await cnbFetchVoid(`/${encodeSlug(slug)}/-/git-group-settings/branch-protections`, {
    method: 'POST',
    body: JSON.stringify(buildBranchProtectionBody(rule)),
  })
}

/**
 * 更新保护分支规则（PATCH /{group}/-/git-group-settings/branch-protections/{id}，
 * scope `group-manage:rw`）→ 200 空 body。
 *
 * `id` 走路径段且 **encodeURIComponent**（id 由服务端生成，可能含 `/`、`#`
 * 等对 URL 有语义的字符）；请求体同样不含 id。
 */
export async function updateBranchProtection(
  slug: string,
  id: string,
  rule: BranchProtectionRule,
): Promise<void> {
  await cnbFetchVoid(
    `/${encodeSlug(slug)}/-/git-group-settings/branch-protections/${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(buildBranchProtectionBody(rule)),
    },
  )
}

/**
 * 删除保护分支规则（DELETE /{group}/-/git-group-settings/branch-protections/{id}，
 * scope `group-manage:rw`）→ 200 空 body。
 *
 * 删除后匹配该规则的分支不再受保护（swagger 原文语义），属不可逆操作 ——
 * UI 必须走 ConfirmDialog + typeToConfirm（输入规则名）。
 */
export async function deleteBranchProtection(slug: string, id: string): Promise<void> {
  await cnbFetchVoid(
    `/${encodeSlug(slug)}/-/git-group-settings/branch-protections/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  )
}
