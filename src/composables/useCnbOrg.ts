/**
 * 组织（group）数据层（设计文档 §3.7，T13）。
 *
 * 覆盖端点（swagger 逐条核对）：
 * - GET /{group} → dto.OrganizationUnion（组织概览，scope group-resource:r）
 * - GET /{slug}/-/sub-groups?search=&page=&page_size= → dto.OrganizationUnion[]
 *   （子组织列表，scope group-resource:r）
 * - GET /{slug}/-/pinned-repos → dto.Repos4UserBase[]（仓库墙，scope group-manage:r；
 *   403 时仅仓库墙区块降级，不影响组织页其余部分）
 * - PUT /{slug}/-/pinned-repos（body: 全量 string[]，scope group-manage:rw；
 *   返回更新后的 Repos4UserBase[] —— 调用方以「不抛错」判定成功并重拉）
 * - GET /{group}/-/members/{username}/access-level → dto.MemberAccessLevel[]
 *   （单成员权限，scope group-manage:r；R9 按需加载，禁止列表页 N+1 自动请求）
 * - GET /{group}/-/inherit-members?search=&role=&page=&page_size=
 *   → dto.ListInheritMembers[]（继承成员，scope group-manage:r）
 *
 * 归一化范式与全库一致：snake_case → camelCase，数组恒 []、数字 ?? 0、
 * 字符串 || ''。
 */
import { cnbFetch, cnbAvatarUrl } from './useCnbAuth'

/** 编码 slug：逐段 encodeURIComponent（'/' 保留为路径分隔符） */
function encodeSlug(slug: string): string {
  return slug.split('/').map(encodeURIComponent).join('/')
}

// ---------------------------------------------------------------------------
// 组织概览（GET /{group}）
// ---------------------------------------------------------------------------

/** dto.OrganizationAccess 原始结构（仅声明用到的字段） */
interface RawOrgUnion {
  name?: string
  path?: string
  description?: string
  member_count?: number
  all_member_count?: number
  sub_group_count?: number
  all_sub_repo_count?: number
  sub_repo_count?: number
  follow_count?: number
  all_sub_mission_count?: number
  all_sub_registry_count?: number
  site?: string
  domain?: string
  created_at?: string
  updated_at?: string
  /**
   * 当前用户在该组织的最高权限角色（constant.AccessRole）。
   *
   * ⚠️ 关键字段（2026-11-11 QA 回归抓出的自伤缺陷的修复点）：
   * `GET /{group}` 的 200 schema 是 `dto.OrganizationAccess`，其中明确含
   * `access_role`（描述「用户在当前资源的最大权限」）。早期实现误以为
   * 该接口不返回它，下钻子组织时把 access_role 硬编码成空串 —— 结果
   * `canManageRole('')` 恒为 false，用户对自己的子组织**三个页签全部只读**
   * （设置看不了改不了、保护分支无写入口、成员无法增删改）。
   * 子组织只能通过 `?slug=` 下钻到达，因此这条等于「子组织在桌面端不可治理」。
   */
  access_role?: string
  // —— 以下 4 个字段用于「组织信息」表单回填（同属 dto.OrganizationAccess；
  //    domain 在上方已声明）——
  // 早期版本因为文档写「接口不返回」而只回填了 description/site，导致用户
  // 看不到现存值、重复填写时容易出错。实测 schema 里它们都在。
  /** 组织联系邮箱 */
  email?: string
  /** 组织备注 */
  remark?: string
  /** 组织微信公众号 */
  wechat_mp?: string
  /** 用于展示 README 的仓库路径 */
  readme_repo_path?: string
}

/** 组织概览（概览卡展示用；缺省字段由 UI 显示「—」，故数字用 -1 表示缺失） */
export interface OrgOverview {
  name: string
  path: string
  description: string
  /** 直接成员数 */
  memberCount: number
  /** 全部成员数（含子组织） */
  allMemberCount: number
  /** 下一级子组织数 */
  subGroupCount: number
  /** 仓库数（含子组织） */
  allSubRepoCount: number
  /** 关注数（服务端缺失时为 -1，UI 显示「—」而非 0 —— 0 与缺失语义不同） */
  followCount: number
  site: string
  updatedAt: string
  /** 当前用户在该组织的最高权限角色（Master/Owner 可管理；缺失为空串） */
  accessRole: string
  /** 组织联系邮箱（信息表单回填用） */
  email: string
  /** 组织绑定域名（信息表单回填用） */
  domain: string
  /** 组织备注（信息表单回填用） */
  remark: string
  /** 组织微信公众号（信息表单回填用） */
  wechatMp: string
  /** README 仓库路径（信息表单回填用） */
  readmeRepoPath: string
}

