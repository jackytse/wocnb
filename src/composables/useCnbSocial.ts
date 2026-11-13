/**
 * 社区数据层（设计文档 §3.6，T09）—— 贡献者 / 周趋势 / Star 用户 / Fork。
 *
 * 覆盖端点（swagger 逐条核对）：
 * - GET /{slug}/-/contributor/simply?limit=&exclude_external_users=&keyword=
 *   → api.RepoContribSimply（top_100_contrib + total + with_npc_counts）
 * - GET /{slug}/-/contributor/trend?limit= → api.RepoContribTrend
 *   （repo_data: api.Week[] —— w 周时间戳 / c 提交数 / a 增行 / d 删行 / n NPC 提交）
 * - GET /{slug}/-/stars?filter_type=&page=&page_size= → dto.RepoStarUsers
 *   （**filter_type 必填**，枚举 all | followed，PRD v1.1 REQ-C7 复核确认；
 *   scope repo-basic-info:r —— 缺权限时由调用方呈现 forbidden，不整页降级）
 * - GET /{repo}/-/forks?start_from_root=&page=&page_size= → dto.ListForks
 *
 * 归一化范式与全库一致：snake_case 原始结构 → normalize → camelCase 全必填；
 * 数组恒 []、数字 ?? 0、字符串 || ''。
 */
import { cnbAvatarUrl, cnbFetch } from './useCnbAuth'

/** 编码 slug：逐段 encodeURIComponent（'/' 保留为路径分隔符） */
function encodeSlug(slug: string): string {
  return slug.split('/').map(encodeURIComponent).join('/')
}

// ---------------------------------------------------------------------------
// 贡献者（contributor/simply）
// ---------------------------------------------------------------------------

/** api.UserContributorSimply 原始结构 */
interface RawContributor {
  user_name?: string
  email?: string
  commit_count?: number
  npc_commit_count?: number
}

/** api.RepoContribSimply 原始结构 */
interface RawContribSimply {
  top_100_contrib?: RawContributor[]
  total?: number
  with_npc_counts?: boolean
}

/** 贡献者条目（头像墙展示用） */
export interface ContributorItem {
  username: string
  email: string
  commitCount: number
  /** NPC（机器账号）提交数；withNpcCounts 为 false 时无意义，调用方据此隐藏 */
  npcCommitCount: number
}

/** contributor/simply 归一化结果 */
export interface ContributorsResult {
  contributors: ContributorItem[]
  /** 贡献者总数（top_100_contrib 只是前 100 名的缩略统计） */
  total: number
  /** 是否包含 NPC 提交统计（false 时 npcCommitCount 无意义） */
  withNpcCounts: boolean
}

/**
 * 贡献者排名（GET /{slug}/-/contributor/simply，前 100 名缩略统计）。
 * @param opts.limit 数量上限（swagger 默认 15，最大 1000；默认取 100）
 */
export async function fetchContributors(
  slug: string,
  opts: { limit?: number } = {},
): Promise<ContributorsResult> {
  const query = new URLSearchParams({ limit: String(opts.limit ?? 100) })
  const raw = await cnbFetch<RawContribSimply>(`/${encodeSlug(slug)}/-/contributor/simply?${query}`)
  const list = Array.isArray(raw.top_100_contrib) ? raw.top_100_contrib : []
  return {
    contributors: list
      .map(item => ({
        username: item.user_name || '',
        email: item.email || '',
        commitCount: item.commit_count ?? 0,
        npcCommitCount: item.npc_commit_count ?? 0,
      }))
      .filter(item => item.username),
    total: raw.total ?? 0,
    withNpcCounts: !!raw.with_npc_counts,
  }
}

// ---------------------------------------------------------------------------
// 周趋势（contributor/trend 的仓库级 repo_data）
// ---------------------------------------------------------------------------

/** api.Week 原始结构 */
interface RawWeek {
  /** 周起始时间戳（秒） */
  w?: number
  /** 提交数 */
  c?: number
  /** 增行数 */
  a?: number
  /** 删行数 */
  d?: number
  /** NPC 提交数 */
  n?: number
}

