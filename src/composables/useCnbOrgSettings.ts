/**
 * 组织设置数据层（设计文档 §2.1 / §2.2 / §2.3 / §2.4 / §4.1）。
 *
 * 覆盖端点（2026-11-11 逐条核对 https://api.cnb.cool/swagger.json）：
 * - PUT  /{group}                → dto.UpdateGroupReq，scope group-manage:rw，200 空 body
 * - GET  /{slug}/-/settings      → dto.OrganizationSettingWithParent，scope group-manage:r
 * - PUT  /{slug}/-/settings      → dto.GroupSettingReq，scope group-manage:rw，200 空 body
 * - POST /groups                 → dto.CreateGroupReq，scope group-manage:rw，201
 * - POST /{group}/-/transfer     → dto.TransferSlugReq，scope group-manage:rw，200 空 body
 *
 * 三条硬约束（每条都对应一次踩坑或一次后端语义陷阱）：
 * 1. **路径逐段编码**：`slug` 可能是多级子组织路径（`org/sub`），整体
 *    encodeURIComponent 会把 `/` 压成 `%2F`，服务端按单段名解析后一律 404；
 * 2. **空 body 写端点必须用 cnbFetchVoid**：上述四个写端点在 swagger 里都是
 *    200/201 + 空 schema，实际响应体为空。走 cnbFetch 会在 response.json()
 *    抛 "Unexpected end of JSON input"，把成功当失败，用户会以为没生效而反复点；
 * 3. **增量提交**：`GET /{group}` 不返回 email/domain/remark/wechat_mp，
 *    无法回填。若表单"空即提交空串"，一保存就会把已有的邮箱/域名清空 ——
 *    因此 updateOrgProfile 只提交 patch 中值不为 undefined 的键。
 *
 * 归一化范式与全库一致：snake_case → camelCase，服务端字段可能缺失或类型
 * 漂移（整型 0/1 vs boolean、逗号串 vs 数组），一律防御式归一，组件层无需判空。
 */
import { cnbFetch, cnbFetchVoid } from './useCnbAuth'

/**
 * 编码组织路径：逐段 encodeURIComponent，保留 `/` 作为路径分隔符。
 * （与 useCnbOrg.ts 的 encodeSlug 同一口径，两处各留一份以避免跨文件耦合）
 */
function encodeSlugPath(slug: string): string {
  return slug.split('/').map(encodeURIComponent).join('/')
}

// ---------------------------------------------------------------------------
// 归一化工具（服务端字段类型漂移的防御层）
// ---------------------------------------------------------------------------

/**
 * 布尔归一：兼容 boolean、整型 0/1、字符串 '0'/'1'/'true'/'on'。
 *
 * @param value 原始字段值
 * @param fallback 字段缺失（undefined/null/对象）时的兜底值。
 *   注意 can_show_* 三个「上级限制位」传 true：字段缺失说明服务端未表达
 *   限制意图，若默认 false 会把全部开关锁死（服务端仍是权威执行方，
 *   前端禁用位只是 UX 提示，不承担安全职责）。
 */
function toFlag(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'number') {
    return value === 1
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    return normalized === '1' || normalized === 'true' || normalized === 'on'
  }
  return fallback
}

/** 整数归一：数字或数字字符串 → 截断取整；非法/缺失按 fallback */
function toInt(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value)
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return Math.trunc(parsed)
    }
  }
  return fallback
}

/** 非负整数归一（金额/配额类字段语义上恒 ≥ 0，负数一律按 0 = 不限处理） */
function toNonNegativeInt(value: unknown): number {
  return Math.max(0, toInt(value, 0))
}

/**
 * 字符串数组归一：**只接受数组**（设计文档 §2.2：email_verification 非数组 → []）。
 * 逐项 trim 并丢弃空串/非字符串，同时去重（服务端可能返回重复项）。
 */
