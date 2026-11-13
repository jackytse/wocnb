/**
 * CNB 组织成员 / 外部贡献者数据层。
 *
 * 端点（swagger 已核对）：
 * - GET /{group}/-/members —— 组织成员列表（dto.UsersWithAccessLevelInSlug，
 *   scope: group-manage:r，令牌缺权限时 403）；
 * - GET /{slug}/-/outside-collaborators —— 外部贡献者列表
 *   （dto.OutsideCollaboratorInRepo，scope: repo-manage:r）。
 *
 * ⚠️ 能力边界（线上缺陷复盘，务必保留此约束）：
 * `outside-collaborators` 在 swagger 里的描述是「查询指定**仓库**的外部贡献者」，
 * 它只有仓库维度 —— 传组织路径（如 `my-group`）会返回
 * `400 {"errmsg":"This feature is not supported for organizations."}`。
 * 原因：外部贡献者是「仓库级」权限概念（不属于组织成员但拥有某仓库的特定权限），
 * 组织实体上根本不存在这种关系。因此本函数要求调用方传入**完整仓库路径**
 * （`组织/仓库` 或 `用户/仓库`），成员页必须先让用户选定仓库再调用。
 *
 * 归一化约定：snake_case → camelCase + 空值兜底，沿用 useCnbRepo 既有范式。
 *
 * 写操作（本文件 §2.5 / §2.6 / §2.7 部分）：
 * - POST /{group}/-/members/{username}     新增直属成员（scope: group-manage:rw）
 * - PUT  /{group}/-/members/{username}     修改已有直属成员角色（scope: group-manage:rw）
 * - DELETE /{group}/-/members/{username}   移除直属成员（scope: group-manage:rw）
 * - GET  /{group}/-/members/access-level   批量读权限（scope: group-manage:r）
 * - PUT  /{slug}/-/outside-collaborators/{username}?role=… 仓库级外部贡献者改角色
 * - DELETE /{slug}/-/outside-collaborators/{username}      仓库级外部贡献者移除
 * 三个成员写端点与两个贡献者写端点**都返回 200 + 空 body**，必须走 `cnbFetchVoid`；
 * 用 `cnbFetch` 会在 `response.json()` 处抛 "Unexpected end of JSON input"，
 * 把成功报成失败（用户会以为没生效而反复点击）。
 */
import { cnbFetch, cnbFetchVoid, cnbAvatarUrl } from './useCnbAuth'

/**
 * 编码资源路径：逐段 encodeURIComponent，保留 `/` 作为层级分隔符。
 *
 * 为什么不能整体 encodeURIComponent：`my-group/my-repo` 会被压成
 * `my-group%2Fmy-repo` 变成**单段**路径，网关无法路由到仓库资源
 * （多级子组织 `a/b` 同理）。逐段编码既保留层级，又能转义每段里的
 * 空格、`#`、`?` 等特殊字符。
 */
export function encodeSlugPath(slug: string): string {
  return slug
    .split('/')
    .filter(segment => segment.length > 0)
    .map(segment => encodeURIComponent(segment))
    .join('/')
}

/** 成员条目（两个端点响应结构一致，共用归一化） */
export interface MemberItem {
  username: string
  nickname: string
  avatar: string
  /** 权限级别（constant.AccessRole：Guest/Reporter/Developer/Master/Owner 等） */
  accessLevel: string
  /** 加入时间（ISO 8601，可能为空） */
  joinTime: string
}

/** dto.UsersWithAccessLevelInSlug 原始结构（仅声明用到的字段，snake_case） */
interface RawMember {
  username?: string
  nickname?: string
  avatar?: string
  /** access_level 可能为字符串枚举，也可能是对象（防御性兼容两种） */
  access_level?: unknown
  join_time?: string
}

/**
 * 从 access_level 字段提取可展示的角色名。
 * 为什么做兼容：constant.AccessRole 在 swagger 中声明为字符串枚举，
 * 但不同版本网关可能包装为 { name } / { access_level } 对象，
 * 字符串优先，其次取对象的 name / access_level / level 字段。
 */