/**
 * 组织概览（GET /{group}，scope group-resource:r → dto.OrganizationAccess）。
 * 概览卡据此展示头像/描述/仓库数/成员数/子组织数；
 * **同时是「当前用户在该组织的角色」的唯一来源**（access_role），
 * 子组织下钻时的 canManage 判定依赖它。
 */
export async function fetchOrgOverview(groupPath: string): Promise<OrgOverview> {
  const raw = await cnbFetch<RawOrgUnion>(`/${encodeSlug(groupPath)}`)
  return {
    name: raw.name || groupPath,
    path: raw.path || groupPath,
    description: raw.description || '',
    memberCount: raw.member_count ?? 0,
    allMemberCount: raw.all_member_count ?? raw.member_count ?? 0,
    subGroupCount: raw.sub_group_count ?? 0,
    allSubRepoCount: raw.all_sub_repo_count ?? raw.sub_repo_count ?? 0,
    // follow_count 缺失（服务端未返回）→ -1（UI 显示「—」）；0 是合法值（无人关注）
    followCount: typeof raw.follow_count === 'number' ? raw.follow_count : -1,
    site: raw.site || '',
    updatedAt: raw.updated_at || '',
    // 角色缺失按空串（canManageRole('') = false，写入口保守隐藏，403 兜底仍在）
    accessRole: raw.access_role || '',
    email: raw.email || '',
    domain: raw.domain || '',
    remark: raw.remark || '',
    wechatMp: raw.wechat_mp || '',
    readmeRepoPath: raw.readme_repo_path || '',
  }
}

// ---------------------------------------------------------------------------
// 子组织（GET /{slug}/-/sub-groups）
// ---------------------------------------------------------------------------

/** 子组织条目（网格卡展示 + 点击下钻） */
export interface SubGroupItem {
  name: string
  path: string
  description: string
  memberCount: number
  allSubRepoCount: number
  subGroupCount: number
}

/**
 * 子组织列表（GET /{slug}/-/sub-groups，scope group-resource:r）。
 * @param opts.search 服务端按组织名筛选
 */
export async function fetchSubGroups(
  slug: string,
  opts: { search?: string, page?: number, pageSize?: number } = {},
): Promise<SubGroupItem[]> {
  const query = new URLSearchParams({
    page: String(opts.page ?? 1),
    page_size: String(opts.pageSize ?? 50),
  })
  if (opts.search) {
    query.set('search', opts.search)
  }
  const raw = await cnbFetch<RawOrgUnion[]>(`/${encodeSlug(slug)}/-/sub-groups?${query}`)
  if (!Array.isArray(raw)) {
    return []
  }
  return raw
    .map(item => ({
      name: item.name || '',
      path: item.path || '',
      description: item.description || '',
      memberCount: item.member_count ?? 0,
      allSubRepoCount: item.all_sub_repo_count ?? item.sub_repo_count ?? 0,
      subGroupCount: item.sub_group_count ?? 0,
    }))
    .filter(item => item.path)
}

// ---------------------------------------------------------------------------
// 仓库墙（GET/PUT /{slug}/-/pinned-repos）
// ---------------------------------------------------------------------------

/** dto.Repos4UserBase 原始结构（仅声明用到的字段） */
interface RawPinnedRepo {
  path?: string
  name?: string
  description?: string
  star_count?: number
  fork_count?: number
  language?: string
  updated_at?: string
  web_url?: string
}

/** 仓库墙条目（卡片展示用） */
export interface PinnedRepoItem {
  path: string
  name: string
  description: string
  starCount: number
  forkCount: number
  language: string
  updatedAt: string
}

function normalizePinnedRepo(raw: RawPinnedRepo): PinnedRepoItem {
  return {
    path: raw.path || '',
    name: raw.name || (raw.path || '').split('/').pop() || '',
    description: raw.description || '',
    starCount: raw.star_count ?? 0,
    forkCount: raw.fork_count ?? 0,
    language: raw.language || '',
    updatedAt: raw.updated_at || '',
  }
}

/**
 * 仓库墙列表（GET /{slug}/-/pinned-repos，scope group-manage:r）。
 * 注意：本端点 403（缺 group-manage:r）属**预期降级** —— 仓库墙仅对
 * 有管理权限的用户可见，调用方（PinnedRepoWall）按区块独立降级，
 * 绝不影响组织页其余区块。
 */
