/**
 * CNB 仓库维度的数据层（本次增量的唯一接口出口）。
 *
 * 覆盖四个模块的全部端点（均为 swagger 已核对的既有端点，未臆造）：
 * - A 仓库详情 + 代码浏览（contents / raw / branches / tags / commits / head）
 * - B Issue（列表 / 详情 / 评论 / activities / 新建 / 关闭重开）
 * - C PR（列表 / 详情 / 文件 diff / 提交 / 评论 / 合并）
 * - D 流水线（构建历史 / 构建状态 / 阶段日志）
 *
 * 归一化约定（与 fetchCnbGroupRepos 既有范式一致）：
 * - API 原始响应均为 snake_case，本层逐字段转为 camelCase 并兜底空值，
 *   界面层无需判空；
 * - 特例：dto.LogInfo（构建历史条目）本身是 camelCase，直接承接不套模板；
 * - 所有请求经 useCnbAuth 的 cnbFetch/cnbFetchText（Rust 通道），禁止直连。
 */
import { i18n } from '../i18n'
import {
  canManageRole,
  cnbFetch,
  cnbFetchText,
  cnbFetchVoid,
  CnbApiError,
  type CnbApiErrorKind,
} from './useCnbAuth'

// ---------------------------------------------------------------------------
// 通用工具（本模块内私有 + 导出给组件复用）
// ---------------------------------------------------------------------------

/**
 * 归一化仓库路径：catch-all 路由参数（数组）join('/')，或直接接受字符串。
 * 单点实现编码规则，避免各页面散写 join 造成多级子组织路径解析不一致。
 */
export function normalizeRepoPath(segments: string[] | string): string {
  const list = Array.isArray(segments) ? segments : [segments]
  return list.filter(Boolean).join('/')
}

/**
 * 仓库路径 -> API URL 路径段：多级路径逐段 encodeURIComponent，
 * 保证特殊字符（如仓库名含 . 等）不破坏 URL 结构（'/' 保留为路径分隔符）。
 *
 * 导出说明：本轮新增的 useCnbGitRefs / useCnbRepoLabels / useCnbBuildAi 均需拼仓库
 * 路径，若各自复制一份逐段编码迟早口径漂移（踩坑#4：整体 encode 会把 '/' 压成
 * %2F 导致 404）。因此把本函数作为**仓库路径编码的单点出口**导出，新 composable
 * 一律 import 复用，禁止新建第四个编码函数。
 */
export function encodeRepoPath(repoPath: string): string {
  return repoPath.split('/').map(encodeURIComponent).join('/')
}

/** 文件路径 -> API URL 路径段：逐段编码（文件名可含空格/#/中文等） */
function encodeFilePath(filePath: string): string {
  return filePath.split('/').map(encodeURIComponent).join('/')
}

/**
 * CNB 站点 URL 统一出口：https://cnb.cool/{repoPath}{sub}。
 * 所有"在浏览器打开"的外跳兜底（仓库页 / Issue 页 / 构建页等）均经此拼接，
 * 保证 URL 规则单点维护。sub 例：'/-/issues/42'、'/-/builds'。
 */
export function repoSiteUrl(repoPath: string, sub = ''): string {
  return `https://cnb.cool/${repoPath}${sub}`
}

/**
 * 可见性枚举 -> 徽标配置（颜色 + 多语言标签），RepoHeader 与仓库列表共用。
 *
 * 枚举取值来自 CNB constant.Visibility（swagger 核实）：
 * - Private 私有：中性色（不显眼，是常态）；
 * - Public 公开：success 绿色（提示"对外可见"）；
 * - Secret 加密：warning 橙色（CNB 特有的加密存储仓库）；
 * - 异常未知值：按私有处理（宁可保守，不把不确定的仓库标成公开）。
 */
export function visibilityBadge(visibility: string): {
  color: 'neutral' | 'success' | 'warning'
  label: string
} {
  switch (visibility) {
    case 'Public':
      return { color: 'success', label: i18n.global.t('repo.visibility.public') }
    case 'Secret':
      return { color: 'warning', label: i18n.global.t('repo.visibility.secret') }
    default:
      return { color: 'neutral', label: i18n.global.t('repo.visibility.private') }
  }
}

// ---------------------------------------------------------------------------
// A. 仓库详情 + 代码浏览
// ---------------------------------------------------------------------------

/** 仓库详情（GET /{repo} → dto.Repos4User，归一化后） */
export interface RepoDetail {
  path: string
  name: string
  description: string
  webUrl: string
  visibility: 'Private' | 'Public' | 'Secret'
  starCount: number
  forkCount: number
  issueCount: number
  prCount: number
  language: string
  languageColor: string
  license: string
  updatedAt: string
  createdAt: string
  /**
   * 仓库状态（constant.RepoStatus）：0 正常 / 1 已归档 / 2 fork 中。
   * 归档仓库的写入口统一按 archived 派生值禁用（设计文档 §2.3）。
   */
  status: number
  /** 派生：status === 1（RepoStatusArchived）。写按钮统一读该值 */
  archived: boolean
  /**
   * 访问者权限级别（constant.AccessRole）：Guest/Reporter/Developer/Master/Owner。
   * dto.Repos4User 自带 access 字段，此前被丢弃 —— 用于写入口可见性预判。
   */
  accessLevel: string
  /** 派生：accessLevel ∈ {Master, Owner}。写入口按该值隐藏（403 只作兜底） */
  canManage: boolean
  /** 可见性变更是否被锁定（dto.Repos4User.visibility_change_lock，只读展示） */
  visibilityChangeLock: boolean
  /** 仓库主页（dto.Repos4User.site，PATCH 可修改项之一） */
  site: string
  /** 主题标签（dto.Repos4User.topics 为字符串，按分隔符拆分为数组） */
  topics: string[]
}

/** 默认分支信息（GET /{repo}/-/git/head → openapi.HeadRef） */
export interface GitRefInfo {
  name: string
  protected: boolean
}

/**
 * 文件视图模式（composable 内派生，页面不再判断阈值）：
 * - ok：正常渲染（行号 + 语法高亮）；
 * - no-highlight：> 256KB，加载内容但关闭高亮（纯等宽文本）；
 * - too-large：> 1MB，不加载内容，仅元信息 + 外跳；
 * - lfs：LFS 文件，需外跳下载；
 * - binary：解码后含 \0，二进制不支持预览。
 */
export type FileViewMode = 'ok' | 'no-highlight' | 'too-large' | 'lfs' | 'binary'

/** 大小/类型降级阈值（与设计文档一致：1MB 不加载 / 256KB 关高亮） */
const TOO_LARGE_BYTES = 1024 * 1024
const NO_HIGHLIGHT_BYTES = 256 * 1024

/** 仓库内容条目（GET /-/git/contents[/{file_path}] → api.Content / api.TreeEntry） */
export interface ContentEntry {
  name: string
  path: string
  type: 'tree' | 'blob' | 'lfs' | 'empty' | 'link' | 'submodule'
  size: number
  sha: string
  /** type=tree 时的子项列表（注意：TreeEntry 不含 size） */
  entries?: ContentEntry[]
  /** type=blob 且 encoding=base64 时的内容（仅直接请求文件时返回） */
  contentBase64?: string
  lfsDownloadUrl?: string
  lfsSize?: number
  /** 派生判定（无 size 信息时默认 ok，文件视图会重新请求拿到 size 后精确判定） */
  viewMode: FileViewMode
}

/**
 * 按大小/类型派生文件视图模式（"为什么"：阈值判定集中在数据层，
 * 页面只读 viewMode，避免各组件阈值散写不一致）。
 */
function deriveViewMode(raw: {
  type?: string
  size?: number
  lfs_download_url?: string
}): FileViewMode {
  if (raw.type === 'lfs' || raw.lfs_download_url) {
    return 'lfs'
  }
  const size = raw.size ?? 0
  if (size > TOO_LARGE_BYTES) {
    return 'too-large'
  }
  if (size > NO_HIGHLIGHT_BYTES) {
    return 'no-highlight'
  }
  return 'ok'
}

/** dto.Repos4User 原始结构（仅声明归一化用到的字段，snake_case） */
interface RawRepoDetail {
  path?: string
  name?: string
  description?: string
  web_url?: string
  visibility_level?: string
  star_count?: number
  fork_count?: number
  open_issue_count?: number
  open_pull_request_count?: number
  languages?: { language?: string, color?: string }
  license?: string
  created_at?: string
  updated_at?: string
  last_updated_at?: string
  /** 仓库状态（constant.RepoStatus：0 正常 / 1 已归档 / 2 fork 中） */
  status?: number
  /** 访问者权限级别（constant.AccessRole：Guest/Reporter/Developer/Master/Owner） */
  access?: string
  /** 可见性变更锁定标记（只读，仅展示） */
  visibility_change_lock?: boolean
  /** 仓库主页（PATCH /{repo} 的可修改项之一） */
  site?: string
  /** 主题标签 —— dto.Repos4User 中是**字符串**（PATCH 时才是数组） */
  topics?: string
}

/**
 * 获取仓库详情。
 * 端点：GET /{repo}（swagger dto.Repos4User；scope: repo-basic-info:r）。
 * 归一化：snake_case → camelCase；可见性缺失兜底 Private（保守策略）；
 * 更新时间优先 last_updated_at（代码更新时间），缺失回退 updated_at。
 */
