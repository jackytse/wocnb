/**
 * 提交 / 标签元数据（annotations）数据层 —— 批次 2 · REQ-08，共 7 个端点。
 *
 * 端点契约（swagger 逐条核对，路径前缀 https://api.cnb.cool）：
 * ---------------------------------------------------------------------------
 * | 方法   | 端点                                                   | 响应                          | 通道           |
 * | GET    | /{repo}/-/git/tag-annotations/{tag}                    | 200 web.TagAnnotation[]       | cnbFetch      |
 * | PUT    | /{repo}/-/git/tag-annotations/{tag}                    | 200 空 body                    | cnbFetchVoid  |
 * | DELETE | /{repo}/-/git/tag-annotations/{tag_with_key}           | 200 空 body                    | cnbFetchVoid  |
 * | GET    | /{repo}/-/git/commit-annotations/{sha}                 | 200 web.CommitAnnotation[]    | cnbFetch      |
 * | PUT    | /{repo}/-/git/commit-annotations/{sha}                 | 200 空 body                    | cnbFetchVoid  |
 * | DELETE | /{repo}/-/git/commit-annotations/{sha}/{key}           | 200 空 body                    | cnbFetchVoid  |
 * | POST   | /{repo}/-/git/commit-annotations-in-batch              | 200 web.CommitAnnotationInBatch[] | cnbFetch  |
 * ---------------------------------------------------------------------------
 *
 * ⚠️ 本模块最容易踩的坑：两个 DELETE 的**路径段形态不同**
 * - tag 版：`tag_with_key` 是**单段内嵌斜杠**（`标签名/元数据key`），
 *   必须把 `${tag}/${key}` **整体** `encodeURIComponent` → `v1.0%2Fci`；
 * - commit 版：`{sha}/{key}` 是**两个独立路径段**，分别编码后用 `/` 连接。
 * 写反的后果不是报错而是**路由到错误资源**（tag 版分开编码会被当成两段，
 * 网关匹配不到 `tag_with_key` 路由 → 404；commit 版整体编码会被压成一段
 * → 同样 404），因此两处分别有专门的注释与单测锁定。
 *
 * 归一化范式与全库一致：snake_case → camelCase、字符串 `|| ''`、数组恒 `[]`。
 * `meta` 是服务端审计信息（操作者 / 时间 / 平台），**只读展示，不回写** ——
 * PUT 的请求体只发 `{ annotations: [{ key, value }] }`。
 */
import { cnbFetch, cnbFetchVoid } from './useCnbAuth'
import { encodeRepoPath } from './useCnbRepo'

/**
 * 单条元数据（camelCase 镜像）。
 * `key` / `value` 是用户可编辑的业务字段；`meta` 是服务端审计信息。
 */
export interface AnnotationItem {
  /** 元数据键（同一 tag/commit 内唯一，删除时用它定位） */
  key: string
  /** 元数据值（字符串，服务端不做类型约束） */
  value: string
  /** 服务端审计信息（操作者 / 创建时间 / 平台等），只读 */
  meta: Record<string, unknown>
}

/**
 * 批量查询的单提交结果（把 `commit_hash` 归一为 camelCase `commitHash`）。
 * 即使某个 hash 没有元数据也保留条目（`annotations: []`），便于 UI 与
 * 提交列表逐行对齐（否则要自己算差集）。
 */
export interface CommitAnnotationBatch {
  commitHash: string
  annotations: AnnotationItem[]
}

/** web.TagAnnotation / web.CommitAnnotation 原始结构（仅声明用到的字段） */
interface RawAnnotation {
  key?: unknown
  value?: unknown
  /** 审计字段，结构由服务端定义（free-form），原样透传给 UI */
  meta?: unknown
}

/** web.CommitAnnotationInBatch 原始结构（snake_case） */
interface RawCommitAnnotationInBatch {
  commit_hash?: unknown
  annotations?: unknown
}