export async function fetchPinnedRepos(slug: string): Promise<PinnedRepoItem[]> {
  const raw = await cnbFetch<RawPinnedRepo[]>(`/${encodeSlug(slug)}/-/pinned-repos`)
  if (!Array.isArray(raw)) {
    return []
  }
  return raw.map(normalizePinnedRepo).filter(item => item.path)
}

/**
 * 保存仓库墙（PUT /{slug}/-/pinned-repos，scope group-manage:rw）。
 *
 * ⚠️ 提交的是**全量有序 path 数组**（swagger：request 为 array of string）——
 * 服务端以提交顺序作为墙上的展示顺序，因此上/下移只改本地数组顺序后
 * 整体 PUT，不做单条移动端点（CNB 无此端点，已裁决不引入拖拽库）。
 * 成功返回更新后的列表（服务端权威顺序），调用方据此即时反映。
 */
export async function savePinnedRepos(slug: string, repoPaths: string[]): Promise<PinnedRepoItem[]> {
  const raw = await cnbFetch<RawPinnedRepo[]>(`/${encodeSlug(slug)}/-/pinned-repos`, {
    method: 'PUT',
    body: JSON.stringify(repoPaths),
  })
  if (!Array.isArray(raw)) {
    return []
  }
  return raw.map(normalizePinnedRepo).filter(item => item.path)
}

// ---------------------------------------------------------------------------
// 单成员权限（GET /{group}/-/members/{username}/access-level，R9 按需加载）
// ---------------------------------------------------------------------------

/** dto.MemberAccessLevel 原始结构（用户在各路径上的角色，可能多条） */
interface RawMemberAccessLevel {
  path?: string
  access_level?: unknown
}

/**
 * 从 access_level 字段提取角色名（与 useCnbMembers 同款兼容逻辑：
 * 字符串优先，对象取 name/access_level/level —— 网关版本差异防御）。
 */