export async function fetchRepoDetail(repoPath: string): Promise<RepoDetail> {
  const raw = await cnbFetch<RawRepoDetail>(`/${encodeRepoPath(repoPath)}`)
  // 权限级别：Master/Owner 才可管理（写入口可见性预判，403 只作兜底）
  const accessLevel = raw.access || ''
  // topics 在 dto.Repos4User 中是字符串（空格或逗号分隔），拆分为数组供编辑表单回显；
  // 拆分时兼容两种分隔符并过滤空段
  const topics = (raw.topics || '')
    .split(/[\s,]+/)
    .map(t => t.trim())
    .filter(Boolean)
  return {
    path: raw.path || repoPath,
    name: raw.name || repoPath.split('/').pop() || repoPath,
    description: raw.description || '',
    webUrl: raw.web_url || repoSiteUrl(repoPath),
    visibility: (raw.visibility_level === 'Public' || raw.visibility_level === 'Secret')
      ? raw.visibility_level
      : 'Private',
    starCount: raw.star_count ?? 0,
    forkCount: raw.fork_count ?? 0,
    issueCount: raw.open_issue_count ?? 0,
    prCount: raw.open_pull_request_count ?? 0,
    language: raw.languages?.language || '',
    languageColor: raw.languages?.color || '',
    license: raw.license || '',
    updatedAt: raw.last_updated_at || raw.updated_at || '',
    createdAt: raw.created_at || '',
    // 仓库状态：0 正常 / 1 已归档 / 2 fork 中；异常缺失按正常处理
    status: raw.status ?? 0,
    archived: raw.status === 1,
    accessLevel,
    // 角色判定单点实现（§8.2）：Master/Owner ⇒ 可管理，经 canManageRole 统一收敛
    canManage: canManageRole(accessLevel),
    visibilityChangeLock: !!raw.visibility_change_lock,
    site: raw.site || '',
    topics,
  }
}

/**
 * 获取仓库默认分支（GET /{repo}/-/git/head → openapi.HeadRef）。
 * 返回的 name 是仓库详情页 ?ref= 的缺省值。
 */
export async function fetchGitHead(repoPath: string): Promise<GitRefInfo> {
  const raw = await cnbFetch<{ name?: string, protected?: boolean }>(
    `/${encodeRepoPath(repoPath)}/-/git/head`,
  )
  return { name: raw.name || '', protected: !!raw.protected }
}

/**
 * api.Content 原始结构（snake_case；子项 entries 为 api.TreeEntry，不含 size/content）。
 */
interface RawContent {
  name?: string
  path?: string
  sha?: string
  size?: number
  type?: string
  content?: string
  encoding?: string
  entries?: { name?: string, path?: string, sha?: string, type?: string }[]
  lfs_download_url?: string
  lfs_size?: number
}

/** RawContent → ContentEntry 归一化（type 非法值兜底 blob，防御未知枚举） */
function normalizeContent(raw: RawContent): ContentEntry {
  const type = (['tree', 'blob', 'lfs', 'empty', 'link', 'submodule'] as const)
    .find(t => t === raw.type) || 'blob'
  return {
    name: raw.name || '',
    path: raw.path || raw.name || '',
    type,
    size: raw.size ?? 0,
    sha: raw.sha || '',
    contentBase64: type === 'blob' && raw.encoding === 'base64' ? (raw.content || '') : undefined,
    lfsDownloadUrl: raw.lfs_download_url || undefined,
    lfsSize: raw.lfs_size,
    viewMode: deriveViewMode(raw),
  }
}

/**
 * 浏览仓库目录或读取文件元信息/内容。
 * 端点：GET /{repo}/-/git/contents?ref= 与 GET /{repo}/-/git/contents/{file_path}?ref=
 * （scope: repo-code:r）。
 * 归一化：
 * - 目录条目按"目录优先 + 名称升序"排序（PRD P0-A3 验收点）；
 * - entries 非数组降级为空数组（空目录/Secret 仓库兜底，不崩）；
 * - 文件内容仅在 type=blob 且 encoding=base64 时保留 contentBase64。
 *
 * @param opts.ref 分支名/标签名/SHA，缺省由服务端取默认分支
 * @param opts.filePath 文件或目录完整路径，缺省为根目录
 */
export async function fetchRepoContents(
  repoPath: string,
  opts: { ref?: string, filePath?: string } = {},
): Promise<ContentEntry> {
  const refQuery = opts.ref ? `?ref=${encodeURIComponent(opts.ref)}` : ''
  const filePathPart = opts.filePath ? `/${encodeFilePath(opts.filePath)}` : ''
  const raw = await cnbFetch<RawContent>(
    `/${encodeRepoPath(repoPath)}/-/git/contents${filePathPart}${refQuery}`,
  )
  const entry = normalizeContent(raw)
  if (Array.isArray(raw.entries)) {
    const children = raw.entries.map(item => normalizeContent({ ...item, encoding: undefined }))
    // 目录优先 + 名称升序：与 CNB 网页端浏览体验一致（PRD P0-A3）
    children.sort((a, b) => {
      const dirDiff = Number(b.type === 'tree') - Number(a.type === 'tree')
      return dirDiff !== 0 ? dirDiff : a.name.localeCompare(b.name)
    })
    entry.entries = children
  }
  else {
    // 非数组降级空数组：空目录 / Secret 仓库禁读时 entries 可能缺失
    entry.entries = []
  }
  return entry
}

/**
 * 超大文本文件兜底：经 cnbFetchText 读 raw 原文（Accept: text/plain）。
 * 端点：GET /{repo}/-/git/raw/{ref_with_path}（scope: repo-code:r）。
 *
 * 已知限制（设计文档 R3）：ref_with_path 按"分支名/文件路径"切分，分支名含
 * '/'（如 feature/x）时切分歧义可能 404 —— raw 仅用于 >1MB 文本兜底，
 * 失败时页面提供"在浏览器打开"出口，不阻断。
 *
 * @returns 文本内容；非 200 或读不到文本时抛 CnbApiError（kind=network/notFound）
 */
export async function fetchRawFileText(
  repoPath: string,
  ref: string,
  filePath: string,
): Promise<string> {
  const refWith = `${ref}/${filePath}`
  const { status, ok, text } = await cnbFetchText(
    `/${encodeRepoPath(repoPath)}/-/git/raw/${encodeURIComponent(refWith)}?max_in_byte=${4 * 1024 * 1024}`,
    { accept: 'text/plain' },
  )
  if (!ok) {
    throw new CnbApiError(
      `raw file request failed: HTTP ${status}`,
      status,
      status === 404 ? 'notFound' : 'network',
    )
  }
  return text
}

/** 分支条目（GET /{repo}/-/git/branches → api.Branch） */
export interface BranchItem {
  name: string
  sha: string
  protected: boolean
  locked: boolean
}

/**
 * 获取分支列表（scope: repo-code:r）。
 * 归一化：commit.sha 兜底空串；数组响应异常时降级空列表。
 */
export async function fetchRepoBranches(repoPath: string, page = 1): Promise<BranchItem[]> {
  const raw = await cnbFetch<{
    name?: string
    protected?: boolean
    locked?: boolean
    commit?: { sha?: string }
  }[]>(`/${encodeRepoPath(repoPath)}/-/git/branches?page=${page}&page_size=100`)
  if (!Array.isArray(raw)) {
    return []
  }
  return raw.map(b => ({
    name: b.name || '',
    sha: b.commit?.sha || '',
    protected: !!b.protected,
    locked: !!b.locked,
  })).filter(b => b.name)
}

/** 标签条目（GET /{repo}/-/git/tags → api.Tag） */
export interface TagItem {
  name: string
  sha: string
}

/**
 * 获取标签列表（scope: repo-code:r）。api.Tag 的 target 为目标对象哈希。
 */
export async function fetchRepoTags(repoPath: string, page = 1): Promise<TagItem[]> {
  const raw = await cnbFetch<{ name?: string, target?: string }[]>(
    `/${encodeRepoPath(repoPath)}/-/git/tags?page=${page}&page_size=100`,
  )
  if (!Array.isArray(raw)) {
    return []
  }
  return raw.map(t => ({ name: t.name || '', sha: t.target || '' })).filter(t => t.name)
}

/** 提交条目（GET /-/git/commits → api.Commit，归一化后） */
export interface CommitItem {
  sha: string
  /** 首行标题（message 第一行） */
  title: string
  /** 完整提交信息 */
  message: string
  authorName: string
  authorTime: string
  parents: { sha: string }[]
}

/** api.Commit 原始结构（嵌套 commit.author 签名对象） */
interface RawCommit {
  sha?: string
  parents?: { sha?: string }[]
  author?: { nickname?: string, username?: string }
  commit?: {
    message?: string
    author?: { name?: string, date?: string }
    committer?: { name?: string, date?: string }
  }
}

/** RawCommit → CommitItem：title 取 message 首行；作者名优先签名 name，回退用户昵称 */
function normalizeCommit(raw: RawCommit): CommitItem {
  const message = raw.commit?.message || ''
  const firstLine = message.split('\n')[0] || ''
  return {
    sha: raw.sha || '',
    title: firstLine,
    message,
    authorName: raw.commit?.author?.name || raw.author?.nickname || raw.author?.username || '',
    authorTime: raw.commit?.author?.date || '',
    parents: (raw.parents || []).map(p => ({ sha: p.sha || '' })).filter(p => p.sha),
  }
}

/**
 * 提交历史列表（GET /{repo}/-/git/commits?sha=&page=&page_size=，scope: repo-code:r）。
 * sha 参数即当前 ref（分支名或 SHA）。
 */
export async function fetchRepoCommits(
  repoPath: string,
  opts: { ref?: string, page?: number, pageSize?: number } = {},
): Promise<CommitItem[]> {
  const query = new URLSearchParams({
    page: String(opts.page ?? 1),
    page_size: String(opts.pageSize ?? 30),
  })
  if (opts.ref) {
    query.set('sha', opts.ref)
  }
  const raw = await cnbFetch<RawCommit[]>(
    `/${encodeRepoPath(repoPath)}/-/git/commits?${query}`,
  )
  if (!Array.isArray(raw)) {
    return []
  }
  return raw.map(normalizeCommit)
}