/** api.RepoContribTrend 原始结构（仅取仓库级数据，用户级趋势本轮不用） */
interface RawContribTrend {
  repo_data?: RawWeek[]
  user_total?: number
  week_total?: number
  with_line_counts?: boolean
  with_npc_counts?: boolean
}

/** 单周数据点（图表输入） */
export interface WeekPoint {
  /** 周起始时间戳（秒；0 视为缺失，图表侧过滤） */
  w: number
  /** 提交数 */
  c: number
  /** 增行数（withLineCounts 为 false 时恒 0） */
  a: number
  /** 删行数 */
  d: number
  /** NPC 提交数（withNpcCounts 为 false 时恒 0） */
  n: number
}

/** 周趋势归一化结果 */
export interface TrendResult {
  weeks: WeekPoint[]
  userTotal: number
  weekTotal: number
  /** 是否统计增删行数（总提交 > 10000 的仓库服务端关闭，a/d 恒 0） */
  withLineCounts: boolean
  withNpcCounts: boolean
}

/**
 * 仓库周度趋势（GET /{slug}/-/contributor/trend，取仓库级 repo_data）。
 * 空数组由图表组件负责：不渲染图表容器（验收 2）。
 */
export async function fetchContributorTrend(slug: string): Promise<TrendResult> {
  const raw = await cnbFetch<RawContribTrend>(`/${encodeSlug(slug)}/-/contributor/trend?limit=100`)
  const list = Array.isArray(raw.repo_data) ? raw.repo_data : []
  return {
    weeks: list
      .map(item => ({
        w: item.w ?? 0,
        c: item.c ?? 0,
        a: item.a ?? 0,
        d: item.d ?? 0,
        n: item.n ?? 0,
      }))
      .filter(item => item.w > 0),
    userTotal: raw.user_total ?? 0,
    weekTotal: raw.week_total ?? 0,
    withLineCounts: !!raw.with_line_counts,
    withNpcCounts: !!raw.with_npc_counts,
  }
}

// ---------------------------------------------------------------------------
// Star 用户（dto.RepoStarUsers）
// ---------------------------------------------------------------------------

/** filter_type 枚举（swagger 必填；PRD v1.1 REQ-C7 复核确认两值） */
export type StarFilterType = 'all' | 'followed'

/** dto.StarUser 原始结构（仅取展示字段） */
interface RawStarUser {
  username?: string
  nickname?: string
  avatar?: string
  is_follow?: boolean
  stared_at?: string
}

/** dto.RepoStarUsers 原始结构 */
interface RawStarUsers {
  my_follow_count?: number
  total?: number
  users?: RawStarUser[]
}

/** Star 用户条目（头像 + 昵称 + 关注关系） */
export interface StarUserItem {
  username: string
  nickname: string
  /** 服务端头像地址；空串时调用方按 cnbAvatarUrl 兜底 */
  avatar: string
  isFollow: boolean
  staredAt: string
}

/** Star 用户查询结果 */
export interface StarUsersResult {
  /** 其中我关注的用户数（filter_type=followed 时的条数即为此值口径） */
  myFollowCount: number
  /** star 用户总数 */
  total: number
  users: StarUserItem[]
}

/**
 * Star 用户列表（GET /{slug}/-/stars，scope repo-basic-info:r）。
 * @param filterType 必填（swagger），默认 'all'
 */
export async function fetchStarUsers(
  slug: string,
  filterType: StarFilterType = 'all',
  opts: { page?: number, pageSize?: number } = {},
): Promise<StarUsersResult> {
  const query = new URLSearchParams({
    filter_type: filterType,
    page: String(opts.page ?? 1),
    page_size: String(opts.pageSize ?? 100),
  })
  const raw = await cnbFetch<RawStarUsers>(`/${encodeSlug(slug)}/-/stars?${query}`)
  const list = Array.isArray(raw.users) ? raw.users : []
  return {
    myFollowCount: raw.my_follow_count ?? 0,
    total: raw.total ?? 0,
    users: list
      .map(item => ({
        username: item.username || '',
        nickname: item.nickname || '',
        // avatar 缺省由 UI 层按 cnbAvatarUrl(username) 兜底（与 CNB 网站一致）
        avatar: item.avatar || '',
        isFollow: !!item.is_follow,
        staredAt: item.stared_at || '',
      }))
      .filter(item => item.username),
  }
}

