/**
 * Release 数据层（设计文档 §3.3，T06）。
 *
 * 覆盖端点（swagger 逐条核对，scope repo-release:r / :rw）：
 * - GET /{repo}/-/releases?page=&page_size=（列表）
 * - GET /{repo}/-/releases/latest（latest；无 Release 时 404）
 * - GET /{repo}/-{repo_id} —— GET /{repo}/-/releases/{release_id}（详情）
 * - POST /{repo}/-/releases（创建，openapi.PostReleaseForm）
 * - PATCH /{repo}/-/releases/{release_id}（部分更新，openapi.PatchReleaseForm）
 * - DELETE /{repo}/-/releases/{release_id}（删除 —— **不删除 git tag**）
 *
 * 归一化要点（设计文档 T06 验收标准，全部在 normalizeRelease 锁定）：
 * - assets 缺失 → []；
 * - name 为空 → 回退 tagName；
 * - published_at 为空 → 回退 created_at；
 * - **禁止读取 `brower_download_url`**（官方拼写错误字段，swagger 标注
 *   "即将删除"，服务端拼写就是少一个 s —— 别"修正"它）。
 */
import { cnbFetch, CnbApiError } from './useCnbAuth'

/** 仓库路径 -> API URL 路径段：逐段 encodeURIComponent（'/' 保留为分隔符） */
function encodeRepoPath(repoPath: string): string {
  return repoPath.split('/').map(encodeURIComponent).join('/')
}

// ---------------------------------------------------------------------------
// 原始结构（snake_case，仅声明用到的字段）
// ---------------------------------------------------------------------------

/** api.ReleaseAsset 原始结构 */
export interface RawReleaseAsset {
  id?: string
  name?: string
  path?: string
  size?: number
  content_type?: string
  hash_algo?: string
  hash_value?: string
  created_at?: string
  /** API 域下载地址（需 Bearer）——走 Rust 下载命令 cnb_download_archive */
  url?: string
  /** 主站地址（浏览器可访问） */
  browser_download_url?: string
  /** ⚠️ 拼写错误字段（swagger 标注"即将删除"），**禁止读取** —— 见文件头注释 */
  brower_download_url?: string
}

/** api.Release 原始结构 */
export interface RawRelease {
  id?: string
  tag_name?: string
  tag_commitish?: string
  name?: string
  body?: string
  draft?: boolean
  prerelease?: boolean
  is_latest?: boolean
  created_at?: string
  published_at?: string
  updated_at?: string
  author?: { username?: string, nickname?: string, avatar?: string }
  assets?: RawReleaseAsset[]
}

// ---------------------------------------------------------------------------
// 归一化导出类型（camelCase，字段全非可选，界面层不判空）
// ---------------------------------------------------------------------------

/** Release 附件（归一化后） */
export interface ReleaseAsset {
  id: string
  name: string
  path: string
  size: number
  contentType: string
  hashAlgo: string
  hashValue: string
  createdAt: string
  /** API 域下载地址（走 Rust 下载命令） */
  apiUrl: string
  /** 主站地址（浏览器下载兜底外跳） */
  browserUrl: string
}

/** Release 条目（归一化后） */
export interface ReleaseItem {
  id: string
  tagName: string
  tagCommitish: string
  name: string
  body: string
  isDraft: boolean
  isPrerelease: boolean
  isLatest: boolean
  createdAt: string
  publishedAt: string
  updatedAt: string
  authorName: string
  authorAvatar: string
  assets: ReleaseAsset[]
}

/** RawReleaseAsset → ReleaseAsset（数字 ?? 0、字符串 || ''，数组恒返回 []） */
function normalizeAsset(raw: RawReleaseAsset): ReleaseAsset {
  return {
    id: raw.id || '',
    name: raw.name || '',
    path: raw.path || raw.name || '',
    size: raw.size ?? 0,
    contentType: raw.content_type || '',
    hashAlgo: raw.hash_algo || '',
    hashValue: raw.hash_value || '',
    createdAt: raw.created_at || '',
    // 仅读 url（API 域）与 browser_download_url（正确拼写的字段）；
    // brower_download_url 为官方拼写错误字段，禁止读取
    apiUrl: raw.url || '',
    browserUrl: raw.browser_download_url || '',
  }
}