/**
 * 单个提交详情（GET /{repo}/-/git/commits/{ref}，ref 可为分支名或 SHA）。
 * 提交详情页用它展示完整 message / 作者 / 父提交。
 */
export async function fetchRepoCommit(repoPath: string, refOrSha: string): Promise<CommitItem> {
  const raw = await cnbFetch<RawCommit>(
    `/${encodeRepoPath(repoPath)}/-/git/commits/${encodeURIComponent(refOrSha)}`,
  )
  return normalizeCommit(raw)
}

// ---------------------------------------------------------------------------
// A+. 提交 CI 状态（T10）与提交比较（T11）
// ---------------------------------------------------------------------------

/**
 * CI 状态元信息映射（T10 验收 2/4）—— **独立映射表**，与流水线构建状态
 * （buildStatusBadge）分开维护：两套枚举来源不同（git commit-status 的
 * state vs 构建 status），混用会让未知值误上错误色。
 *
 * 映射规则（设计文档 §7.2 T10）：
 * - success → 绿 / failed → 红 / running → 蓝 / pending → 灰 /
 *   canceled、skipped → 中性；
 * - **未知值一律中性色**（绝不显示错误色）—— 服务端新增枚举时前端不误报。
 */
export function commitStatusMeta(state: string): {
  /** Nuxt UI 徽标颜色 */
  color: 'success' | 'error' | 'info' | 'neutral'
  /** lucide 图标名 */
  icon: string
  /** i18n 键（repo.commitStatus.<key>） */
  i18nKey: string
} {
  switch ((state || '').toLowerCase()) {
    case 'success':
      return { color: 'success', icon: 'i-lucide-check-circle-2', i18nKey: 'repo.commitStatus.success' }
    case 'failed':
      return { color: 'error', icon: 'i-lucide-x-circle', i18nKey: 'repo.commitStatus.failed' }
    case 'running':
      return { color: 'info', icon: 'i-lucide-loader-circle', i18nKey: 'repo.commitStatus.running' }
    case 'pending':
      return { color: 'neutral', icon: 'i-lucide-clock', i18nKey: 'repo.commitStatus.pending' }
    case 'canceled':
      return { color: 'neutral', icon: 'i-lucide-circle-off', i18nKey: 'repo.commitStatus.canceled' }
    case 'skipped':
      return { color: 'neutral', icon: 'i-lucide-skip-forward', i18nKey: 'repo.commitStatus.skipped' }
    // 未知值（含空串）：中性色兜底，不误报为失败
    default:
      return { color: 'neutral', icon: 'i-lucide-help-circle', i18nKey: 'repo.commitStatus.unknown' }
  }
}

/** git_internal_app_vcs_service_bff_api.CommitStatus 原始结构（单个 check） */
interface RawCommitStatusCheck {
  context?: string
  state?: string
  description?: string
  target_url?: string
  created_at?: string
  updated_at?: string
}

/** api.CommitStatuses 原始结构 */
interface RawCommitStatuses {
  sha?: string
  state?: string
  statuses?: RawCommitStatusCheck[]
}

/** 提交 CI 状态（归一化后） */
export interface CommitStatusResult {
  sha: string
  /** 整体状态（服务端聚合；空串表示该提交无 CI 记录，UI 隐藏徽标） */
  state: string
  checks: {
    context: string
    state: string
    description: string
    /** 明细外跳地址（PR 链接 / 构建详情等，原样透传） */
    targetUrl: string
  }[]
}

/**
 * api.CommitStatuses → CommitStatusResult 归一化（单点实现）。
 *
 * 为什么抽出：单提交 CI（GET /git/commit-statuses/{commitish}）与 PR CI
 * （GET /pulls/{n}/commit-statuses）响应结构完全一致（设计 §2.5），两处共用
 * 同一归一化 + 同一 commitStatusMeta 六态映射，避免 UI 出现两套口径。
 */
function normalizeCommitStatuses(raw: RawCommitStatuses): CommitStatusResult {
  return {
    sha: raw?.sha || '',
    state: raw?.state || '',
    checks: (Array.isArray(raw?.statuses) ? raw.statuses : []).map(check => ({
      context: check?.context || '',
      state: check?.state || '',
      description: check?.description || '',
      targetUrl: check?.target_url || '',
    })),
  }
}

/**
 * 提交 CI 状态（GET /{repo}/-/git/commit-statuses/{commitish}，scope repo-code:r）。
 *
 * 懒加载约定（T10 验收 1）：列表渲染时**不**为每行立即调用 —— 由
 * RepoCommits 的 IntersectionObserver 在行进入视口后才请求，
 * 结果以 Map<sha, CommitStatusResult> 缓存，翻页/切 ref 不重复拉取。
 * @param commitish 分支名 / 提交 SHA / 标签名
 */
export async function fetchCommitStatuses(
  repoPath: string,
  commitish: string,
): Promise<CommitStatusResult> {
  const raw = await cnbFetch<RawCommitStatuses>(
    `/${encodeRepoPath(repoPath)}/-/git/commit-statuses/${encodeURIComponent(commitish)}`,
  )
  return normalizeCommitStatuses(raw)
}

/**
 * 提交比较（GET /{repo}/-/git/compare/{base...head}，T11）。
 *
 * **三点编码口径（验收 3）**：swagger 把 base_head 声明为**单个 path 段**，
 * 格式为 `base...head` —— 必须把整段 `base...head` 一起 encodeURIComponent
 * （含分支名内部的 '/' 与三个点一起编码），不能只编码 base/head 各自内部
 * 再拼 `...`，否则服务端按多段路径解析会 404。
 *
 * files 复用 PullFile 结构（api.CommitDiffFilePatch 与 PR files 字段一致），
 * diff 渲染直接复用 PullDiffView。
 */
export interface CompareResult {
  /** base...head 之间的提交数（ahead/behind 汇总口径，服务端给定） */
  totalCommits: number
  /** 区间提交列表（与提交列表同构） */
  commits: CommitItem[]
  /** 变更文件（复用 PullFile，patch 为空表示二进制/无文本差异） */
  files: PullFile[]
}

export async function fetchCompare(
  repoPath: string,
  base: string,
  head: string,
): Promise<CompareResult> {
  const raw = await cnbFetch<{
    total_commits?: number
    commits?: RawCommit[]
    files?: {
      name?: string
      path?: string
      status?: string
      additions?: number
      deletions?: number
      patch?: string
    }[]
  }>(
    `/${encodeRepoPath(repoPath)}/-/git/compare/${encodeURIComponent(`${base}...${head}`)}`,
  )
  return {
    totalCommits: raw.total_commits ?? 0,
    commits: (Array.isArray(raw.commits) ? raw.commits : []).map(normalizeCommit),
    files: (Array.isArray(raw.files) ? raw.files : []).map(f => ({
      // 优先 path（新路径），回退 name；与 PR files 归一化保持同构
      filename: f.path || f.name || '',
      status: (['add', 'modify', 'delete', 'rename', 'copy'] as const)
        .find(s => s === f.status) || 'modify',
      additions: f.additions ?? 0,
      deletions: f.deletions ?? 0,
      patch: f.patch || '',
    })),
  }
}

// ---------------------------------------------------------------------------
// B. Issue
// ---------------------------------------------------------------------------

/** Issue 标签（api.Label / api.LabelInfo 共用子集） */
export interface RepoLabel {
  name: string
  color: string
}

/** 处理人/用户条目（api.UserInfo 子集） */
export interface RepoUser {
  username: string
  nickname: string
  avatar: string
}

/** Issue 条目（GET /-/issues → api.Issue；GET /-/issues/{number} → api.IssueDetail） */
export interface RepoIssue {
  number: string
  title: string
  state: 'open' | 'closed'
  /** 正文，仅详情接口返回 */
  body?: string
  authorName: string
  authorUsername: string
  labels: RepoLabel[]
  assignees: RepoUser[]
  priority: string
  commentCount: number
  createdAt: string
  updatedAt: string
  closedAt?: string
}

/** api.Issue 原始结构（snake_case） */
interface RawIssue {
  number?: string
  title?: string
  state?: string
  body?: string
  author?: { nickname?: string, username?: string, avatar?: string }
  labels?: { name?: string, color?: string }[]
  assignees?: { nickname?: string, username?: string, avatar?: string }[]
  priority?: string
  comment_count?: number
  created_at?: string
  updated_at?: string
  closed_at?: string
}

/** RawIssue → RepoIssue：state 非法值兜底 open；labels 过滤无名项 */
function normalizeIssue(raw: RawIssue): RepoIssue {
  return {
    number: raw.number || '',
    title: raw.title || '',
    state: raw.state === 'closed' ? 'closed' : 'open',
    body: raw.body,
    authorName: raw.author?.nickname || raw.author?.username || '',
    authorUsername: raw.author?.username || '',
    labels: (raw.labels || []).map(l => ({ name: l.name || '', color: l.color || '' }))
      .filter(l => l.name),
    assignees: (raw.assignees || []).map(a => ({
      username: a.username || '',
      nickname: a.nickname || a.username || '',
      avatar: a.avatar || '',
    })).filter(a => a.username),
    priority: raw.priority || '',
    commentCount: raw.comment_count ?? 0,
    createdAt: raw.created_at || '',
    updatedAt: raw.updated_at || '',
    closedAt: raw.closed_at || undefined,
  }
}

/**
 * 仓库 Issue 列表（GET /{repo}/-/issues，scope: repo-issue:r）。
 * state 仅支持 open/closed 两值（接口限制，界面用两段切换不提供"全部"）。
 */