/** Star 用户头像地址（avatar 空时按 CNB 规则 URL 兜底） */
export function starUserAvatar(item: StarUserItem): string {
  return item.avatar || cnbAvatarUrl(item.username)
}

// ---------------------------------------------------------------------------
// Fork 列表（dto.ListForks）
// ---------------------------------------------------------------------------

/** dto.Forks 原始结构（仅取展示字段） */
interface RawFork {
  path?: string
  username?: string
  nickname?: string
  created_at?: string
  fork_count?: number
}

/** dto.ListForks 原始结构 */
interface RawListForks {
  fork_tree_count?: number
  forks?: RawFork[]
}

/** Fork 条目（表格行 + 点击跳转目标） */
export interface ForkItem {
  /** Fork 仓库完整路径（点击跳转 /repos/{path}） */
  path: string
  /** Fork 仓库显示名（path 尾段） */
  name: string
  username: string
  nickname: string
  createdAt: string
  forkCount: number
}

/** Fork 列表结果 */
export interface ForksResult {
  /** Fork 树总量（forks 只是当前页） */
  forkTreeCount: number
  forks: ForkItem[]
}

/**
 * Fork 列表（GET /{repo}/-/forks，scope repo-basic-info:r）。
 * @param opts.startFromRoot 从 fork 根节点开始展示（默认 false，展示直接 fork）
 */
export async function fetchForks(
  slug: string,
  opts: { page?: number, pageSize?: number, startFromRoot?: boolean } = {},
): Promise<ForksResult> {
  const query = new URLSearchParams({
    page: String(opts.page ?? 1),
    page_size: String(opts.pageSize ?? 50),
  })
  if (opts.startFromRoot) {
    query.set('start_from_root', '1')
  }
  const raw = await cnbFetch<RawListForks>(`/${encodeSlug(slug)}/-/forks?${query}`)
  const list = Array.isArray(raw.forks) ? raw.forks : []
  return {
    forkTreeCount: raw.fork_tree_count ?? 0,
    forks: list
      .map(item => ({
        path: item.path || '',
        name: (item.path || '').split('/').pop() || '',
        username: item.username || '',
        nickname: item.nickname || '',
        createdAt: item.created_at || '',
        forkCount: item.fork_count ?? 0,
      }))
      .filter(item => item.path),
  }
}

// ---------------------------------------------------------------------------
// 粉丝 / 关注（T14，scope account-engage:r）
// ---------------------------------------------------------------------------

/** dto.UserFollowResult 原始结构（仅声明用到的字段） */
interface RawFollowUser {
  username?: string
  nickname?: string
  is_following?: boolean
}

/** 粉丝/关注条目（抽屉列表项；点击外跳 https://cnb.cool/{username}） */
export interface FollowUserItem {
  username: string
  nickname: string
  /** 我是否已关注该用户（is_following） */
  isFollowing: boolean
}

/** 用户主页外跳地址（应用内无用户页路由 —— 红线：别造路由，一律外跳） */
export function cnbUserProfileUrl(username: string): string {
  return `https://cnb.cool/${username}`
}

/**
 * 粉丝列表（GET /users/{username}/followers，scope account-engage:r）。
 * 缺 account-engage:r 时 403 —— 调用方（profile 页）计数显示「—」、
 * 抽屉空态，不阻塞资料编辑等既有功能。
 */
export async function fetchUserFollowers(
  username: string,
  opts: { page?: number, pageSize?: number } = {},
): Promise<FollowUserItem[]> {
  return fetchFollowList(`/users/${encodeURIComponent(username)}/followers`, opts)
}

/**
 * 关注列表（GET /users/{username}/following，scope account-engage:r）。
 * 与粉丝列表同构（dto.UserFollowResult[]），共用归一化。
 */
export async function fetchUserFollowing(
  username: string,
  opts: { page?: number, pageSize?: number } = {},
): Promise<FollowUserItem[]> {
  return fetchFollowList(`/users/${encodeURIComponent(username)}/following`, opts)
}