function normalizeAccessLevel(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  if (value && typeof value === 'object') {
    const obj = value as { name?: unknown, access_level?: unknown, level?: unknown }
    for (const candidate of [obj.name, obj.access_level, obj.level]) {
      if (typeof candidate === 'string') {
        return candidate
      }
    }
  }
  return ''
}

/** RawMember → MemberItem：avatar 为空时按 CNB 默认头像规则兜底（与登录态一致） */
function normalizeMember(raw: RawMember): MemberItem {
  const username = raw.username || ''
  return {
    username,
    nickname: raw.nickname || username,
    avatar: raw.avatar || (username ? cnbAvatarUrl(username) : ''),
    accessLevel: normalizeAccessLevel(raw.access_level),
    joinTime: raw.join_time || '',
  }
}

/**
 * 获取组织（或任意 slug 资源）的成员列表。
 * 端点：GET /{group}/-/members?search=&page=&page_size=（scope: group-manage:r）。
 * @param group 组织路径（CnbGroup.path，支持多级子组织）
 * @param opts.search 按成员过滤（服务端模糊搜索）；page 页码从 1 开始
 */
export async function fetchGroupMembers(
  group: string,
  opts: { search?: string, page?: number, pageSize?: number } = {},
): Promise<MemberItem[]> {
  const query = new URLSearchParams({
    page: String(opts.page ?? 1),
    page_size: String(opts.pageSize ?? 50),
  })
  if (opts.search) {
    query.set('search', opts.search)
  }
  const raw = await cnbFetch<RawMember[]>(
    // group 支持多级子组织（`a/b`），必须逐段编码保留层级
    `/${encodeSlugPath(group)}/-/members?${query}`,
  )
  if (!Array.isArray(raw)) {
    return []
  }
  return raw.map(normalizeMember).filter(m => m.username)
}

/**
 * 获取**仓库**的外部贡献者列表。
 * 端点：GET /{slug}/-/outside-collaborators?search=&page=&page_size=
 *       （scope: repo-manage:r）。
 * 响应结构与成员列表一致（dto.OutsideCollaboratorInRepo），共用归一化。
 *
 * @param repoPath **完整仓库路径**（`组织/仓库`），传纯组织路径会 400
 *   （"This feature is not supported for organizations."）—— 见文件头说明
 */
export async function fetchOutsideCollaborators(
  repoPath: string,
  opts: { search?: string, page?: number, pageSize?: number } = {},
): Promise<MemberItem[]> {
  const query = new URLSearchParams({
    page: String(opts.page ?? 1),
    page_size: String(opts.pageSize ?? 50),
  })
  if (opts.search) {
    query.set('search', opts.search)
  }
  const raw = await cnbFetch<RawMember[]>(
    // 仓库路径必须逐段编码（整体编码会把 `/` 变成 %2F，路由到不存在的单段资源）
    `/${encodeSlugPath(repoPath)}/-/outside-collaborators?${query}`,
  )
  if (!Array.isArray(raw)) {
    return []
  }
  return raw.map(normalizeMember).filter(m => m.username)
}

/**
 * 判断错误是否为「组织不支持外部贡献者」的 400。
 *
 * 服务端固定返回英文 errmsg（无中文变体，也不随 Accept-Language 变化），
 * 因此按小写子串匹配；cnbFetch 已把 errmsg 拼进 message，无需再解析响应体。
 * 用于 UI 层把 400 从「红色加载失败」降级成「这是仓库级功能」的引导态。
 */
export function isOutsideCollaboratorsUnsupported(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '')
  return message.toLowerCase().includes('not supported for organizations')
}

// ---------------------------------------------------------------------------
// 写操作 · 组织直属成员（设计文档 §2.5）
// ---------------------------------------------------------------------------

/**
 * 组织成员角色枚举（constant.AccessRole）。
 * ⚠️ **大小写敏感**，服务端只认首字母大写的这 5 个值，传 'developer' 会被
 * 当成非法参数（400/422），因此全项目以本常量作为唯一真源。
 */
export const MEMBER_ROLES = ['Guest', 'Reporter', 'Developer', 'Master', 'Owner'] as const

/** 组织成员角色：'Guest' | 'Reporter' | 'Developer' | 'Master' | 'Owner' */
export type MemberRole = typeof MEMBER_ROLES[number]

