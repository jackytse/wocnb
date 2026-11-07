/**
 * CNB 组织成员 / 外部贡献者数据层。
 *
 * 端点（swagger 已核对）：
 * - GET /{group}/-/members —— 组织成员列表（dto.UsersWithAccessLevelInSlug，
 *   scope: group-manage:r，令牌缺权限时 403）；
 * - GET /{slug}/-/outside-collaborators —— 外部贡献者列表
 *   （dto.OutsideCollaboratorInRepo，scope: repo-manage:r）。
 *
 * 归一化约定：snake_case → camelCase + 空值兜底，沿用 useCnbRepo 既有范式。
 */
import { cnbFetch, cnbAvatarUrl } from './useCnbAuth'

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
    `/${encodeURIComponent(group)}/-/members?${query}`,
  )
  if (!Array.isArray(raw)) {
    return []
  }
  return raw.map(normalizeMember).filter(m => m.username)
}

/**
 * 获取仓库/组织的外部贡献者列表。
 * 端点：GET /{slug}/-/outside-collaborators?search=&page=（scope: repo-manage:r）。
 * 响应结构与成员列表一致（dto.OutsideCollaboratorInRepo），共用归一化。
 */
export async function fetchOutsideCollaborators(
  slug: string,
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
    `/${encodeURIComponent(slug)}/-/outside-collaborators?${query}`,
  )
  if (!Array.isArray(raw)) {
    return []
  }
  return raw.map(normalizeMember).filter(m => m.username)
}