/**
 * RawRelease → ReleaseItem 归一化（纯函数导出，供单测）。
 *
 * 兜底规则（T06 验收标准逐条对应）：
 * - assets 缺失/非数组 → []；
 * - name 为空 → 回退 tagName（列表无"无标题"占位）；
 * - publishedAt 为空 → 回退 createdAt（草稿 Release 无发布时间）；
 * - tag 无值的条目仍保留（id 为空时 UI 不可编辑/删除，仅展示）。
 */
export function normalizeRelease(raw: RawRelease): ReleaseItem {
  const tagName = raw.tag_name || ''
  return {
    id: raw.id || '',
    tagName,
    tagCommitish: raw.tag_commitish || '',
    name: raw.name || tagName,
    body: raw.body || '',
    isDraft: !!raw.draft,
    isPrerelease: !!raw.prerelease,
    isLatest: !!raw.is_latest,
    createdAt: raw.created_at || '',
    publishedAt: raw.published_at || raw.created_at || '',
    updatedAt: raw.updated_at || '',
    authorName: raw.author?.nickname || raw.author?.username || '',
    authorAvatar: raw.author?.avatar || '',
    assets: Array.isArray(raw.assets) ? raw.assets.map(normalizeAsset) : [],
  }
}

// ---------------------------------------------------------------------------
// 读操作
// ---------------------------------------------------------------------------

/**
 * Release 列表（GET /{repo}/-/releases?page=&page_size=，scope repo-release:r）。
 * @param opts.page 页码（从 1 开始）
 * @param opts.pageSize 每页条数（UI 默认 20）
 */
export async function fetchReleases(
  repoPath: string,
  opts: { page?: number, pageSize?: number } = {},
): Promise<ReleaseItem[]> {
  const query = new URLSearchParams({
    page: String(opts.page ?? 1),
    page_size: String(opts.pageSize ?? 20),
  })
  const raw = await cnbFetch<RawRelease[]>(
    `/${encodeRepoPath(repoPath)}/-/releases?${query}`,
  )
  if (!Array.isArray(raw)) {
    return []
  }
  return raw.map(normalizeRelease)
}

/**
 * 最新 Release（GET /{repo}/-/releases/latest，scope repo-release:r）。
 *
 * 无任何 Release 时服务端返回 404 —— 本函数捕获 notFound 并返回 null
 * （**不抛**）：调用方（列表徽标/空态引导）需要"没有 latest"这个信息，
 * 404 是正常业务态而非错误。其余错误（403/网络）照常抛出。
 */
export async function fetchLatestRelease(repoPath: string): Promise<ReleaseItem | null> {
  try {
    const raw = await cnbFetch<RawRelease>(
      `/${encodeRepoPath(repoPath)}/-/releases/latest`,
    )
    return normalizeRelease(raw)
  }
  catch (err) {
    // 仅吞 404（无 Release 的正常态）；401 由全局拦截器登出，403/网络照常抛
    if (err instanceof CnbApiError && err.kind === 'notFound') {
      return null
    }
    throw err
  }
}

/**
 * Release 详情（GET /{repo}/-/releases/{release_id}，scope repo-release:r）。
 * releaseId 为服务端 id（非 git tag）。404 抛 CnbApiError(kind=notFound)，
 * 由页面渲染 notFound 态（不自动回列表，设计文档 §2.3）。
 */
export async function fetchRelease(repoPath: string, releaseId: string): Promise<ReleaseItem> {
  const raw = await cnbFetch<RawRelease>(
    `/${encodeRepoPath(repoPath)}/-/releases/${encodeURIComponent(releaseId)}`,
  )
  return normalizeRelease(raw)
}

// ---------------------------------------------------------------------------
// 写操作
// ---------------------------------------------------------------------------