/**
 * 单条原始元数据 → AnnotationItem。
 *
 * 防御策略：
 * - 非对象条目 → 丢弃（由调用方 filter，见 `normalizeAnnotationList`）；
 * - `key` 缺失的条目对 UI 无价值（既不能展示区分也不能定位删除）→ 归为空串后丢弃；
 * - `value` 允许为空串（"把值清空"是合法编辑结果）；
 * - `meta` 非对象时归一为 `{}`，避免模板里 `meta.xxx` 抛错。
 */
function normalizeAnnotation(raw: unknown): AnnotationItem {
  const source = (raw && typeof raw === 'object' ? raw : {}) as RawAnnotation
  return {
    key: typeof source.key === 'string' ? source.key : '',
    value: typeof source.value === 'string' ? source.value : '',
    meta: (source.meta && typeof source.meta === 'object' && !Array.isArray(source.meta))
      ? source.meta as Record<string, unknown>
      : {},
  }
}

/** 数组响应归一化；非数组一律 `[]`，并丢弃无 key 的无效条目 */
function normalizeAnnotationList(raw: unknown): AnnotationItem[] {
  if (!Array.isArray(raw)) {
    return []
  }
  return raw.map(normalizeAnnotation).filter(item => item.key !== '')
}

/**
 * 构造 PUT 的请求体。
 *
 * 只发 `{ annotations: [{ key, value }] }`：
 * - 不发 `meta`（服务端只读审计字段，回传可能被拒或覆盖审计信息）；
 * - 不发空 key 条目（服务端会 422，属于无效输入）。
 */
function buildAnnotationsBody(items: AnnotationItem[]): string {
  return JSON.stringify({
    annotations: items
      .filter(item => item.key !== '')
      .map(item => ({ key: item.key, value: item.value })),
  })
}

// ---------------------------------------------------------------------------
// 标签元数据（tag annotations）
// ---------------------------------------------------------------------------

/** 标签元数据列表（GET /git/tag-annotations/{tag}，scope `repo-release:r`） */
export async function listTagAnnotations(
  repoPath: string,
  tag: string,
): Promise<AnnotationItem[]> {
  const raw = await cnbFetch<unknown>(
    `/${encodeRepoPath(repoPath)}/-/git/tag-annotations/${encodeURIComponent(tag)}`,
  )
  return normalizeAnnotationList(raw)
}

/**
 * 覆盖写入标签元数据（PUT /git/tag-annotations/{tag}，scope `repo-release:rw`）
 * → 200 空 body，走 `cnbFetchVoid`。
 *
 * 语义是**整体覆盖**（服务端以本次提交的 annotations 为准），不是增量追加；
 * UI 编辑单条时要把"完整列表（改后）"传进来。
 */
export async function putTagAnnotations(
  repoPath: string,
  tag: string,
  items: AnnotationItem[],
): Promise<void> {
  await cnbFetchVoid(
    `/${encodeRepoPath(repoPath)}/-/git/tag-annotations/${encodeURIComponent(tag)}`,
    { method: 'PUT', body: buildAnnotationsBody(items) },
  )
}

/**
 * 删除单条标签元数据（DELETE /git/tag-annotations/{tag_with_key}，
 * scope `repo-release:rw`）→ 200 空 body。
 *
 * ⚠️ 编码特例（本模块最关键的一行）：`tag_with_key` 是
 * `标签名/元数据key` **单段内嵌斜杠**，必须把 `${tag}/${key}` **整体**
 * `encodeURIComponent`（→ `v1.0%2Fci`）。若先编码再拼 `/`（变成两段），
 * 网关会把它当成 `/{tag}/{key}` 两段路由 → 404。
 */
export async function deleteTagAnnotation(
  repoPath: string,
  tag: string,
  key: string,
): Promise<void> {
  // 整体编码：`${tag}/${key}` 是一整个路径段，斜杠要变成 %2F
  const tagWithKey = encodeURIComponent(`${tag}/${key}`)
  await cnbFetchVoid(
    `/${encodeRepoPath(repoPath)}/-/git/tag-annotations/${tagWithKey}`,
    { method: 'DELETE' },
  )
}

// ---------------------------------------------------------------------------
// 提交元数据（commit annotations）
// ---------------------------------------------------------------------------