/** 粉丝/关注列表共用拉取与归一化 */
async function fetchFollowList(
  path: string,
  opts: { page?: number, pageSize?: number },
): Promise<FollowUserItem[]> {
  const query = new URLSearchParams({
    page: String(opts.page ?? 1),
    page_size: String(opts.pageSize ?? 100),
  })
  const raw = await cnbFetch<RawFollowUser[]>(`${path}?${query}`)
  if (!Array.isArray(raw)) {
    return []
  }
  return raw
    .map(item => ({
      username: item.username || '',
      nickname: item.nickname || '',
      isFollowing: !!item.is_following,
    }))
    .filter(item => item.username)
}

// ---------------------------------------------------------------------------
// 我的 Star / 他人 Star（T14，scope account-engage:r）
// ---------------------------------------------------------------------------

/** dto.Repos4User 原始结构（仅声明 Star 仓库卡片用到的字段） */
interface RawStarredRepo {
  path?: string
  name?: string
  description?: string
  web_url?: string
  star_count?: number
  fork_count?: number
  languages?: { language?: string, color?: string }
  updated_at?: string
}

/** Star 仓库条目（页签列表项；点击进应用内仓库详情） */
export interface StarredRepoItem {
  path: string
  name: string
  description: string
  starCount: number
  forkCount: number
  language: string
  updatedAt: string
}

function normalizeStarredRepo(raw: RawStarredRepo): StarredRepoItem {
  return {
    path: raw.path || '',
    name: raw.name || (raw.path || '').split('/').pop() || '',
    description: raw.description || '',
    starCount: raw.star_count ?? 0,
    forkCount: raw.fork_count ?? 0,
    language: raw.languages?.language || '',
    updatedAt: raw.updated_at || '',
  }
}

function normalizeStarredList(raw: unknown): StarredRepoItem[] {
  if (!Array.isArray(raw)) {
    return []
  }
  return (raw as RawStarredRepo[])
    .map(normalizeStarredRepo)
    .filter(item => item.path)
}

/**
 * 我的 Star 仓库（GET /user/stared-repos?search=&page=&page_size=）。
 * 「我的 Star」页签数据源。⚠️ 红线：UI 不提供任何"点 Star"入口
 * （PRD §5：Star 操作只能去 CNB 网站端）。
 */
export async function fetchMyStarredRepos(
  opts: { search?: string, page?: number, pageSize?: number } = {},
): Promise<StarredRepoItem[]> {
  const query = new URLSearchParams({
    page: String(opts.page ?? 1),
    page_size: String(opts.pageSize ?? 50),
  })
  if (opts.search) {
    query.set('search', opts.search)
  }
  const raw = await cnbFetch<RawStarredRepo[]>(`/user/stared-repos?${query}`)
  return normalizeStarredList(raw)
}

/** 他人 Star 仓库（GET /users/{username}/stared-repos，与 /user 版同构） */
export async function fetchUserStarredRepos(
  username: string,
  opts: { page?: number, pageSize?: number } = {},
): Promise<StarredRepoItem[]> {
  const query = new URLSearchParams({
    page: String(opts.page ?? 1),
    page_size: String(opts.pageSize ?? 50),
  })
  const raw = await cnbFetch<RawStarredRepo[]>(
    `/users/${encodeURIComponent(username)}/stared-repos?${query}`,
  )
  return normalizeStarredList(raw)
}

// ---------------------------------------------------------------------------
// 个人仓库墙（T14 只读复用，scope account-engage:r）
// ---------------------------------------------------------------------------

/**
 * 个人仓库墙（GET /users/{username}/pinned-repos，scope account-engage:r）。
 * PinnedRepoWall mode="readonly" 的数据源；响应为 dto.Repos4User[]（比
 * 组织墙的 Repos4UserBase 多 languages 等字段，归一化取同一公共子集）。
 */
export async function fetchUserPinnedRepos(username: string): Promise<StarredRepoItem[]> {
  const raw = await cnbFetch<RawStarredRepo[]>(
    `/users/${encodeURIComponent(username)}/pinned-repos`,
  )
  return normalizeStarredList(raw)
}