/** 创建 Release 的表单字段（openapi.PostReleaseForm） */
export interface CreateReleaseInput {
  /** git tag 名（必填） */
  tagName: string
  /** 分支名或 commit sha（openapi.PostReleaseForm.target_commitish） */
  targetCommitish?: string
  /** 标题（缺省服务端用 tag 名） */
  name?: string
  /** 描述（Markdown） */
  body?: string
  draft?: boolean
  prerelease?: boolean
  /**
   * 是否标记为最新版本 —— swagger 是**字符串枚举** 'true' | 'false' | 'legacy'
   * （openapi.PostReleaseForm.make_latest），不是布尔值
   */
  makeLatest?: 'true' | 'false' | 'legacy'
}

/**
 * 创建 Release（POST /{repo}/-/releases，scope repo-release:rw）→ 201 + api.Release。
 * tag 已存在 / target 非法时抛 CnbApiError（422/400），表单保留输入。
 */
export async function createRelease(
  repoPath: string,
  input: CreateReleaseInput,
): Promise<ReleaseItem> {
  const body: Record<string, unknown> = {
    tag_name: input.tagName,
  }
  if (input.targetCommitish) {
    body.target_commitish = input.targetCommitish
  }
  if (input.name) {
    body.name = input.name
  }
  if (input.body) {
    body.body = input.body
  }
  if (input.draft !== undefined) {
    body.draft = input.draft
  }
  if (input.prerelease !== undefined) {
    body.prerelease = input.prerelease
  }
  if (input.makeLatest) {
    body.make_latest = input.makeLatest
  }
  const raw = await cnbFetch<RawRelease>(`/${encodeRepoPath(repoPath)}/-/releases`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
  return normalizeRelease(raw)
}

/**
 * 更新 Release（PATCH /{repo}/-/releases/{release_id}，scope repo-release:rw）。
 *
 * ⚠️ openapi.PatchReleaseForm 只支持 name / body / draft / prerelease /
 * make_latest —— **不支持改 tag_name / target_commitish**（tag 与提交绑定后
 * 不可迁移），调用方传了也会被忽略。patch 参数仅接受可修改字段。
 */
export async function updateRelease(
  repoPath: string,
  releaseId: string,
  patch: {
    name?: string
    body?: string
    draft?: boolean
    prerelease?: boolean
    makeLatest?: 'true' | 'false' | 'legacy'
  },
): Promise<void> {
  const body: Record<string, unknown> = {}
  if (patch.name !== undefined) {
    body.name = patch.name
  }
  if (patch.body !== undefined) {
    body.body = patch.body
  }
  if (patch.draft !== undefined) {
    body.draft = patch.draft
  }
  if (patch.prerelease !== undefined) {
    body.prerelease = patch.prerelease
  }
  if (patch.makeLatest !== undefined) {
    body.make_latest = patch.makeLatest
  }
  await cnbFetch(
    `/${encodeRepoPath(repoPath)}/-/releases/${encodeURIComponent(releaseId)}`,
    { method: 'PATCH', body: JSON.stringify(body) },
  )
}

/**
 * 删除 Release（DELETE /{repo}/-/releases/{release_id}，scope repo-release:rw）。
 * ⚠️ **不删除 git tag**（swagger 明确）—— UI 的删除确认文案必须写清这一点，
 * 避免用户误以为 tag 也一并删除。
 */
export async function deleteRelease(repoPath: string, releaseId: string): Promise<void> {
  await cnbFetch(
    `/${encodeRepoPath(repoPath)}/-/releases/${encodeURIComponent(releaseId)}`,
    { method: 'DELETE' },
  )
}

/**
 * 附件下载地址拼装（GET /{repo}/-/releases/download/{tag}/{filename}）。
 * 地址在 api.cnb.cool 域内（满足 Rust 下载命令的 URL 白名单），
 * asset.url 缺失时用它兜底。
 */
export function releaseAssetApiUrl(repoPath: string, tagName: string, fileName: string): string {
  const base = `/${encodeRepoPath(repoPath)}/-/releases/download/${encodeURIComponent(tagName)}/${encodeURIComponent(fileName)}`
  // API 基址与 cnbFetch 一致（Rust 白名单按完整 URL 前缀校验）
  return `https://api.cnb.cool${base}`
}