function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') {
      continue
    }
    const trimmed = item.trim()
    if (trimmed && !result.includes(trimmed)) {
      result.push(trimmed)
    }
  }
  return result
}

/**
 * values 归一：服务端口径是**逗号拼接的 organization.SettingValue 串**
 * （swagger 原文 "多个选项，用逗号拼接"），同时兼容已是数组的形态
 * （网关版本差异），拆项后 trim + 去空 + 去重。
 */
function splitSettingValues(value: unknown): string[] {
  if (Array.isArray(value)) {
    return toStringList(value)
  }
  if (typeof value !== 'string') {
    return []
  }
  const result: string[] = []
  for (const part of value.split(',')) {
    const trimmed = part.trim()
    if (trimmed && !result.includes(trimmed)) {
      result.push(trimmed)
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// organization.SettingValue 枚举（33 个）与语义分组
// ---------------------------------------------------------------------------

/** 语义分组：id 用于 i18n 组名键（org.orgSettings.valueGroups.<id>） */
export interface SettingValueGroup {
  /** 分组标识（i18n 键后缀） */
  id: string
  /** 该分组下的枚举值（顺序即界面展示顺序） */
  values: string[]
}

/**
 * 33 个 organization.SettingValue 枚举值的语义分组。
 *
 * 枚举值清单来自 swagger definitions.organization.SettingValue.enum
 * （**实际为 33 个**，设计文档 §2.2 正文写作"34 个"但所列条目同样是 33 个，
 * 已按 swagger 权威清单实现，避免臆造不存在的枚举值）。
 * 分组顺序 = 设计文档 §2.2 的列示顺序；中文标签与语义取自 swagger 的
 * x-enum-comments（服务端注释），逐条对照后写入 i18n，
 * 见 org.orgSettings.values.<枚举值名>。
 */
export const SETTING_VALUE_GROUPS: SettingValueGroup[] = [
  {
    id: 'members',
    values: [
      'disable_organization_readme',
      'disable_invitation',
      'enable_add_member',
      'enable_add_member_only_root',
      'enable_change_member_role_only_root',
      'disable_invite_auth_control',
    ],
  },
  {
    id: 'creation',
    values: [
      'prevent_organization_creation',
      'prevent_repository_creation',
      'prevent_mission_creation',
      'prevent_registry_creation',
    ],
  },
  {
    id: 'change',
    values: [
      'prevent_visibility_modification',
      'prevent_resource_deletion',
      'prevent_repository_archival',
    ],
  },
  {
    id: 'transfer',
    values: [
      'prevent_organization_transfer',
      'prevent_repository_transfer',
      'prevent_mission_transfer',
      'prevent_registry_transfer',
    ],
  },
  {
    id: 'git',
    values: [
      'use_group_git_quota',
      'use_group_git_object_limit',
      'use_root_group_git_push_limit',
    ],
  },
  {
    id: 'branch',
    values: [
      'user_root_group_branch_protection_only',
      'forbid_redefine_branch_protection',
    ],
  },
  {
    id: 'npc',
    values: [
      'only_repo_member_can_mention_npc',
      'allow_npc_cross_repo',
      'allow_cron_cross_repo',
      'allow_uncredible_cross_repo',
      'enable_other_group_npc_add_comment',
      'disable_repo_event_auto_trigger',
      'disable_repo_cron_auto_trigger',
      'disable_repo_npc_auto_trigger',
    ],
  },
  {
    id: 'misc',
    values: [
      'cloud_native_dev_only',
      'enable_tapd_access',
      'enable_show_private_mission_water_mark',
    ],
  },
]

/**
 * 扁平化的枚举值清单（**规范顺序**）。
 * 用途：开关切换后按此顺序重排 values 数组，保证「同样的勾选集合 →
 * 同样的请求体字符串」，脏检查（JSON 比较）才不会因点击顺序不同而误判。
 */
export const SETTING_VALUES: string[] = SETTING_VALUE_GROUPS.flatMap(group => group.values)

// ---------------------------------------------------------------------------
// 安全设置（GET / PUT /{slug}/-/settings）
// ---------------------------------------------------------------------------

/** 归一化后的组织安全设置（dto.OrganizationSettingWithParent 的 camelCase 镜像） */
export interface OrgSettings {
  /** 是否对外隐藏组织成员（hide_members：0 否 / 1 是） */
  hideMembers: boolean
  /** 是否对外隐藏子组织（hide_sub_groups） */
  hideSubGroups: boolean
  /** 私有仓库是否显示水印（show_private_repo_watermark） */
  showPrivateRepoWatermark: boolean
  /** 组织保护开关（group_protection） */
  groupProtection: boolean
  /** 邮箱验证域名/地址白名单（email_verification，字符串数组） */
  emailVerification: string[]
  /** NPC 价格上限，单位毫元/百万 token，0 = 不限（npc_price_limit） */
  npcPriceLimit: number
  /** 访客 NPC 价格上限，量纲同上，0 = 跟随 npcPriceLimit（visitor_npc_price_limit） */
  visitorNpcPriceLimit: number
  /** 已勾选的 organization.SettingValue 集合（服务端为逗号串，此处已拆分） */
  values: string[]
  /** 上级限制位：false 表示上级已隐藏成员，本层开关必须 disabled */
  canShowMembers: boolean
  /** 上级限制位：false 表示上级已隐藏子组织 */
  canShowSubGroups: boolean
  /** 上级限制位：false 表示上级已关闭水印能力 */
  canShowWatermark: boolean
  /** 根组织基线（只读展示）：根组织的 group_protection */
  rootGroupProtection: boolean
  /** 根组织基线（只读展示）：根组织的 npc_price_limit */
  rootNpcPriceLimit: number
}

/**
 * 归一化组织安全设置（导出为纯函数以便单测）。
 *
 * 防御规则（服务端字段可能缺失或类型漂移）：
 * - 整型 0/1 与 boolean 混用 → toFlag；
 * - values 逗号串 / 数组 → splitSettingValues；
 * - email_verification 非数组 → []（设计文档 §2.2 明文要求）；
 * - can_show_* 缺失 → true（见 toFlag 的 fallback 说明）。
 */
export function normalizeOrgSettings(raw: unknown): OrgSettings {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    hideMembers: toFlag(record.hide_members),
    hideSubGroups: toFlag(record.hide_sub_groups),
    showPrivateRepoWatermark: toFlag(record.show_private_repo_watermark),
    groupProtection: toFlag(record.group_protection),
    emailVerification: toStringList(record.email_verification),
    npcPriceLimit: toNonNegativeInt(record.npc_price_limit),
    visitorNpcPriceLimit: toNonNegativeInt(record.visitor_npc_price_limit),
    values: splitSettingValues(record.values),
    // 上级限制位缺失按「无限制」处理（理由见 toFlag 注释）
    canShowMembers: toFlag(record.can_show_members, true),
    canShowSubGroups: toFlag(record.can_show_sub_groups, true),
    canShowWatermark: toFlag(record.can_show_watermark, true),
    rootGroupProtection: toFlag(record.root_group_protection),
    rootNpcPriceLimit: toNonNegativeInt(record.root_npc_price_limit),
  }
}

/**
 * 把归一化设置反向拼成 dto.GroupSettingReq（导出为纯函数以便单测）。
 *
 * **只提交 GroupSettingReq 声明的 8 个字段**：can_show_* / root_* 是服务端
 * 返回的只读限制位与基线，塞进请求体轻则被忽略、重则触发 400（未知字段），
 * 因此显式白名单而不是展开对象。
 *
 * values 语义（覆盖写）：服务端以提交内容为准整体替换，因此 UI 必须提交
 * 当前**全部**勾选项，而不是本次变化的增量。
 */
export function buildGroupSettingBody(input: OrgSettings): Record<string, unknown> {
  return {
    hide_members: input.hideMembers ? 1 : 0,
    hide_sub_groups: input.hideSubGroups ? 1 : 0,
    show_private_repo_watermark: input.showPrivateRepoWatermark ? 1 : 0,
    group_protection: input.groupProtection ? 1 : 0,
    // 数组逐项 trim + 去空（用户可能在标签输入里留下空白项）
    email_verification: input.emailVerification.map(item => item.trim()).filter(Boolean),
    npc_price_limit: toNonNegativeInt(input.npcPriceLimit),
    visitor_npc_price_limit: toNonNegativeInt(input.visitorNpcPriceLimit),
    // 去重后逗号拼接（服务端口径：逗号分隔的枚举组合）
    values: [...new Set(input.values)].filter(Boolean).join(','),
  }
}

/**
 * 读取组织安全设置。
 *
 * 端点：GET /{slug}/-/settings，scope group-manage:r。
 * 403（缺 group-manage:r）属预期降级：调用方（OrgSettingsTab 安全设置段）
 * 单独渲染错误态，不影响组织信息段与危险区。红线：403 绝不登出。
 */
export async function fetchOrgSettings(slug: string): Promise<OrgSettings> {
  const raw = await cnbFetch<unknown>(`/${encodeSlugPath(slug)}/-/settings`)
  return normalizeOrgSettings(raw)
}

/**
 * 保存组织安全设置（覆盖写）。
 *
 * 端点：PUT /{slug}/-/settings，scope group-manage:rw，返回 200 空 body
 * → 必须走 cnbFetchVoid（见文件头约束 2）。
 * 刻意不做「即时保存」：33 个开关逐个发请求既慢又容易半途失败。
 */
export async function saveOrgSettings(slug: string, input: OrgSettings): Promise<void> {
  await cnbFetchVoid(`/${encodeSlugPath(slug)}/-/settings`, {
    method: 'PUT',
    body: JSON.stringify(buildGroupSettingBody(input)),
  })
}

// ---------------------------------------------------------------------------
// 组织信息（PUT /{group}）
// ---------------------------------------------------------------------------

/**
 * 组织信息增量更新补丁。
 *
 * **字段语义是「undefined = 不动」而不是「空串 = 不动」**：
 * - 键不存在（undefined）→ 不提交，服务端保持原值；
 * - 空串 → 视为用户主动清空该字段，照常提交（例如清掉已绑定的域名）。
 * 这是设计文档 §2.1 的硬要求：GET /{group} 不回传 email/domain/remark/
 * wechat_mp，无法回填输入框，因此"空即提交空串"会误清空线上数据。
 */
export interface OrgProfilePatch {
  /** 组织描述（可回填） */
  description?: string
  /** 组织主页（可回填，服务端要求带协议前缀） */
  site?: string
  /** 联系邮箱（不可回填，留空即不修改） */
  email?: string
  /** 绑定域名（不可回填） */
  domain?: string
  /** 组织备注（不可回填） */
  remark?: string
  /** 微信公众号（不可回填） */
  wechatMp?: string
  /** README 仓库路径（不可回填；readme_repo_id 需先查仓库 ID，本轮不做） */
  readmeRepoPath?: string
}

/** patch 键 → dto.UpdateGroupReq 字段名（顺序即请求体键顺序） */
const UPDATE_GROUP_FIELDS: [keyof OrgProfilePatch, string][] = [
  ['description', 'description'],
  ['site', 'site'],
  ['email', 'email'],
  ['domain', 'domain'],
  ['remark', 'remark'],
  ['wechatMp', 'wechat_mp'],
  ['readmeRepoPath', 'readme_repo_path'],
]

/**
 * 把 patch 拼成 dto.UpdateGroupReq（导出为纯函数以便单测）。
 *
 * 只收集值 !== undefined 的键；字符串统一 trim（用户输入的手误空白）。
 * 返回空对象表示「没有任何改动」——updateOrgProfile 据此直接短路，不发请求。
 */
export function buildUpdateGroupBody(patch: OrgProfilePatch): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  for (const [patchKey, apiKey] of UPDATE_GROUP_FIELDS) {
    const value = patch[patchKey]
    if (value === undefined) {
      // undefined = 用户未填写该项 → 绝不放进 body（否则清空线上已有值）
      continue
    }
    body[apiKey] = value.trim()
  }
  return body
}

/**
 * 更新组织信息（增量提交）。
 *
 * 端点：PUT /{group}，scope group-manage:rw，返回 200 空 body → cnbFetchVoid。
 * 全部字段都未改动时不发请求：空 body 的 PUT 既无意义，也可能被服务端
 * 按"清空所有可选字段"解释（不可预期的破坏）。
 */
export async function updateOrgProfile(slug: string, patch: OrgProfilePatch): Promise<void> {
  const body = buildUpdateGroupBody(patch)
  if (Object.keys(body).length === 0) {
    return
  }
  await cnbFetchVoid(`/${encodeSlugPath(slug)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
}

// ---------------------------------------------------------------------------
// 创建组织（POST /groups）
// ---------------------------------------------------------------------------

/** 创建组织入参（dto.CreateGroupReq 的可编辑子集） */
export interface CreateGroupInput {
  /** 组织路径，可含父路径（如 parent/new-group） */
  path: string
  /** 组织描述 */
  description?: string
  /** 组织备注 */
  remark?: string
  /** 根组织绑定域名 */
  bindDomain?: string
}

/**
 * 把创建入参拼成 dto.CreateGroupReq（导出为纯函数以便单测）。
 * 只放有值的字段：空串描述/备注提交上去会覆盖服务端默认值，无实际收益。
 */
export function buildCreateGroupBody(input: CreateGroupInput): Record<string, unknown> {
  const body: Record<string, unknown> = { path: input.path.trim() }
  const description = input.description?.trim()
  if (description) {
    body.description = description
  }
  const remark = input.remark?.trim()
  if (remark) {
    body.remark = remark
  }
  const bindDomain = input.bindDomain?.trim()
  if (bindDomain) {
    body.bind_domain = bindDomain
  }
  return body
}

/**
 * 创建组织 / 子组织。
 *
 * 端点：POST /groups，scope group-manage:rw，成功返回 201。
 * 用 cnbFetchVoid 而非 cnbFetch：swagger 未声明 201 响应 schema，
 * 无法确认响应体是否为空，直接丢弃更安全（成功判定只看 2xx）。
 * 成功后由调用方 fetchCnbGroups() 刷新列表并选中新组织。
 *
 * @throws Error 路径为空（编程错误兜底：UI 已有前置校验，不应触发）
 */
export async function createGroup(input: CreateGroupInput): Promise<void> {
  const body = buildCreateGroupBody(input)
  if (!body.path) {
    throw new Error('createGroup: path is required')
  }
  await cnbFetchVoid('/groups', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

// ---------------------------------------------------------------------------
// 转移组织（POST /{group}/-/transfer）
// ---------------------------------------------------------------------------

/**
 * 转移组织到目标父组织下。
 *
 * 端点：POST /{group}/-/transfer，scope group-manage:rw，返回 200 空 body
 * → cnbFetchVoid。转移后组织路径变化（原路径立即失效），调用方必须刷新
 * 组织列表；高危操作，UI 侧要求输入组织名二次确认（设计文档 §2.4）。
 *
 * @param slug 当前组织路径（body.source）
 * @param target 目标父组织路径（body.target）
 */
export async function transferGroup(slug: string, target: string): Promise<void> {
  await cnbFetchVoid(`/${encodeSlugPath(slug)}/-/transfer`, {
    method: 'POST',
    body: JSON.stringify({ source: slug, target: target.trim() }),
  })
}