/**
 * 外部贡献者角色枚举（**仅三档**）。
 * 为什么没有 Master / Owner：外部贡献者是**仓库级**授权，只给「某仓库」的
 * 读写能力，凭空拿到组织级管理权既无业务含义，服务端也会拒绝该取值。
 */
export const OUTSIDE_COLLABORATOR_ROLES = ['Guest', 'Reporter', 'Developer'] as const

/** 外部贡献者角色：'Guest' | 'Reporter' | 'Developer' */
export type OutsideCollaboratorRole = typeof OUTSIDE_COLLABORATOR_ROLES[number]

/** dto.UpdateMembersRequest（POST 新增与 PUT 改权限共用同一 body 结构） */
interface RawUpdateMembersRequest {
  /** 目标角色（AccessRole 枚举，首字母大写） */
  access_level: MemberRole
  /** 是否同时标记为该组织的外部协作者（可选，缺省由服务端保持原状） */
  is_outside_collaborator?: boolean
}

/** 成员写操作的附加选项（POST 新增时可顺带打标） */
export interface AddGroupMemberOptions {
  /** 设为外部协作者（POST body 的 is_outside_collaborator 字段） */
  isOutsideCollaborator?: boolean
}

/**
 * 拼装成员写端点路径：`/{group}/-/members/{username}`。
 *
 * - `group` 走 `encodeSlugPath`：多级子组织（`a/b`）必须逐段编码、保留 `/` 层级；
 * - `username` 走 `encodeURIComponent`：它是**单段路径参数**，CNB 用户名允许
 *   `@`、`.`、空格等字符，整体不编码会让 `a@b.com` 里的字符被网关误解析
 *   （甚至被当成路径分隔/查询起点），编码后是 `a%40b.com`。
 */
function memberWritePath(group: string, username: string): string {
  if (!username) {
    // 兜底防御：调用方（UI 表单）已校验非空，这里避免把 `/members/` 当成写目标
    // 打到列表端点上（会变成对列表的 POST，报 405 更难定位）
    throw new Error('成员用户名不能为空')
  }
  return `/${encodeSlugPath(group)}/-/members/${encodeURIComponent(username)}`
}

/**
 * 新增组织直属成员（POST /{group}/-/members/{username}，scope: group-manage:rw）。
 *
 * 与 {@link updateGroupMemberRole} 打的是**同一个 body**（dto.UpdateMembersRequest），
 * 唯一差别是 HTTP 方法：**POST = 新增**（用户此前不在该组织），
 * **PUT = 改权限**（用户已是直属成员）。服务端用方法而不是 body 区分语义，
 * 因此两个函数必须并存，不能合并成一个「设置角色」入口 —— 否则给非成员
 * PUT 会 404、给成员 POST 会 409/400。
 *
 * 响应 200 + 空 body → 走 `cnbFetchVoid`。
 *
 * @param group 组织路径（支持多级子组织）
 * @param username 目标用户（路径段，内部 encodeURIComponent）
 * @param role 角色（MEMBER_ROLES 之一，大小写敏感）
 * @param opts.isOutsideCollaborator 同时标记为该组织的外部协作者
 */