export async function fetchRepoIssues(
  repoPath: string,
  opts: { state: 'open' | 'closed', keyword?: string, page?: number, pageSize?: number },
): Promise<RepoIssue[]> {
  const query = new URLSearchParams({
    state: opts.state,
    page: String(opts.page ?? 1),
    page_size: String(opts.pageSize ?? 30),
  })
  if (opts.keyword) {
    query.set('keyword', opts.keyword)
  }
  const raw = await cnbFetch<RawIssue[]>(
    `/${encodeRepoPath(repoPath)}/-/issues?${query}`,
  )
  if (!Array.isArray(raw)) {
    return []
  }
  return raw.map(normalizeIssue)
}

/**
 * Issue 详情（GET /{repo}/-/issues/{number}，scope: repo-issue:r）。
 * 与列表接口的差异：返回 body 正文。
 */
export async function fetchRepoIssue(repoPath: string, number: string): Promise<RepoIssue> {
  const raw = await cnbFetch<RawIssue>(
    `/${encodeRepoPath(repoPath)}/-/issues/${encodeURIComponent(number)}`,
  )
  return normalizeIssue(raw)
}

/**
 * 新建 Issue（POST /{repo}/-/issues，body: api.PostIssueForm，scope: repo-issue:rw）。
 * 返回体未完全定型（swagger 未标注 200 schema 结构），尽力取 number；
 * 取不到时调用方（NewIssueModal）回退到 Issue 列表并提示。
 */
export async function createRepoIssue(
  repoPath: string,
  form: { title: string, body?: string, labels?: string[], assignees?: string[], priority?: string },
): Promise<{ number?: string }> {
  const raw = await cnbFetch<{ number?: string }>(
    `/${encodeRepoPath(repoPath)}/-/issues`,
    {
      method: 'POST',
      body: JSON.stringify({
        title: form.title,
        ...(form.body ? { body: form.body } : {}),
        ...(form.labels?.length ? { labels: form.labels } : {}),
        ...(form.assignees?.length ? { assignees: form.assignees } : {}),
        ...(form.priority ? { priority: form.priority } : {}),
      }),
    },
  )
  return { number: raw && typeof raw.number === 'string' ? raw.number : undefined }
}

/**
 * 关闭 / 重开 Issue（PATCH /{repo}/-/issues/{number}，body { state }，
 * scope: repo-issue:rw）。失败时抛 CnbApiError，由调用方回滚 UI 状态。
 */
export async function updateIssueState(
  repoPath: string,
  number: string,
  state: 'open' | 'closed',
): Promise<void> {
  await cnbFetch(`/${encodeRepoPath(repoPath)}/-/issues/${encodeURIComponent(number)}`, {
    method: 'PATCH',
    body: JSON.stringify({ state }),
  })
}

// ---------------------------------------------------------------------------
// B+. Issue 处理人 / 标签关联（REQ-04，10 端点）
// ---------------------------------------------------------------------------
//
// ⚠️ 本段是踩坑#3 / 风险 N2 的重灾区：相邻端点通道不同，逐条对照设计 §8.2：
// - assignees 的 POST/PATCH/DELETE 都返回 api.IssueDetail（**有 body**）→ cnbFetch；
// - GET assignees/{a} 是探测端点（204 可分配 / 404 不可）→ cnbFetchVoid + 捕获 404；
// - labels 的 POST/PUT 返回 api.Label（有 body）→ cnbFetch；
// - **DELETE /labels（集合，带 body）返回 204 空 body → cnbFetchVoid**；
// - DELETE /labels/{name}（单个）返回 200 api.Label（有 body）→ cnbFetch。
// 每个函数注释均标注通道选择依据；写后由 RepoIssueDetail 调 load() 重拉详情（§8.4）。

/** api.UserInfo → RepoUser 归一化（复用既有类型，禁止重复定义） */
function normalizeRepoUser(raw: { username?: string, nickname?: string, avatar?: string }): RepoUser {
  return {
    username: raw?.username || '',
    nickname: raw?.nickname || raw?.username || '',
    avatar: raw?.avatar || '',
  }
}

/** 处理人/标签写端点响应可能是 IssueDetail / Label / Label[]，尽力抽出第一个标签 */
function normalizeLabelResult(raw: unknown): RepoLabel {
  if (Array.isArray(raw)) {
    const first = raw.find(item => !!item && typeof item === 'object' && !!(item as { name?: string }).name)
    return { name: (first as { name?: string })?.name || '', color: (first as { color?: string })?.color || '' }
  }
  if (raw && typeof raw === 'object') {
    const obj = raw as { name?: string, color?: string }
    return { name: obj.name || '', color: obj.color || '' }
  }
  return { name: '', color: '' }
}

/** 判断异常是否为 404（探测函数把 404 归一为 false，其余错误继续抛出） */
function isNotFound(err: unknown): boolean {
  if (err instanceof CnbApiError) {
    return err.kind === 'notFound' || err.status === 404
  }
  const value = err as { kind?: string, status?: number } | null
  return !!value && (value.kind === 'notFound' || value.status === 404)
}

/**
 * Issue 处理人列表（GET /{repo}/-/issues/{number}/assignees，scope: repo-issue:r）。
 * **通道选择依据**：200 api.UserInfo[]（有 body）→ cnbFetch。
 */
export async function listIssueAssignees(repoPath: string, number: string): Promise<RepoUser[]> {
  const raw = await cnbFetch<{ username?: string, nickname?: string, avatar?: string }[]>(
    `/${encodeRepoPath(repoPath)}/-/issues/${encodeURIComponent(number)}/assignees`,
  )
  if (!Array.isArray(raw)) {
    return []
  }
  return raw.map(normalizeRepoUser).filter(user => !!user.username)
}

/**
 * 用户名是否可被分配给该 Issue（GET /issues/{n}/assignees/{assignee}）。
 *
 * **通道选择依据**：该端点只以 HTTP 状态表达结果（204 可分配 / 404 不可），
 * 无有效 body —— 走 cnbFetchVoid 并用 404 判定 false；500/网络错误继续抛出，
 * 不能把"服务异常"误判成"不可分配"而静默过滤候选。
 */
export async function canAssignIssue(
  repoPath: string,
  number: string,
  username: string,
): Promise<boolean> {
  try {
    await cnbFetchVoid(
      `/${encodeRepoPath(repoPath)}/-/issues/${encodeURIComponent(number)}/assignees/${encodeURIComponent(username)}`,
      { method: 'GET' },
    )
    return true
  }
  catch (err) {
    if (isNotFound(err)) {
      return false
    }
    throw err
  }
}

/**
 * 新增处理人（POST /issues/{n}/assignees，body {assignees: string[]}）。
 * **通道选择依据**：201 api.IssueDetail（有 body）→ cnbFetch；UI 不消费返回体，
 * 写后统一重拉详情（本函数返回 void 与 §5.2 签名一致）。
 */
export async function setIssueAssignees(
  repoPath: string,
  number: string,
  usernames: string[],
): Promise<void> {
  await cnbFetch(
    `/${encodeRepoPath(repoPath)}/-/issues/${encodeURIComponent(number)}/assignees`,
    { method: 'POST', body: JSON.stringify({ assignees: usernames }) },
  )
}

/**
 * 增量变更处理人（PATCH /issues/{n}/assignees）。
 * **通道选择依据**：200 api.IssueDetail（有 body）→ cnbFetch。
 */
export async function updateIssueAssignees(
  repoPath: string,
  number: string,
  usernames: string[],
): Promise<void> {
  await cnbFetch(
    `/${encodeRepoPath(repoPath)}/-/issues/${encodeURIComponent(number)}/assignees`,
    { method: 'PATCH', body: JSON.stringify({ assignees: usernames }) },
  )
}

/**
 * 移除指定处理人（DELETE /issues/{n}/assignees，body {assignees: string[]}）。
 * **通道选择依据**：200 api.IssueDetail（有 body）→ cnbFetch（不是 Void）。
 */
export async function removeIssueAssignees(
  repoPath: string,
  number: string,
  usernames: string[],
): Promise<void> {
  await cnbFetch(
    `/${encodeRepoPath(repoPath)}/-/issues/${encodeURIComponent(number)}/assignees`,
    { method: 'DELETE', body: JSON.stringify({ assignees: usernames }) },
  )
}

/**
 * Issue 标签列表（GET /issues/{n}/labels）。
 * **通道选择依据**：200 api.Label[]（有 body）→ cnbFetch。
 */
export async function listIssueLabels(repoPath: string, number: string): Promise<RepoLabel[]> {
  const raw = await cnbFetch<{ name?: string, color?: string }[]>(
    `/${encodeRepoPath(repoPath)}/-/issues/${encodeURIComponent(number)}/labels`,
  )
  if (!Array.isArray(raw)) {
    return []
  }
  return raw.map(l => ({ name: l?.name || '', color: l?.color || '' })).filter(l => !!l.name)
}

/**
 * 新增 Issue 标签（POST /issues/{n}/labels，body {labels: string[]}）。
 * **通道选择依据**：200 api.Label（有 body）→ cnbFetch。
 */
export async function addIssueLabels(
  repoPath: string,
  number: string,
  labels: string[],
): Promise<RepoLabel> {
  const raw = await cnbFetch<unknown>(
    `/${encodeRepoPath(repoPath)}/-/issues/${encodeURIComponent(number)}/labels`,
    { method: 'POST', body: JSON.stringify({ labels }) },
  )
  return normalizeLabelResult(raw)
}

/**
 * 全量替换 Issue 标签（PUT /issues/{n}/labels，body {labels: string[]}）。
 * **通道选择依据**：200 api.Label（有 body）→ cnbFetch。
 */
export async function setIssueLabels(
  repoPath: string,
  number: string,
  labels: string[],
): Promise<RepoLabel> {
  const raw = await cnbFetch<unknown>(
    `/${encodeRepoPath(repoPath)}/-/issues/${encodeURIComponent(number)}/labels`,
    { method: 'PUT', body: JSON.stringify({ labels }) },
  )
  return normalizeLabelResult(raw)
}