function normalizeAccessLevelValue(value: unknown): string {
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

/**
 * 单成员权限（GET /{group}/-/members/{username}/access-level）。
 *
 * 返回该成员在**各路径**上的角色（数组，通常 1 条）；UI 取与目标 slug
 * 匹配的条目，无匹配取第一条。403（缺 group-manage:r）由调用方按行
 * 显示「无权限」，绝不阻塞成员页主体（R9）。
 */
export async function fetchMemberAccessLevel(
  group: string,
  username: string,
): Promise<{ path: string, accessLevel: string }[]> {
  const raw = await cnbFetch<RawMemberAccessLevel[]>(
    `/${encodeSlug(group)}/-/members/${encodeURIComponent(username)}/access-level`,
  )
  if (!Array.isArray(raw)) {
    return []
  }
  return raw.map(item => ({
    path: item.path || '',
    accessLevel: normalizeAccessLevelValue(item.access_level),
  }))
}

/** 从单成员权限结果中取目标 slug 的角色（无精确匹配回退第一条，再回退空串） */
export function pickAccessLevelForSlug(
  levels: { path: string, accessLevel: string }[],
  slug: string,
): string {
  const matched = levels.find(item => item.path === slug)
  if (matched) {
    return matched.accessLevel
  }
  return levels[0]?.accessLevel || ''
}

// ---------------------------------------------------------------------------
// 继承成员（GET /{group}/-/inherit-members）
// ---------------------------------------------------------------------------

/** dto.InheritMembersUser 原始结构（仅声明用到的字段） */
interface RawInheritUser {
  username?: string
  nickname?: string
  avatar?: string
  access_level?: unknown
  join_time?: string
}

/** dto.ListInheritMembers 原始结构（按来源组织分组） */
interface RawInheritMembers {
  inherit_path?: string
  total?: number
  users?: RawInheritUser[]
}

/** 继承成员条目 */
export interface InheritMemberItem {
  username: string
  nickname: string
  avatar: string
  accessLevel: string
  joinTime: string
}

/** 继承成员分区（按来源路径） */
export interface InheritMemberGroup {
  /** 来源组织路径（如 parent-org），「来源路径」列展示用 */
  inheritPath: string
  /** 该来源的成员数 */
  total: number
  users: InheritMemberItem[]
}

/**
 * 继承成员（GET /{group}/-/inherit-members，scope group-manage:r）。
 * 服务端按 inherit_path 分组返回（每个元素 = 一个来源组织及其成员），
 * 归一化保持分区结构（验收 5：按 inherit_path 分区展示 + 来源路径 + 人数）。
 */
export async function fetchInheritMembers(
  group: string,
  opts: { page?: number, pageSize?: number } = {},
): Promise<InheritMemberGroup[]> {
  const query = new URLSearchParams({
    page: String(opts.page ?? 1),
    page_size: String(opts.pageSize ?? 100),
  })
  const raw = await cnbFetch<RawInheritMembers[]>(
    `/${encodeSlug(group)}/-/inherit-members?${query}`,
  )
  if (!Array.isArray(raw)) {
    return []
  }
  return raw.map(section => ({
    inheritPath: section.inherit_path || '',
    total: section.total ?? (Array.isArray(section.users) ? section.users.length : 0),
    users: (Array.isArray(section.users) ? section.users : [])
      .map(user => ({
        username: user.username || '',
        nickname: user.nickname || '',
        avatar: user.avatar || (user.username ? cnbAvatarUrl(user.username) : ''),
        accessLevel: normalizeAccessLevelValue(user.access_level),
        joinTime: user.join_time || '',
      }))
      .filter(user => user.username),
  })).filter(section => section.inheritPath || section.users.length > 0)
}

// ---------------------------------------------------------------------------
// 组织用量统计（charge 域）—— 2026-11-11 恢复 + 增强
//
// 背景：本轮 T13 重写组织页时用量区块未随迁，HomeGroupOverview.vue 沦为
// 死代码。本节把用量数据层收口到组织域，并新增两个维度：
// - 仓库粒度用量：GET /{slug}/-/charge/repos-volume（分页）—— 找出用量大户
// - 特权额度：GET /{slug}/-/charge/special-amount —— 特权核时/存储 + 有效期
// ---------------------------------------------------------------------------

/** dto.RepoVolume 原始结构（swagger：volume 为 string 类型，需转数字） */
interface RawRepoVolume {
  slug?: string
  /** 用量：存储 byte / 核时核秒 / milli_credit；服务端返回字符串 */
  volume?: string
  resource_id?: string
  /** 资源类型（constant.SlugType 枚举为 int，UI 不展示该列，见下方说明） */
  resource_type?: number
  is_deleted?: boolean
}

/**
 * 仓库粒度用量条目（已归一化）。
 *
 * resource_type 不展示的原因：constant.SlugType 的 x-enum-comments 与
 * enum 值的对应关系在 swagger 里存在歧义（comments 顺序 Group/Mission/
 * Registry/Repo/Unknown vs enum [0..4]），无法确定 1 是否为 Repo。
 * 在拿到官方明确映射前 UI 不渲染该列，避免展示错误的类型名。
 */
export interface CnbRepoVolumeItem {
  /** 仓库/资源完整路径（如 org/repo） */
  slug: string
  /** 用量数值（服务端字符串转数字，非法值按 0） */
  volume: number
  /** 服务端是否已标记删除（已删除条目 UI 灰显） */
  isDeleted: boolean
}

/**
 * 归一化单条仓库用量（导出为纯函数以便单测）。
 *
 * 防御规则：
 * - volume 是 string（服务端口径），Number() 转换失败（NaN/负数）按 0；
 * - slug 缺失的条目直接丢弃（没有地址的用量无法定位，展示无意义）；
 * - is_deleted 缺省 false（服务端该字段始终返回，但按防御式口径兜底）。
 */
export function normalizeRepoVolume(raw: RawRepoVolume): CnbRepoVolumeItem | null {
  const slug = raw.slug || ''
  if (!slug) {
    return null
  }
  const parsed = Number(raw.volume)
  return {
    slug,
    volume: Number.isFinite(parsed) && parsed > 0 ? parsed : 0,
    isDeleted: raw.is_deleted === true,
  }
}

/** repos-volume 单页条数（与仓库列表页保持一致的默认值） */
export const REPOS_VOLUME_PAGE_SIZE = 20

/**
 * 获取组织仓库粒度用量（分页）。
 *
 * 端点：GET /{slug}/-/charge/repos-volume?type=&page=&page_size=
 * scope：group-resource:r（与 volume/quota 相同，缺权限时 403 由调用方降级）。
 *
 * 分页语义：swagger 未提供总数/hasMore 字段，本函数以「本页返回条数
 * 是否等于 pageSize」近似判断 hasMore —— 服务端若恰好在最后一页返回
 * 整页条数，UI 会多请求一次空页后停止（代价可接受，不猜总数）。
 *
 * type 参数刻意不透传：SlugType 枚举映射歧义（见 CnbRepoVolumeItem 注释），
 * 不传返回全部资源类型的用量，前端不做类型过滤。
 *
 * @param slug 组织路径
 * @param page 页码（1 起）
 */
export async function fetchGroupReposVolume(
  slug: string,
  page = 1,
): Promise<CnbRepoVolumeItem[]> {
  const query = new URLSearchParams({
    page: String(page),
    page_size: String(REPOS_VOLUME_PAGE_SIZE),
  })
  const raw = await cnbFetch<RawRepoVolume[]>(
    `/${encodeSlug(slug)}/-/charge/repos-volume?${query}`,
  )
  if (!Array.isArray(raw)) {
    return []
  }
  return raw
    .map(normalizeRepoVolume)
    .filter((item): item is CnbRepoVolumeItem => item !== null)
}

/**
 * 特权额度条目（已归一化）。
 *
 * dto.SpecialAmount 是「值 + 说明 + 有效期」三件套的扁平结构：
 * {compute_build_corehour, compute_build_desc, compute_build_expire, ...}。
 * 归一化时按后缀拆对：无后缀键 = 数值，_desc = 说明，_expire = 过期时间。
 */
export interface CnbSpecialAmountItem {
  /** 资源标识（compute_build_corehour / storage_git_gib / credit 等） */
  key: string
  /** 特权数值（核时 / GiB / credit） */
  value: number
  /** 服务端提供的说明文案（缺失为空串） */
  desc: string
  /** 过期时间 ISO 串；空串 = 永久有效（服务端 null） */
  expire: string
}

/** dto.SpecialAmount 原始结构（键集合动态，按后缀拆对） */
type RawSpecialAmount = Record<string, number | string | null | undefined>

/**
 * 归一化特权额度（导出为纯函数以便单测）。
 *
 * 规则：
 * - 跳过 _desc / _expire 后缀键（它们是配套字段，不是独立条目）；
 * - 数值 <= 0 的条目不产出（没有特权的资源展示出来只是噪音）；
 * - expire 为 null / undefined → ''（永久有效，swagger：null 即永久）。
 */
export function normalizeSpecialAmount(raw: RawSpecialAmount): CnbSpecialAmountItem[] {
  const items: CnbSpecialAmountItem[] = []
  for (const [key, value] of Object.entries(raw ?? {})) {
    // 跳过配套的说明/有效期键，只处理数值主键
    if (key.endsWith('_desc') || key.endsWith('_expire')) {
      continue
    }
    const num = Number(value)
    if (!Number.isFinite(num) || num <= 0) {
      continue
    }
    const expireRaw = raw[`${key}_expire`]
    items.push({
      key,
      value: num,
      desc: typeof raw[`${key}_desc`] === 'string' ? (raw[`${key}_desc`] as string) : '',
      // null 即永久有效（swagger 原文），归一为空串
      expire: typeof expireRaw === 'string' && expireRaw ? expireRaw : '',
    })
  }
  return items
}

/**
 * 获取组织特权额度。
 *
 * 端点：GET /{slug}/-/charge/special-amount，scope group-resource:r。
 * 返回空数组表示该组织无任何特权额度（UI 隐藏整个区块）。
 */
export async function fetchGroupSpecialAmount(slug: string): Promise<CnbSpecialAmountItem[]> {
  const raw = await cnbFetch<RawSpecialAmount>(
    `/${encodeSlug(slug)}/-/charge/special-amount`,
  )
  return normalizeSpecialAmount(raw)
}

/**
 * 用量占用率 → 告警级别（导出为纯函数以便单测）。
 *
 * 阈值约定（新增优化项，原 HomeGroupOverview 只有默认单色进度条）：
 * - < 80%  → 'ok'（主题默认色）
 * - ≥ 80%  → 'warning'（橙色，提示开始吃紧）
 * - ≥ 95%  → 'danger'（红色，临近超限，构建/开发可能被拒）
 * total <= 0（未配置额度）恒为 'ok'，避免除零与误导。
 */
export type UsageSeverity = 'ok' | 'warning' | 'danger'

export function usageSeverity(percent: number): UsageSeverity {
  if (percent >= 95) {
    return 'danger'
  }
  if (percent >= 80) {
    return 'warning'
  }
  return 'ok'
}