export async function addGroupMember(
  group: string,
  username: string,
  role: MemberRole,
  opts: AddGroupMemberOptions = {},
): Promise<void> {
  const body: RawUpdateMembersRequest = { access_level: role }
  // 只在用户显式勾选时带上该字段：缺省（undefined）表示「不改动外部协作者标记」，
  // 传 false 会主动清除服务端已有的标记，语义不同，不能随意兜底成 false
  if (opts.isOutsideCollaborator !== undefined) {
    body.is_outside_collaborator = opts.isOutsideCollaborator
  }
  await cnbFetchVoid(memberWritePath(group, username), {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/**
 * 修改**已有**直属成员的角色（PUT /{group}/-/members/{username}，
 * scope: group-manage:rw）。
 *
 * body 与 {@link addGroupMember} 完全一致，区别只在方法（见后者的注释）。
 * 响应 200 + 空 body → `cnbFetchVoid`。
 *
 * @param group 组织路径（支持多级子组织）
 * @param username 目标成员（路径段，内部 encodeURIComponent）
 * @param role 新角色（MEMBER_ROLES 之一）
 * @param opts.isOutsideCollaborator 可选：同时调整外部协作者标记
 */
export async function updateGroupMemberRole(
  group: string,
  username: string,
  role: MemberRole,
  opts: AddGroupMemberOptions = {},
): Promise<void> {
  const body: RawUpdateMembersRequest = { access_level: role }
  if (opts.isOutsideCollaborator !== undefined) {
    body.is_outside_collaborator = opts.isOutsideCollaborator
  }
  await cnbFetchVoid(memberWritePath(group, username), {
    method: 'PUT',
    body: JSON.stringify(body),
  })
}

/**
 * 移除组织直属成员（DELETE /{group}/-/members/{username}，scope: group-manage:rw）。
 *
 * 破坏性操作：UI 层必须经 ConfirmDialog + `typeToConfirm`（输入 username）
 * 二次确认后才调用本函数。响应 200 + 空 body → `cnbFetchVoid`。
 *
 * @param group 组织路径（支持多级子组织）
 * @param username 待移除成员（路径段，内部 encodeURIComponent）
 */
export async function removeGroupMember(group: string, username: string): Promise<void> {
  await cnbFetchVoid(memberWritePath(group, username), { method: 'DELETE' })
}

// ---------------------------------------------------------------------------
// 批量成员权限（设计文档 §2.6：GET /{group}/-/members/access-level）
// ---------------------------------------------------------------------------

/** dto.MemberAccessLevelInSlugUnion 中本模块关心的字段（其余字段与 UI 无关） */
interface RawMemberAccessLevel {
  username?: unknown
  access_level?: unknown
}

/**
 * 把批量权限端点的响应归一化成 `Map<username, 角色字符串>`。
 *
 * 为什么要兼容三种形态（swagger 与真实响应可能不一致）：
 * swagger 把响应当成**单个** `dto.MemberAccessLevelInSlugUnion`
 * （`access_level` / `inherit` / `read_privilege` / `write_privilege`），
 * 但接口语义是「当前层级**全部**成员的权限信息」，真实结构大概率是
 * `map[username]该对象`（Go 的 map 在 swagger 里常被展平成单对象描述）。三种形态：
 *
 * 1. map：`{ "alice": { access_level: "Master" }, ... }` → 逐键转条目；
 * 2. 数组：`[{ username: "alice", access_level: "Master" }, ...]` → 按元素取 username；
 * 3. 单对象（形如 `{ access_level, inherit, read_privilege, write_privilege }`，
 *    没有 username 维度）或任何无法识别结构 → **返回空 Map**。
 *    调用方（成员页）据此自动降级为「逐人按需加载」，绝不因为结构看不懂就报错。
 *
 * 角色归一化复用 {@link normalizeAccessLevel}：`access_level` 可能是字符串，
 * 也可能是 `{ name | access_level | level }` 对象（网关版本差异）。
 * 归一化为空字符串的条目直接丢弃（无角色 = 对 UI 无价值）。
 */
export function normalizeMemberAccessLevel(raw: unknown): Map<string, string> {
  const result = new Map<string, string>()

  // 形态 2：数组，username 在元素内
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== 'object') {
        continue
      }
      const entry = item as RawMemberAccessLevel
      const username = typeof entry.username === 'string' ? entry.username : ''
      const level = normalizeAccessLevel(entry.access_level)
      if (username && level) {
        result.set(username, level)
      }
    }
    return result
  }

  if (!raw || typeof raw !== 'object') {
    return result
  }

  // 形态 1 vs 形态 3 的判别：map 形态的**每个值都是对象**；
  // 单对象形态的值是标量（字符串/布尔/数字），据此区分。
  // 不用「键名是否等于 access_level」判断：用户名理论上可以是任意字符串，
  // 而「值全为对象」这条判据对两种形态都是充分且稳定的。
  const record = raw as Record<string, unknown>
  for (const [username, value] of Object.entries(record)) {
    if (!username || !value || typeof value !== 'object' || Array.isArray(value)) {
      // 命中标量值 → 这不是 map（单对象形态 / 未知结构），整体放弃
      return new Map<string, string>()
    }
  }

  for (const [username, value] of Object.entries(record)) {
    const entry = value as RawMemberAccessLevel
    const level = normalizeAccessLevel(entry.access_level)
    if (level) {
      result.set(username, level)
    }
  }
  return result
}