/** 提交元数据列表（GET /git/commit-annotations/{sha}，scope `repo-code:r`） */
export async function listCommitAnnotations(
  repoPath: string,
  sha: string,
): Promise<AnnotationItem[]> {
  const raw = await cnbFetch<unknown>(
    `/${encodeRepoPath(repoPath)}/-/git/commit-annotations/${encodeURIComponent(sha)}`,
  )
  return normalizeAnnotationList(raw)
}

/**
 * 覆盖写入提交元数据（PUT /git/commit-annotations/{sha}，scope `repo-code:rw`）
 * → 200 空 body。同为**整体覆盖**语义。
 */
export async function putCommitAnnotations(
  repoPath: string,
  sha: string,
  items: AnnotationItem[],
): Promise<void> {
  await cnbFetchVoid(
    `/${encodeRepoPath(repoPath)}/-/git/commit-annotations/${encodeURIComponent(sha)}`,
    { method: 'PUT', body: buildAnnotationsBody(items) },
  )
}

/**
 * 删除单条提交元数据（DELETE /git/commit-annotations/{sha}/{key}，
 * scope `repo-code:rw`）→ 200 空 body。
 *
 * ⚠️ 与标签版相反：这里是**两个独立路径段**，分别 `encodeURIComponent`
 * 再用 `/` 连接。整体编码会把 `/` 压成 `%2F`，两个段被并成一段 → 404。
 */
export async function deleteCommitAnnotation(
  repoPath: string,
  sha: string,
  key: string,
): Promise<void> {
  // 两个独立段：sha 与 key 各自编码，`/` 作为真实路径分隔符保留
  await cnbFetchVoid(
    `/${encodeRepoPath(repoPath)}/-/git/commit-annotations/${encodeURIComponent(sha)}/${encodeURIComponent(key)}`,
    { method: 'DELETE' },
  )
}

/**
 * 批量查询提交元数据（POST /git/commit-annotations-in-batch，scope `repo-code:r`）
 * → 200 `web.CommitAnnotationInBatch[]`。
 *
 * 为什么需要它：提交列表若逐行调 GET 元数据会形成 N+1（R8/R9 明确禁止）。
 * 一次传全部可见 hash，服务端返回逐 hash 的分组结果。
 *
 * @param hashes 要查询的提交 hash 列表（空列表直接返回 `[]`，不发无意义请求）
 * @param keys   可选：只查指定键（缺省查全部）
 *
 * 归一化：`commit_hash` → `commitHash`；响应里缺失的 hash **补空条目**
 * （`annotations: []`），保证调用方拿到的条目数与入参一一对应。
 */
export async function listCommitAnnotationsBatch(
  repoPath: string,
  hashes: string[],
  keys: string[] = [],
): Promise<CommitAnnotationBatch[]> {
  if (hashes.length === 0) {
    return []
  }
  const body: Record<string, unknown> = { commit_hashes: hashes }
  // keys 非空才发：服务端对空数组的语义可能是"查不到任何键"，与"查全部"不同
  if (keys.length > 0) {
    body.keys = keys
  }
  const raw = await cnbFetch<unknown>(
    `/${encodeRepoPath(repoPath)}/-/git/commit-annotations-in-batch`,
    { method: 'POST', body: JSON.stringify(body) },
  )
  if (!Array.isArray(raw)) {
    return hashes.map(commitHash => ({ commitHash, annotations: [] }))
  }

  // 先按 hash 聚合服务端结果（同一 hash 若返回多组则合并）
  const grouped = new Map<string, AnnotationItem[]>()
  for (const item of raw) {
    const entry = (item && typeof item === 'object' ? item : {}) as RawCommitAnnotationInBatch
    const commitHash = typeof entry.commit_hash === 'string' ? entry.commit_hash : ''
    if (!commitHash) {
      continue
    }
    const list = normalizeAnnotationList(entry.annotations)
    const existing = grouped.get(commitHash) || []
    grouped.set(commitHash, existing.concat(list))
  }

  // 按入参顺序输出，缺失的补空条目（UI 可与提交行逐一对齐）
  return hashes.map(commitHash => ({
    commitHash,
    annotations: grouped.get(commitHash) || [],
  }))
}