/**
 * 批量移除 Issue 标签（DELETE /issues/{n}/labels，body {labels: string[]}）。
 *
 * **通道选择依据（相邻端点不同，最易踩坑）**：集合级 DELETE 返回 **204 空 body**，
 * 必须走 cnbFetchVoid；但 cnbFetchVoid 仍会正常发送 body（指定要移除的标签）。
 */
export async function removeIssueLabels(
  repoPath: string,
  number: string,
  labels: string[],
): Promise<void> {
  await cnbFetchVoid(
    `/${encodeRepoPath(repoPath)}/-/issues/${encodeURIComponent(number)}/labels`,
    { method: 'DELETE', body: JSON.stringify({ labels }) },
  )
}

/**
 * 移除单个 Issue 标签（DELETE /issues/{n}/labels/{name}）。
 * **通道选择依据**：单个 DELETE 返回 **200 api.Label（有 body）** → cnbFetch，
 * 与上面的集合级 DELETE（Void）恰好相反。name 含中文/空格走 encodeURIComponent。
 */
export async function removeIssueLabel(
  repoPath: string,
  number: string,
  name: string,
): Promise<RepoLabel> {
  const raw = await cnbFetch<unknown>(
    `/${encodeRepoPath(repoPath)}/-/issues/${encodeURIComponent(number)}/labels/${encodeURIComponent(name)}`,
    { method: 'DELETE' },
  )
  return normalizeLabelResult(raw)
}

/** 评论条目（api.IssueComment / api.PullRequestComment 共用子集，归一化后） */
export interface RepoComment {
  id: string
  body: string
  authorName: string
  authorUsername: string
  createdAt: string
  updatedAt: string
}

/** 评论原始结构（Issue 与 PR 评论结构一致，共用归一化） */
interface RawComment {
  id?: string
  body?: string
  author?: { nickname?: string, username?: string }
  created_at?: string
  updated_at?: string
}

function normalizeComment(raw: RawComment): RepoComment {
  return {
    id: raw.id || '',
    body: raw.body || '',
    authorName: raw.author?.nickname || raw.author?.username || '',
    authorUsername: raw.author?.username || '',
    createdAt: raw.created_at || '',
    updatedAt: raw.updated_at || '',
  }
}

/**
 * Issue 评论列表（GET /{repo}/-/issues/{number}/comments，scope: repo-issue:r 或 repo-notes:r）。
 */
export async function fetchIssueComments(
  repoPath: string,
  number: string,
): Promise<RepoComment[]> {
  const raw = await cnbFetch<RawComment[]>(
    `/${encodeRepoPath(repoPath)}/-/issues/${encodeURIComponent(number)}/comments`,
  )
  if (!Array.isArray(raw)) {
    return []
  }
  return raw.map(normalizeComment)
}

/**
 * 发表 Issue 评论（POST /{repo}/-/issues/{number}/comments，body { body }，
 * scope: repo-notes:rw）。失败抛 CnbApiError，调用方保留草稿。
 */
export async function createIssueComment(
  repoPath: string,
  number: string,
  body: string,
): Promise<void> {
  await cnbFetch(
    `/${encodeRepoPath(repoPath)}/-/issues/${encodeURIComponent(number)}/comments`,
    { method: 'POST', body: JSON.stringify({ body }) },
  )
}

// ---------------------------------------------------------------------------
// Issue 评论编辑 + 自定义属性（批次 2 · REQ-09，6 端点）
// ---------------------------------------------------------------------------

/**
 * 单条 Issue 评论（GET /{repo}/-/issues/{n}/comments/{commentId}，
 * scope `repo-notes:r` → api.IssueComment）。
 *
 * 为什么编辑前要先 GET：列表里的评论可能是几分钟前的快照，别人可能已改过；
 * 用最新正文预填编辑框，避免用旧内容覆盖他人修改。
 */
export async function fetchIssueComment(
  repoPath: string,
  number: string,
  commentId: string,
): Promise<RepoComment> {
  const raw = await cnbFetch<RawComment>(
    `/${encodeRepoPath(repoPath)}/-/issues/${encodeURIComponent(number)}/comments/${encodeURIComponent(commentId)}`,
  )
  return normalizeComment(raw || {})
}

/**
 * 编辑 Issue 评论（PATCH …/comments/{commentId}，scope `repo-notes:rw`）
 * → **200 api.IssueComment（有 body）**，走 `cnbFetch`。
 *
 * 与"创建评论"不同：创建返回空 body，编辑返回完整实体 —— 通道不能互换
 * （设计 §8.2 逐端点表）。
 */
export async function updateIssueComment(
  repoPath: string,
  number: string,
  commentId: string,
  body: string,
): Promise<RepoComment> {
  const raw = await cnbFetch<RawComment>(
    `/${encodeRepoPath(repoPath)}/-/issues/${encodeURIComponent(number)}/comments/${encodeURIComponent(commentId)}`,
    { method: 'PATCH', body: JSON.stringify({ body }) },
  )
  return normalizeComment(raw || {})
}

/**
 * Issue 自定义属性的三个值类型（api.IssueProperty.type）。
 * 表单按 type 选控件：string→文本框、date→日期选择、number→数字框；
 * 提交时统一转字符串（api.PropertyForm.value 是 string）。
 */
export type IssuePropertyType = 'string' | 'date' | 'number'

/** 某条 Issue 上已填写的自定义属性（GET …/issues/{n}/property） */
export interface IssueProperty {
  key: string
  name: string
  type: IssuePropertyType
  /** 当前值（字符串；空串表示未填写） */
  value: string
}

/** 仓库级属性字典条目（GET /{repo}/-/property[/invisible] → api.RepoProperty） */
export interface RepoPropertyDef {
  key: string
  name: string
  type: IssuePropertyType
  /** 是否对所有人可见（false = 仅自己可见） */
  visible: boolean
}

/**
 * 自定义属性更新的结果（api.IssuePropertyUpdateResult）。
 *
 * ⚠️ HTTP 200 不代表全部成功：服务端会逐 key 校验，部分 key 可能失败。
 * UI 必须按 `failedCount` 展示部分失败并列出失败 key，不能只看状态码
 * 就报"保存成功"（N2 同类的"假成功"陷阱）。
 */
export interface PropertyUpdateResult {
  successCount: number
  failedCount: number
  failedKeys: string[]
}

/** 属性类型归一化（未知值按 string 处理，保证表单有控件可用） */
function normalizePropertyType(value: unknown): IssuePropertyType {
  return value === 'date' || value === 'number' ? value : 'string'
}

/** 读取某条 Issue 已填写的自定义属性（scope `repo-issue:r`） */
export async function listIssueProperties(
  repoPath: string,
  number: string,
): Promise<IssueProperty[]> {
  const raw = await cnbFetch<unknown>(
    `/${encodeRepoPath(repoPath)}/-/issues/${encodeURIComponent(number)}/property`,
  )
  if (!Array.isArray(raw)) {
    return []
  }
  return raw
    .map((item) => {
      const source = (item && typeof item === 'object' ? item : {}) as {
        key?: unknown
        name?: unknown
        type?: unknown
        value?: unknown
      }
      return {
        key: typeof source.key === 'string' ? source.key : '',
        name: typeof source.name === 'string' ? source.name : '',
        type: normalizePropertyType(source.type),
        value: typeof source.value === 'string' ? source.value : '',
      }
    })
    .filter(item => item.key !== '')
}

/**
 * 批量更新 Issue 自定义属性（PATCH …/issues/{n}/property，scope `repo-issue:rw`）
 * → 200 `api.IssuePropertyUpdateResult`（有 body），走 `cnbFetch`。
 *
 * 请求体：`{ properties: [{ key, value }] }`；值一律字符串。
 * 返回的失败明细交给 UI 展示（见 PropertyUpdateResult 注释）。
 */
export async function updateIssueProperties(
  repoPath: string,
  number: string,
  properties: { key: string, value: string }[],
): Promise<PropertyUpdateResult> {
  const raw = await cnbFetch<{
    success_count?: unknown
    failed_count?: unknown
    failed_keys?: unknown
  }>(
    `/${encodeRepoPath(repoPath)}/-/issues/${encodeURIComponent(number)}/property`,
    { method: 'PATCH', body: JSON.stringify({ properties }) },
  )
  const failedKeys = Array.isArray(raw?.failed_keys)
    ? raw.failed_keys.filter((key): key is string => typeof key === 'string')
    : []
  return {
    successCount: Number(raw?.success_count) || 0,
    failedCount: Number(raw?.failed_count) || failedKeys.length,
    failedKeys,
  }
}

/**
 * 仓库可见自定义属性字典（GET /{repo}/-/property，scope `repo-issue:r`）。
 * 用于渲染"可添加哪些属性"的候选项。
 */
export async function listRepoProperties(repoPath: string): Promise<RepoPropertyDef[]> {
  return fetchRepoPropertyList(repoPath, false)
}

/**
 * 仓库隐藏自定义属性字典（GET /{repo}/-/property/invisible，scope `repo-issue:r`）。
 *
 * 隐藏属性的含义是"仅创建者/有权限者可见"，仍在字典里返回，UI 需标注
 * "仅你可见"避免误判为公共字段。
 */
export async function listRepoInvisibleProperties(repoPath: string): Promise<RepoPropertyDef[]> {
  return fetchRepoPropertyList(repoPath, true)
}

/** 属性字典的共用实现（visible / invisible 仅路径后缀不同） */
async function fetchRepoPropertyList(repoPath: string, invisible: boolean): Promise<RepoPropertyDef[]> {
  const suffix = invisible ? '/property/invisible' : '/property'
  const raw = await cnbFetch<unknown>(`/${encodeRepoPath(repoPath)}/-${suffix}`)
  if (!Array.isArray(raw)) {
    return []
  }
  return raw
    .map((item) => {
      const source = (item && typeof item === 'object' ? item : {}) as {
        key?: unknown
        name?: unknown
        type?: unknown
        visible?: unknown
      }
      return {
        key: typeof source.key === 'string' ? source.key : '',
        name: typeof source.name === 'string' ? source.name : '',
        type: normalizePropertyType(source.type),
        // 隐藏端点返回的条目显式标 false；visible 端点按服务端值兜底为 true
        visible: invisible ? false : source.visible !== false,
      }
    })
    .filter(item => item.key !== '')
}

