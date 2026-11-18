/**
 * Git 引用（分支 + 标签）数据层 —— REQ-01 / REQ-02。
 *
 * 设计要点（务必对照设计文档 §8.2 写端点通道逐条表）：
 * - 分支写端点（create/delete/lock/unlock）响应均为 201/200/204 **空 body**，
 *   必须走 cnbFetchVoid —— 若误用 cnbFetch，response.json() 会抛
 *   "Unexpected end of JSON input" 把成功报成失败；
 * - **createTag 是唯一例外**：POST /git/tags 返回 201 api.Tag（**有 body**），
 *   必须走 cnbFetch 并直接把归一化结果插入列表，避免重拉（踩坑#3 的头号反例）；
 * - GET 详情端点均走 cnbFetch；
 * - 分支名/标签名是**单个路径段**（如 feature/x），必须 encodeURIComponent
 *   把内部 '/' 压成 %2F；仓库路径则走 encodeRepoPath 逐段编码（'/' 保留为分隔符）。
 *
 * 归一化约定：私有 Raw* 接口全可选 snake_case → normalize → 导出 camelCase
 * 全非可选；数组异常降级 []，字符串 || ''，布尔 !!，数字 ?? 0。
 */
import { cnbFetch, cnbFetchVoid } from './useCnbAuth'
import { encodeRepoPath } from './useCnbRepo'

// ---------------------------------------------------------------------------
// 类型（camelCase，界面层不判空）
// ---------------------------------------------------------------------------

/** 分支详情（GET /{repo}/-/git/branches/{branch} → api.BranchDetail） */
export interface BranchDetail {
  /** 分支名（可能含 '/'） */
  name: string
  /** 当前指向的提交 SHA（来源 commit.sha） */
  sha: string
  /** 是否受保护分支（删除时服务端会拒绝） */
  protected: boolean
  /** 是否锁定（锁定后其他人无法推送） */
  locked: boolean
  /** 指向提交的首行信息（commit.message 的第一行） */
  commitMessage: string
}

/** 标签详情（GET /{repo}/-/git/tags/{tag} 与 POST 响应 → api.Tag） */
export interface TagDetail {
  /** 标签名 */
  name: string
  /** 目标哈希（target 优先，缺失时回退 commit.sha） */
  sha: string
  /** 目标类型原文（commit / tag 等） */
  targetType: string
  /** 是否附注标签：target_type === 'tag' 视为附注，否则轻量 */
  annotated: boolean
  /** 附注信息（轻量标签通常为空） */
  message: string
  /** 是否通过 GPG 签名校验（verification 缺失/为假即未校验） */
  verified: boolean
}

// ---------------------------------------------------------------------------
// 原始响应结构（snake_case，仅声明归一化用到的字段）
// ---------------------------------------------------------------------------

/**
 * api.BranchDetail 原始结构。
 *
 * swagger 核对：`api.BranchDetail.commit` 的类型是 **api.Commit**（本身有
 * commit 子对象），其 message 在 `commit.commit.message`；但历史/简化响应
 * 也可能直接给 `{ commit: { sha, message } }`。两种形态都兼容，优先取嵌套
 * 标准形态，避免展示副标题为空。
 */
interface RawBranchDetail {
  name?: string
  protected?: boolean
  locked?: boolean
  commit?: {
    sha?: string
    message?: string
    commit?: { message?: string }
  }
}

/** api.Tag 原始结构（target_type 决定轻量/附注；verification 可能为空对象或 null） */
interface RawTag {
  name?: string
  target?: string
  target_type?: string
  message?: string
  commit?: { sha?: string }
  verification?: unknown
}

// ---------------------------------------------------------------------------
// 归一化（导出供单测直接断言，避免只能从网络层间接观测）
// ---------------------------------------------------------------------------

/**
 * RawBranchDetail → BranchDetail。
 * commit.sha 兜底空串（列表项同样口径），message 首行作为展示副标题。
 */
export function normalizeBranchDetail(raw: RawBranchDetail): BranchDetail {
  // 标准 api.Commit 形态 message 在 commit.commit.message；兼容扁平形态 commit.message
  const message = raw?.commit?.commit?.message || raw?.commit?.message || ''
  return {
    name: raw?.name || '',
    sha: raw?.commit?.sha || '',
    protected: !!raw?.protected,
    locked: !!raw?.locked,
    commitMessage: message.split('\n')[0] || '',
  }
}

/**
 * RawTag → TagDetail。
 *
 * annotated 的判定口径（设计 §2.2）：target_type === 'tag' 为附注标签，
 * 其余（commit 或空值）一律轻量 —— 不因为字段缺失就误标附注。
 * verification 兼容两种形态：字符串/布尔按 truthy，对象取内部 verified 字段
 * （CNB 部分版本返回 { verified: true, ... } 审计对象）。
 */
export function normalizeTag(raw: RawTag): TagDetail {
  let verified = false
  if (typeof raw?.verification === 'object' && raw.verification !== null) {
    verified = !!(raw.verification as { verified?: boolean }).verified
  }
  else {
    verified = !!raw?.verification
  }
  return {
    name: raw?.name || '',
    sha: raw?.target || raw?.commit?.sha || '',
    targetType: raw?.target_type || '',
    annotated: raw?.target_type === 'tag',
    message: raw?.message || '',
    verified,
  }
}