/**
 * 批量读取当前层级成员的权限（GET /{group}/-/members/access-level，
 * scope: group-manage:r）。
 *
 * 为什么需要它：成员列表的 `access_level` 在部分组织/分页下缺失，逐人请求
 * `/{group}/-/members/{username}/access-level` 会形成 N+1（R9 明确禁止），
 * 批量端点一次请求即可填满整页。
 *
 * @param group 组织路径（支持多级子组织）
 * @param includeInherit 是否包含从上级组织继承的成员权限
 *   （成员页的「成员」页签展示直属成员，传 false；继承成员有独立页签）
 * @returns username → 角色字符串（无法识别结构时为空 Map，由 UI 降级）
 */
export async function fetchGroupMembersAccessLevel(
  group: string,
  includeInherit: boolean,
): Promise<Map<string, string>> {
  const query = new URLSearchParams({ include_inherit: includeInherit ? 'true' : 'false' })
  const raw = await cnbFetch<unknown>(
    // 注意顺序：access-level 是 /members 下的**子资源**，必须先于 username 段，
    // 因此这里不能用 memberWritePath（那条路径用于单成员写操作）
    `/${encodeSlugPath(group)}/-/members/access-level?${query}`,
  )
  return normalizeMemberAccessLevel(raw)
}

// ---------------------------------------------------------------------------
// 写操作 · 外部贡献者（仓库级，设计文档 §2.7）
// ---------------------------------------------------------------------------

/**
 * 外部贡献者写端点的响应校验 + 路径拼装。
 *
 * ⚠️ 与成员写端点的关键差异（两处，写错必 400）：
 * 1. `{slug}` 是**仓库完整路径**（`组织/仓库`），传纯组织路径会被网关拒绝
 *    （`400 This feature is not supported for organizations.`，见文件头说明）；
 * 2. 角色走 **query 参数** `?role=`，不在 body 里（swagger 明确声明 query）。
 */
function outsideCollaboratorPath(repoPath: string, username: string): string {
  if (!repoPath) {
    throw new Error('外部贡献者是仓库级能力，必须传入完整仓库路径')
  }
  if (!username) {
    throw new Error('成员用户名不能为空')
  }
  return `/${encodeSlugPath(repoPath)}/-/outside-collaborators/${encodeURIComponent(username)}`
}

/**
 * 修改外部贡献者角色（PUT /{slug}/-/outside-collaborators/{username}?role=…）。
 *
 * 角色是 **query 参数**（不是 body）；枚举只有三档
 * （见 {@link OUTSIDE_COLLABORATOR_ROLES}，无 Master/Owner）。
 * `{slug}` 必须是**仓库完整路径**。响应 200 + 空 body → `cnbFetchVoid`。
 *
 * @param repoPath 完整仓库路径（`组织/仓库`）
 * @param username 目标用户（路径段，内部 encodeURIComponent）
 * @param role 三档角色之一（大小写敏感）
 */
export async function updateOutsideCollaborator(
  repoPath: string,
  username: string,
  role: string,
): Promise<void> {
  const query = new URLSearchParams({ role })
  await cnbFetchVoid(`${outsideCollaboratorPath(repoPath, username)}?${query}`, {
    method: 'PUT',
  })
}

/**
 * 移除仓库的外部贡献者（DELETE /{slug}/-/outside-collaborators/{username}）。
 *
 * 破坏性操作：UI 层必须经 ConfirmDialog + `typeToConfirm` 二次确认。
 * 响应 200 + 空 body → `cnbFetchVoid`。
 *
 * @param repoPath 完整仓库路径（`组织/仓库`）
 * @param username 目标用户（路径段，内部 encodeURIComponent）
 */
export async function removeOutsideCollaborator(repoPath: string, username: string): Promise<void> {
  await cnbFetchVoid(outsideCollaboratorPath(repoPath, username), { method: 'DELETE' })
}