/** Issue 动态条目（GET /-/issues/{number}/activities → api.IssueActivity） */
export interface IssueActivity {
  id: string
  type: string
  actorName: string
  createdAt: string
  /** 未定型 payload，P0 尽力解析（IssueTimeline 内部处理，异常只显示类型名） */
  payload: unknown
}

/**
 * Issue 动态时间线（scope: repo-issue:r）。
 * payload 为 free-form，本层原样透传不做结构假设（PRD R10）。
 */
export async function fetchIssueActivities(
  repoPath: string,
  number: string,
  page = 1,
): Promise<IssueActivity[]> {
  const raw = await cnbFetch<{
    id?: string
    type?: string
    actor?: { nickname?: string, username?: string }
    created_at?: string
    payload?: unknown
  }[]>(
    `/${encodeRepoPath(repoPath)}/-/issues/${encodeURIComponent(number)}/activities?page=${page}&page_size=50`,
  )
  if (!Array.isArray(raw)) {
    return []
  }
  return raw.map(a => ({
    id: a.id || '',
    type: a.type || '',
    actorName: a.actor?.nickname || a.actor?.username || '',
    createdAt: a.created_at || '',
    payload: a.payload,
  }))
}

// ---------------------------------------------------------------------------
// C. Pull Request
// ---------------------------------------------------------------------------

/** PR 条目（GET /-/pulls → api.PullRequest；GET /-/pulls/{number} → api.Pull） */
export interface RepoPull {
  number: string
  title: string
  state: 'open' | 'closed' | 'merged'
  body?: string
  isWip: boolean
  isMerged: boolean
  mergeableState: string
  blockedOn?: string
  baseRef: string
  baseRepoPath: string
  headRef: string
  headRepoPath: string
  authorName: string
  commentCount: number
  reviewers: {
    username: string
    nickname: string
    reviewState: string
  }[]
  labels: RepoLabel[]
  createdAt: string
  updatedAt: string
}