// ---------------------------------------------------------------------------
// 分支 CRUD（REQ-01，5 端点）
// ---------------------------------------------------------------------------

/**
 * 新建分支（POST /{repo}/-/git/branches，scope: repo-code:rw）。
 *
 * **通道选择依据**：swagger 响应 201 + 空 schema，实际响应无 body —— 走
 * cnbFetchVoid。请求体字段名是 snake_case 的 start_point（openapi.CreateBranchForm），
 * 与 UI 传入的 camelCase startPoint 在此处转换。
 */
export async function createBranch(
  repoPath: string,
  input: { name: string, startPoint?: string },
): Promise<void> {
  await cnbFetchVoid(`/${encodeRepoPath(repoPath)}/-/git/branches`, {
    method: 'POST',
    body: JSON.stringify({
      name: input.name,
      ...(input.startPoint ? { start_point: input.startPoint } : {}),
    }),
  })
}

/**
 * 删除分支（DELETE /{repo}/-/git/branches/{branch}，scope: repo-code:rw）。
 * **通道选择依据**：200 空 body → cnbFetchVoid。
 * branch 含 '/'（如 feature/x）时整体编码成 feature%2Fx（单段内嵌斜杠口径）。
 */
export async function deleteBranch(repoPath: string, branch: string): Promise<void> {
  await cnbFetchVoid(
    `/${encodeRepoPath(repoPath)}/-/git/branches/${encodeURIComponent(branch)}`,
    { method: 'DELETE' },
  )
}

/**
 * 分支详情（GET /{repo}/-/git/branches/{branch}，scope: repo-code:r）。
 * **通道选择依据**：200 api.BranchDetail（有 body）→ cnbFetch。
 * 响应异常（null / 非对象）时按空对象归一化，界面层不判空。
 */
export async function fetchBranchDetail(repoPath: string, branch: string): Promise<BranchDetail> {
  const raw = await cnbFetch<RawBranchDetail>(
    `/${encodeRepoPath(repoPath)}/-/git/branches/${encodeURIComponent(branch)}`,
  )
  return normalizeBranchDetail(raw)
}

/**
 * 锁定分支（POST /{repo}/-/git/branch-locks/{branch}，scope: repo-code:rw）。
 * **通道选择依据**：201 空 body → cnbFetchVoid。
 */
export async function lockBranch(repoPath: string, branch: string): Promise<void> {
  await cnbFetchVoid(
    `/${encodeRepoPath(repoPath)}/-/git/branch-locks/${encodeURIComponent(branch)}`,
    { method: 'POST' },
  )
}

/**
 * 解锁分支（DELETE /{repo}/-/git/branch-locks/{branch}，scope: repo-code:rw）。
 * **通道选择依据**：204 空 body → cnbFetchVoid。
 */
export async function unlockBranch(repoPath: string, branch: string): Promise<void> {
  await cnbFetchVoid(
    `/${encodeRepoPath(repoPath)}/-/git/branch-locks/${encodeURIComponent(branch)}`,
    { method: 'DELETE' },
  )
}

// ---------------------------------------------------------------------------
// Git 标签 CRUD（REQ-02，3 端点）
// ---------------------------------------------------------------------------

/**
 * 新建标签（POST /{repo}/-/git/tags，scope: repo-release:rw）。
 *
 * **通道选择依据（关键例外）**：swagger 响应 201 api.Tag（**有 body**）——
 * 必须走 cnbFetch 并返回归一化 TagDetail。绝不能因为"是写操作"就套用
 * cnbFetchVoid（那会丢掉返回体，逼组件重拉列表）。
 * 请求体 api.PostTagFrom：name 必填，target/message 可选。
 */
export async function createTag(
  repoPath: string,
  input: { name: string, target?: string, message?: string },
): Promise<TagDetail> {
  const raw = await cnbFetch<RawTag>(`/${encodeRepoPath(repoPath)}/-/git/tags`, {
    method: 'POST',
    body: JSON.stringify({
      name: input.name,
      ...(input.target ? { target: input.target } : {}),
      ...(input.message ? { message: input.message } : {}),
    }),
  })
  return normalizeTag(raw)
}

/**
 * 删除标签（DELETE /{repo}/-/git/tags/{tag}，scope: repo-release:rw）。
 * **通道选择依据**：204 空 body → cnbFetchVoid。
 * 注意：删除 Git 标签 ≠ 删除 Release，组件文案需说清二者互不影响。
 */
export async function deleteTag(repoPath: string, tag: string): Promise<void> {
  await cnbFetchVoid(
    `/${encodeRepoPath(repoPath)}/-/git/tags/${encodeURIComponent(tag)}`,
    { method: 'DELETE' },
  )
}

/**
 * 标签详情（GET /{repo}/-/git/tags/{tag}，scope: repo-release:r）。
 * **通道选择依据**：200 api.Tag（有 body）→ cnbFetch。
 */
export async function fetchTagDetail(repoPath: string, tag: string): Promise<TagDetail> {
  const raw = await cnbFetch<RawTag>(
    `/${encodeRepoPath(repoPath)}/-/git/tags/${encodeURIComponent(tag)}`,
  )
  return normalizeTag(raw)
}
