/**
 * 仓库管理写操作数据层（设计文档 §3.5）。
 *
 * 覆盖端点（swagger 逐条核对）：
 * - PATCH /{repo} —— dto.RepoPatch，scope repo-manage:rw
 * - POST /{slug}/-/settings/archive | unarchive —— scope repo-manage:rw,repo-code:rw
 * - POST /{slug}/-/repos —— dto.CreateRepoReq，scope group-resource:rw
 *
 * ⚠️ 事实核对（设计文档 §1.1，实现必须遵守）：
 * `dto.RepoPatch` 只有 4 个字段 description / license / site / topics，
 * **没有 visibility** —— 全库 201 path 中没有任何端点支持修改仓库可见性
 * （可见性变更被官方放在 Web 端锁定控制）。因此本模块**不提供**可见性
 * 修改函数，UI 中可见性为只读展示 + 外跳 Web 端。
 * 注意：可见性在**创建**时可设（dto.CreateRepoReq.visibility，见 createRepo）。
 */
import { cnbFetch } from './useCnbAuth'

/** 仓库路径 -> API URL 路径段：逐段 encodeURIComponent（'/' 保留为分隔符） */
function encodeSlug(slug: string): string {
  return slug.split('/').map(encodeURIComponent).join('/')
}

/** 仓库路径 -> API URL 路径段（语义同 encodeSlug，命名区分仓库/组织场景） */
function encodeRepoPath(repoPath: string): string {
  return repoPath.split('/').map(encodeURIComponent).join('/')
}

/**
 * PATCH /{repo} 的可修改字段（dto.RepoPatch 完整清单，swagger 核对）。
 * 注意没有 visibility —— 见文件顶部事实核对说明。
 */
export interface RepoPatchInput {
  description?: string
  site?: string
  license?: string
  topics?: string[]
}

/**
 * 更新仓库基础信息（PATCH /{repo}，scope repo-manage:rw）。
 *
 * 支持部分更新：仅传入需要修改的字段（未传字段服务端保持原值）。
 * 成功返回 200（无响应体）；调用方负责成功后刷新本地 RepoDetail
 * （RepoSettingsDrawer emit('updated') → 父页 loadRepo，§8.5）。
 *
 * @throws CnbApiError 403（缺 repo-manage:rw）时 kind=forbidden，
 *         StateAlert 呈现 scope 提示且**不登出**（红线）。
 */
export async function patchRepo(repoPath: string, input: RepoPatchInput): Promise<void> {
  const body: Record<string, unknown> = {}
  if (input.description !== undefined) {
    body.description = input.description
  }
  if (input.site !== undefined) {
    body.site = input.site
  }
  if (input.license !== undefined) {
    body.license = input.license
  }
  if (input.topics !== undefined) {
    body.topics = input.topics
  }
  await cnbFetch(`/${encodeRepoPath(repoPath)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

/**
 * 归档仓库（POST /{slug}/-/settings/archive，scope repo-manage:rw,repo-code:rw）。
 * 归档后仓库只读（status=1，RepoStatusArchived），页头显示归档徽标、
 * 全部写入口禁用。破坏性操作 —— UI 必须经 ConfirmDialog 二次确认。
 */
export async function archiveRepo(slug: string): Promise<void> {
  await cnbFetch(`/${encodeSlug(slug)}/-/settings/archive`, { method: 'POST' })
}

/**
 * 解除归档（POST /{slug}/-/settings/unarchive，scope 同归档）。
 * 非破坏性恢复操作（确认框用 primary 色，§8.3 规则 2）。
 */
export async function unarchiveRepo(slug: string): Promise<void> {
  await cnbFetch(`/${encodeSlug(slug)}/-/settings/unarchive`, { method: 'POST' })
}

/**
 * 创建仓库请求体（dto.CreateRepoReq，swagger 核对）。
 *
 * 可见性枚举口径（设计文档 §3.5 已同步为小写三值 + 勘误注记）：swagger 原文
 * `dto.CreateRepoReq.visibility` 的枚举是**小写** `["public", "private", "secret"]`
 * 且默认 public（大写值会被服务端 400 拒绝）。
 *
 * ⚠️ 两套枚举禁止透传：创建入参是小写三值，但 GET /{repo} 返回的
 * `RepoDetail.visibility` 来自 dto.Repos4User.visibility_level，是**首字母
 * 大写**的 `Private|Public|Secret`（visibilityBadge 按大写 switch）。
 * 若未来设置抽屉要"带出当前可见性"，必须显式转小写，直接塞 detail.visibility 会 400。
 */
export type CreateRepoVisibility = 'public' | 'private' | 'secret'

export interface CreateRepoInput {
  /** 仓库名（CNB 命名规则 ^[\w.-]+$，UI 层校验） */
  name: string
  description?: string
  /** 可见性：'public' | 'private' | 'secret'（小写，swagger 枚举；缺省 public） */
  visibility?: CreateRepoVisibility
}

/**
 * 在组织下创建仓库（POST /{slug}/-/repos，scope group-resource:rw）。
 * 成功返回 201（无响应体）—— 调用方凭"不抛错"判定成功，
 * 新仓库地址由 `${slug}/${name}` 拼接（UI 负责跳转/刷新列表）。
 */
export async function createRepo(slug: string, input: CreateRepoInput): Promise<void> {
  const body: Record<string, unknown> = { name: input.name }
  if (input.description !== undefined && input.description !== '') {
    body.description = input.description
  }
  if (input.visibility) {
    body.visibility = input.visibility
  }
  await cnbFetch(`/${encodeSlug(slug)}/-/repos`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}