/** api.PullRef 的 ref 形如 refs/heads/main，展示时剥掉前缀 */
function stripRefsHeads(ref?: string): string {
  return (ref || '').replace(/^refs\/heads\//, '')
}

/** api.PullRequest / api.Pull 原始结构（两者字段并集，snake_case）。
 * 导出原因：normalizePull 已导出，其参数类型必须同样可见，否则
 * 声明生成/类型检查会报「Exported function has or is using private name」。 */
export interface RawPull {
  number?: string
  title?: string
  state?: string
  body?: string
  is_wip?: boolean
  is_merged?: boolean
  mergeable_state?: string
  blocked_on?: string
  comment_count?: number
  created_at?: string
  updated_at?: string
  author?: { nickname?: string, username?: string }
  base?: { ref?: string, repo?: { path?: string } }
  head?: { ref?: string, repo?: { path?: string } }
  reviewers?: { review_state?: string, user?: { nickname?: string, username?: string } }[]
  labels?: { name?: string, color?: string }[]
}

/**
 * api.PullRequest / api.Pull 原始结构 → RepoPull（导出供 useCnbPullReviews 复用：
 * 评审人增删/标签写端点返回的也是 api.Pull，必须走同一套归一化，
 * 否则同一条 PR 在列表页与评审区的字段口径会漂移）。
 */
export function normalizePull(raw?: RawPull | null): RepoPull {
  // raw 兜底 undefined/null（cnbFetch 空 body 兜底后可能返回 undefined，
  // 2026-11-20 加固）：全部字段走可选链，空体归一为空 RepoPull
  return {
    number: raw?.number || '',
    title: raw?.title || '',
    state: raw?.state === 'merged' ? 'merged' : raw?.state === 'closed' ? 'closed' : 'open',
    body: raw?.body,
    isWip: !!raw?.is_wip,
    isMerged: !!raw?.is_merged,
    mergeableState: raw?.mergeable_state || '',
    blockedOn: raw?.blocked_on || undefined,
    baseRef: stripRefsHeads(raw?.base?.ref),
    baseRepoPath: raw?.base?.repo?.path || '',
    headRef: stripRefsHeads(raw?.head?.ref),
    headRepoPath: raw?.head?.repo?.path || '',
    authorName: raw?.author?.nickname || raw?.author?.username || '',
    commentCount: raw?.comment_count ?? 0,
    reviewers: (raw?.reviewers || []).map(r => ({
      username: r.user?.username || '',
      nickname: r.user?.nickname || r.user?.username || '',
      reviewState: r.review_state || 'pending',
    })).filter(r => r.username),
    labels: (raw?.labels || []).map(l => ({ name: l.name || '', color: l.color || '' }))
      .filter(l => l.name),
    createdAt: raw?.created_at || '',
    updatedAt: raw?.updated_at || '',
  }
}

/**
 * PR 列表（GET /{repo}/-/pulls，scope: repo-pr:r）。
 * state 支持 open/closed/all 三值（接口约定与 Issue 不同）。
 */
export async function fetchRepoPulls(
  repoPath: string,
  opts: { state: 'open' | 'closed' | 'all', page?: number, pageSize?: number },
): Promise<RepoPull[]> {
  const query = new URLSearchParams({
    state: opts.state,
    page: String(opts.page ?? 1),
    page_size: String(opts.pageSize ?? 30),
  })
  const raw = await cnbFetch<RawPull[]>(`/${encodeRepoPath(repoPath)}/-/pulls?${query}`)
  if (!Array.isArray(raw)) {
    return []
  }
  return raw.map(normalizePull)
}

/**
 * PR 详情（GET /{repo}/-/pulls/{number} → api.Pull，scope: repo-pr:r）。
 * 与列表接口的差异：返回 reviewers 评审状态。
 */
export async function fetchRepoPull(repoPath: string, number: string): Promise<RepoPull> {
  const raw = await cnbFetch<RawPull>(
    `/${encodeRepoPath(repoPath)}/-/pulls/${encodeURIComponent(number)}`,
  )
  return normalizePull(raw)
}

/** PR 变更文件（GET /-/pulls/{number}/files → api.PullFile） */
export interface PullFile {
  filename: string
  status: 'add' | 'modify' | 'delete' | 'rename' | 'copy'
  additions: number
  deletions: number
  /** unified diff 补丁文本；二进制/大文件为空（界面显示"无文本差异"） */
  patch: string
}

/**
 * PR 变更文件列表（scope: repo-pr:r）。
 * status 非法值兜底 modify（diff 着色时的中性处理）。
 */
export async function fetchPullFiles(repoPath: string, number: string): Promise<PullFile[]> {
  const raw = await cnbFetch<{
    filename?: string
    status?: string
    additions?: number
    deletions?: number
    patch?: string
  }[]>(`/${encodeRepoPath(repoPath)}/-/pulls/${encodeURIComponent(number)}/files`)
  if (!Array.isArray(raw)) {
    return []
  }
  return raw.map(f => ({
    filename: f.filename || '',
    status: (['add', 'modify', 'delete', 'rename', 'copy'] as const)
      .find(s => s === f.status) || 'modify',
    additions: f.additions ?? 0,
    deletions: f.deletions ?? 0,
    patch: f.patch || '',
  })).filter(f => f.filename)
}

/**
 * PR 提交列表（GET /{repo}/-/pulls/{number}/commits → api.Commit[]，分页）。
 * 复用 normalizeCommit，条目结构与代码页签的提交列表一致。
 */
export async function fetchPullCommits(
  repoPath: string,
  number: string,
  page = 1,
): Promise<CommitItem[]> {
  const raw = await cnbFetch<RawCommit[]>(
    `/${encodeRepoPath(repoPath)}/-/pulls/${encodeURIComponent(number)}/commits?page=${page}&page_size=30`,
  )
  if (!Array.isArray(raw)) {
    return []
  }
  return raw.map(normalizeCommit)
}

/**
 * PR 评论列表（GET /{repo}/-/pulls/{number}/comments，scope: repo-pr:r）。
 * 结构与 Issue 评论一致，共用归一化。
 */
export async function fetchPullComments(
  repoPath: string,
  number: string,
): Promise<RepoComment[]> {
  const raw = await cnbFetch<RawComment[]>(
    `/${encodeRepoPath(repoPath)}/-/pulls/${encodeURIComponent(number)}/comments`,
  )
  if (!Array.isArray(raw)) {
    return []
  }
  return raw.map(normalizeComment)
}

/**
 * 发表 PR 评论（POST /{repo}/-/pulls/{number}/comments，body { body }，
 * scope: repo-notes:rw）。
 */
export async function createPullComment(
  repoPath: string,
  number: string,
  body: string,
): Promise<void> {
  await cnbFetch(
    `/${encodeRepoPath(repoPath)}/-/pulls/${encodeURIComponent(number)}/comments`,
    { method: 'POST', body: JSON.stringify({ body }) },
  )
}

/**
 * 合并 PR（PUT /{repo}/-/pulls/{number}/merge，body snake_case，scope: repo-pr:rw）。
 * P1 功能：mergeStyle 默认值由调用方从仓库设置推断（取不到传 'merge'）。
 *
 * 返回体未定型：merged 以请求成功（不抛错）为准；sha 尽力从响应解析；
 * 服务端拒绝（不可合并/权限不足）时抛 CnbApiError，message 透出给弹窗。
 */
export async function mergePull(
  repoPath: string,
  number: string,
  form: { mergeStyle: 'merge' | 'squash' | 'rebase', commitTitle?: string, commitMessage?: string },
): Promise<{ merged: boolean, sha?: string, message?: string }> {
  const raw = await cnbFetch<{ sha?: string, message?: string }>(
    `/${encodeRepoPath(repoPath)}/-/pulls/${encodeURIComponent(number)}/merge`,
    {
      method: 'PUT',
      // 注意：该接口 body 为 snake_case（merge_style 等），与其他端点一致
      body: JSON.stringify({
        merge_style: form.mergeStyle,
        ...(form.commitTitle ? { commit_title: form.commitTitle } : {}),
        ...(form.commitMessage ? { commit_message: form.commitMessage } : {}),
      }),
    },
  )
  return {
    merged: true,
    sha: raw && typeof raw.sha === 'string' ? raw.sha : undefined,
    message: raw && typeof raw.message === 'string' ? raw.message : undefined,
  }
}

// ---------------------------------------------------------------------------
// C+. PR 创建 / 编辑 / 处理人 / CI 状态（REQ-05，7 端点）
// ---------------------------------------------------------------------------
//
// 通道约定（设计 §8.2）：POST /pulls（201 api.Pull）、PATCH /pulls/{n}（200 api.Pull）、
// POST/DELETE pull assignees（201/200 api.Pull）、GET commit-statuses（200 api.CommitStatuses）
// **全部有 body → cnbFetch**；仅 GET assignees/{a} 探测走 cnbFetchVoid（404→false）。
// 归一化复用 normalizePull / normalizeCommitStatuses，避免与详情/CI 列表出现两套映射。

/** 新建 PR 表单（UI CreatePullModal → 数据层，字段名 camelCase） */
export interface CreatePullInput {
  /** 标题（必填 2~255） */
  title: string
  /** 源分支名（不含 refs/heads/） */
  head: string
  /** 目标分支名 */
  base: string
  /** Markdown 正文（可选） */
  body?: string
  /** 跨仓库 PR 的源仓库路径（可选） */
  headRepo?: string
}

/**
 * 新建 PR（POST /{repo}/-/pulls，body api.PullCreationForm，scope: repo-pr:rw）。
 * **通道选择依据**：201 api.Pull（有 body）→ cnbFetch，复用 normalizePull 返回 RepoPull；
 * CreatePullModal 拿到 number 后直接跳详情。
 */
export async function createPull(repoPath: string, input: CreatePullInput): Promise<RepoPull> {
  const raw = await cnbFetch<RawPull>(`/${encodeRepoPath(repoPath)}/-/pulls`, {
    method: 'POST',
    body: JSON.stringify({
      title: input.title,
      head: input.head,
      base: input.base,
      ...(input.body ? { body: input.body } : {}),
      ...(input.headRepo ? { head_repo: input.headRepo } : {}),
    }),
  })
  return normalizePull(raw)
}

/**
 * 编辑 PR（PATCH /{repo}/-/pulls/{number}，body api.PatchPullRequest）。
 * **通道选择依据**：200 api.Pull（有 body）→ cnbFetch。
 * patch 的 state 可关/开 PR；只提交显式传入的字段，避免清空未改项。
 */
export async function updatePull(
  repoPath: string,
  number: string,
  patch: { title?: string, body?: string, state?: string },
): Promise<RepoPull> {
  const raw = await cnbFetch<RawPull>(
    `/${encodeRepoPath(repoPath)}/-/pulls/${encodeURIComponent(number)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.body !== undefined ? { body: patch.body } : {}),
        ...(patch.state !== undefined ? { state: patch.state } : {}),
      }),
    },
  )
  return normalizePull(raw)
}

/**
 * PR 处理人列表（GET /pulls/{n}/assignees，scope: repo-pr:r）。
 * **通道选择依据**：200 api.UserInfo[]（有 body）→ cnbFetch。
 */
export async function listPullAssignees(repoPath: string, number: string): Promise<RepoUser[]> {
  const raw = await cnbFetch<{ username?: string, nickname?: string, avatar?: string }[]>(
    `/${encodeRepoPath(repoPath)}/-/pulls/${encodeURIComponent(number)}/assignees`,
  )
  if (!Array.isArray(raw)) {
    return []
  }
  return raw.map(normalizeRepoUser).filter(user => !!user.username)
}

/**
 * 用户名是否可被分配给该 PR（GET /pulls/{n}/assignees/{assignee}）。
 * **通道选择依据**：204/404 无有效 body → cnbFetchVoid + 404→false（同 Issue 探测）。
 */
export async function canAssignPull(
  repoPath: string,
  number: string,
  username: string,
): Promise<boolean> {
  try {
    await cnbFetchVoid(
      `/${encodeRepoPath(repoPath)}/-/pulls/${encodeURIComponent(number)}/assignees/${encodeURIComponent(username)}`,
      { method: 'GET' },
    )
    return true
  }
  catch (err) {
    if (isNotFound(err)) {
      return false
    }
    throw err
  }
}

/**
 * 新增 PR 处理人（POST /pulls/{n}/assignees，body {assignees: string[]}）。
 * **通道选择依据**：201 api.Pull（有 body）→ cnbFetch，复用 normalizePull。
 */
export async function setPullAssignees(
  repoPath: string,
  number: string,
  usernames: string[],
): Promise<RepoPull> {
  const raw = await cnbFetch<RawPull>(
    `/${encodeRepoPath(repoPath)}/-/pulls/${encodeURIComponent(number)}/assignees`,
    { method: 'POST', body: JSON.stringify({ assignees: usernames }) },
  )
  return normalizePull(raw)
}

/**
 * 移除 PR 处理人（DELETE /pulls/{n}/assignees，body {assignees: string[]}）。
 * **通道选择依据**：200 api.Pull（有 body）→ cnbFetch（不是 Void）。
 */
export async function removePullAssignees(
  repoPath: string,
  number: string,
  usernames: string[],
): Promise<RepoPull> {
  const raw = await cnbFetch<RawPull>(
    `/${encodeRepoPath(repoPath)}/-/pulls/${encodeURIComponent(number)}/assignees`,
    { method: 'DELETE', body: JSON.stringify({ assignees: usernames }) },
  )
  return normalizePull(raw)
}

/**
 * PR 维度 CI 状态（GET /{repo}/-/pulls/{number}/commit-statuses，scope: repo-pr:r）。
 *
 * **通道选择依据**：200 api.CommitStatuses（有 body）→ cnbFetch；结构与单提交
 * commit-statuses 完全一致，复用 normalizeCommitStatuses + commitStatusMeta
 * （GitLab 六态独立映射，未知中性色）—— **禁止复用 useCnbBuildWatch 构建四态**。
 * 403（缺 repo-pr:r）抛 CnbApiError，由 RepoPullDetail 的 CI 区块 StateAlert 降级，
 * 不影响 PR 主体。
 */
export async function fetchPullCommitStatuses(
  repoPath: string,
  number: string,
): Promise<CommitStatusResult> {
  const raw = await cnbFetch<RawCommitStatuses>(
    `/${encodeRepoPath(repoPath)}/-/pulls/${encodeURIComponent(number)}/commit-statuses`,
  )
  return normalizeCommitStatuses(raw)
}

// ---------------------------------------------------------------------------
// D. 流水线构建
// ---------------------------------------------------------------------------

/** 构建历史条目（GET /-/build/logs → dto.LogInfo —— 注意：此结构本身是 camelCase） */
export interface BuildLogItem {
  sn: string
  status: string
  commitTitle: string
  sha: string
  nickName: string
  sourceRef: string
  event: string
  durationMs: number
  createTime: string
  buildLogUrl: string
  eventUrl: string
  pipelineTotalCount: number
  pipelineSuccessCount: number
  pipelineFailCount: number
}

/**
 * 构建历史（GET /{repo}/-/build/logs?status=&sn=&page=&page_size=，
 * scope: repo-cnb-history:r）。
 * 返回 { total, items }；dto.LogInfo 本身 camelCase，仅做缺省兜底 + duration → durationMs 改名。
 *
 * opts.sn：按构建序号精确查询。
 * 为什么需要它：构建通知轮询只拉 status=pending 的列表，发现某 sn 从
 * pending 列表里消失后，必须回查这一条构建的**最终状态**（success /
 * error / cancel）才能给出正确文案；列表接口支持 sn 过滤，因此不必为
 * 单条构建再走 /build/status/{sn}（后者需要 repo-cnb-trigger:r 权限，
 * 而本功能只保证 repo-cnb-history:r）。
 * 回查语义与列表一致：查不到时返回 items: []（total 0），由调用方
 * 按"状态未知"降级处理，不抛错。
 */
export async function fetchBuildLogs(
  repoPath: string,
  opts: { status?: string, sn?: string, page?: number, pageSize?: number } = {},
): Promise<{ total: number, items: BuildLogItem[] }> {
  const query = new URLSearchParams({
    page: String(opts.page ?? 1),
    page_size: String(opts.pageSize ?? 30),
  })
  if (opts.status) {
    query.set('status', opts.status)
  }
  // sn 精确查询：用于回查单条构建的最终状态（见函数注释）
  if (opts.sn) {
    query.set('sn', opts.sn)
  }
  const raw = await cnbFetch<{
    total?: number
    /** dto.LogInfo 原始条目（camelCase，duration 为原始耗时字段名） */
    data?: (Omit<Partial<BuildLogItem>, 'durationMs'> & { duration?: number })[]
  }>(`/${encodeRepoPath(repoPath)}/-/build/logs?${query}`)
  const items = (Array.isArray(raw?.data) ? raw.data : []).map(d => ({
    // sn 用 String() 收敛，而不是 `d.sn || ''`（类型契约脆弱点）：
    // 若服务端把 sn 返回成数字，`d.sn || ''` 会把 number 塞进声明为 string
    // 的字段（TS 不报错但运行时是 number）。这条 sn 会进入系统通知的 extra，
    // 被 JSON 序列化为数字；Rust 的 extra_str 只认 Value::String → 取不到 →
    // 「点击通知直达构建详情」在所有平台静默退化成"打开通知面板"。
    sn: String(d.sn ?? ''),
    status: d.status || '',
    commitTitle: d.commitTitle || '',
    sha: d.sha || '',
    nickName: d.nickName || '',
    sourceRef: d.sourceRef || '',
    event: d.event || '',
    durationMs: d.duration ?? 0,
    createTime: d.createTime || '',
    buildLogUrl: d.buildLogUrl || '',
    eventUrl: d.eventUrl || '',
    pipelineTotalCount: d.pipelineTotalCount ?? 0,
    pipelineSuccessCount: d.pipelineSuccessCount ?? 0,
    pipelineFailCount: d.pipelineFailCount ?? 0,
  }))
  return { total: raw?.total ?? items.length, items }
}

/** 阶段状态（dto.Stage，duration → durationMs 归一） */
export interface PipelineStage {
  id: string
  name: string
  status: string
  durationMs: number
}

/** 构建状态（GET /-/build/status/{sn} → dto.BuildStatusResult，归一化后） */
export interface BuildStatus {
  status: string
  pipelines: {
    id: string
    name: string
    status: string
    durationMs: number
    stages: PipelineStage[]
  }[]
  /** false = pipelinesStatus 解析失败（结构为空/异常），页面降级为只读列表 + 外跳 */
  parseOk: boolean
}

/**
 * 构建详情状态（scope: repo-cnb-trigger:r）。
 *
 * pipelinesStatus 是 free-form object（swagger 未定型，PRD R6/R10）：
 * 主路径按 Record<pipelineId, dto.PipelineStatus> 解析（含 id/name/status/
 * duration/stages[]，dto.Stage 含 id）；解析失败（非对象 / 无有效条目）时
 * 返回 parseOk=false 且 pipelines=[]，页面自动降级为只读列表 + 外跳日志，
 * 而不是抛错白屏。
 */
export async function fetchBuildStatus(repoPath: string, sn: string): Promise<BuildStatus> {
  const raw = await cnbFetch<{
    status?: string
    pipelinesStatus?: Record<string, unknown>
  }>(`/${encodeRepoPath(repoPath)}/-/build/status/${encodeURIComponent(sn)}`)

  const result: BuildStatus = { status: raw?.status || '', pipelines: [], parseOk: false }
  const ps = raw?.pipelinesStatus
  // 结构守卫：非对象（含数组/空/null）一律判定解析失败
  if (!ps || typeof ps !== 'object' || Array.isArray(ps)) {
    return result
  }
  const pipelines: BuildStatus['pipelines'] = []
  for (const [key, value] of Object.entries(ps)) {
    if (!value || typeof value !== 'object') {
      continue
    }
    const p = value as {
      id?: string
      name?: string
      status?: string
      duration?: number
      stages?: { id?: string, name?: string, status?: string, duration?: number }[]
    }
    pipelines.push({
      id: p.id || key,
      name: p.name || key,
      status: p.status || '',
      durationMs: p.duration ?? 0,
      // stages 缺失按空数组处理（该流水线可能尚未产出阶段）
      stages: (Array.isArray(p.stages) ? p.stages : []).map(s => ({
        id: s.id || '',
        name: s.name || '',
        status: s.status || '',
        durationMs: s.duration ?? 0,
      })),
    })
  }
  // 无有效流水线条目也视为解析失败：界面无事可渲染，走外跳降级
  result.pipelines = pipelines
  result.parseOk = pipelines.length > 0
  return result
}

/** 阶段日志（GET /-/build/logs/stage/{sn}/{pipelineId}/{stageId} → dto.BuildStageResult） */
export interface StageLog {
  name: string
  status: string
  durationMs: number
  error: string
  /** content 数组原样（每元素一行日志） */
  lines: string[]
}

/**
 * 阶段日志（scope: repo-cnb-history:r 或 repo-cnb-trigger:r）。
 * dto.BuildStageResult.content 为 string[]，本层原样透传；结构异常时兜底空数组。
 */
export async function fetchStageLog(
  repoPath: string,
  sn: string,
  pipelineId: string,
  stageId: string,
): Promise<StageLog> {
  const raw = await cnbFetch<{
    name?: string
    status?: string
    duration?: number
    error?: string
    content?: string[]
  }>(
    `/${encodeRepoPath(repoPath)}/-/build/logs/stage/${encodeURIComponent(sn)}/${encodeURIComponent(pipelineId)}/${encodeURIComponent(stageId)}`,
  )
  return {
    name: raw?.name || '',
    status: raw?.status || '',
    durationMs: raw?.duration ?? 0,
    error: raw?.error || '',
    lines: Array.isArray(raw?.content) ? raw.content : [],
  }
}

/** 导出错误类别类型：StateAlert 组件按 kind 分支渲染（re-export 避免循环依赖页面直接引 useCnbAuth） */
export type { CnbApiErrorKind }

// ---------------------------------------------------------------------------
// E. 流水线写操作（设计文档 §3.2 / 附录 A #1~#3，scope: repo-cnb-trigger:rw）
// ---------------------------------------------------------------------------

/**
 * 构建触发结果（dto.BuildResult）。
 *
 * ⚠️ swagger 陷阱 3：`success` 是"是否触发成功"（如分支不存在 → false），
 * **HTTP 200 + success=false 是合法组合** —— 调用方必须判该字段并把
 * message 透出给用户，不能以"请求没抛错"当作触发成功。
 */
export interface BuildTriggerResult {
  sn: string
  buildLogUrl: string
  message: string
  /** HTTP 200 也可能为 false（分支不存在等），必须显式判断 */
  success: boolean
}

/**
 * 触发构建（POST /{repo}/-/build/start，body: dto.StartBuildReq）。
 *
 * dto.StartBuildReq 的 3 个 swagger 陷阱（全部已按实测行为处理）：
 * 1. `event` 文档要求「须为 api_trigger 或以它开头」→ 固定传 'api_trigger'，
 *    不暴露给调用方自定义（传其他值会被服务端拒绝）；
 * 2. `sync` 的 swagger 类型是**字符串**而非 boolean（原文 "sync":
 *    {"type":"string"}）→ 固定传 'false'（字符串），拿到 sn 立即返回；
 * 3. `success` 判定见 BuildTriggerResult 注释 —— 本函数不做 success 拦截，
 *    原样返回完整结果由调用方决定 UI 行为（弹窗内 toast error 等）。
 *
 * @param opts.branch 触发分支（缺省由服务端取主分支）
 * @param opts.sha 提交 SHA（优先级高于 tag）
 * @param opts.tag 触发 tag（优先级高于 branch）
 * @param opts.title 构建标题（可选）
 * @param opts.env 环境变量（可选，值必须全为字符串）
 */
export async function triggerBuild(
  repoPath: string,
  opts: { branch?: string, sha?: string, tag?: string, title?: string, env?: Record<string, string> } = {},
): Promise<BuildTriggerResult> {
  // 请求体组装：仅在调用方提供时写入对应字段（branch 缺省由服务端兜底）
  const body: Record<string, unknown> = {
    // —— 陷阱 1/2：event 固定 api_trigger；sync 是字符串 'false' ——
    event: 'api_trigger',
    sync: 'false',
  }
  if (opts.branch) {
    body.branch = opts.branch
  }
  if (opts.sha) {
    body.sha = opts.sha
  }
  if (opts.tag) {
    body.tag = opts.tag
  }
  if (opts.title) {
    body.title = opts.title
  }
  if (opts.env && Object.keys(opts.env).length > 0) {
    body.env = opts.env
  }
  const raw = await cnbFetch<{
    sn?: string
    buildLogUrl?: string
    message?: string
    success?: boolean
  }>(`/${encodeRepoPath(repoPath)}/-/build/start`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
  return {
    // 同上（fetchBuildLogs 的 sn）：trigger 响应里的 sn 也必须 String 收敛，
    // 否则 number 型 sn 会让后续「构建详情路由 / 通知 extra」两处都失真
    sn: String(raw?.sn ?? ''),
    buildLogUrl: raw?.buildLogUrl || '',
    message: raw?.message || '',
    // success 缺失（服务端未返回）时按 false 处理，防止把异常响应当成功
    success: raw?.success === true,
  }
}

/** 构建写操作通用响应（停止 / 删日志：{code, message}） */
export interface BuildCommonResult {
  code: number
  message: string
}

/**
 * 停止构建（POST /{repo}/-/build/stop/{sn}，scope: repo-cnb-trigger:rw）。
 * 成功后调用方应重拉 fetchBuildStatus 直到终态（success/error/cancel）。
 */
export async function stopBuild(repoPath: string, sn: string): Promise<BuildCommonResult> {
  const raw = await cnbFetch<{ code?: number, message?: string }>(
    `/${encodeRepoPath(repoPath)}/-/build/stop/${encodeURIComponent(sn)}`,
    { method: 'POST' },
  )
  return { code: raw?.code ?? 0, message: raw?.message || '' }
}

/**
 * 删除构建日志（DELETE /{repo}/-/build/logs/{sn}，scope: repo-cnb-trigger:rw）。
 * ⚠️ 删除的是**日志**而非构建记录本身，删除后日志区呈空态（设计文档 T04-4）。
 */
export async function deleteBuildLogs(repoPath: string, sn: string): Promise<BuildCommonResult> {
  const raw = await cnbFetch<{ code?: number, message?: string }>(
    `/${encodeRepoPath(repoPath)}/-/build/logs/${encodeURIComponent(sn)}`,
    { method: 'DELETE' },
  )
  return { code: raw?.code ?? 0, message: raw?.message || '' }
}
