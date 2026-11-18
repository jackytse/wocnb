/**
 * PR 评审数据层 —— 批次 2 · REQ-10，共 13 个端点。
 *
 * 覆盖能力（swagger 逐条核对）：
 * - 评审列表 / 创建 / 更新（GET / POST / PATCH）
 * - 行级评论列表 / 更新 / 回复
 * - 评审人增删
 * - PR 标签列表 / 覆盖 / 追加 / 清空 / 按名删除
 *
 * ⚠️ 通道选择（本模块含 4 个空 body 写端点，逐条对照设计 §8.2）：
 * | 端点                                 | 响应                    | 通道          |
 * | POST /pulls/{n}/reviews              | **201 空 body**         | cnbFetchVoid  |
 * | PATCH /pulls/{n}/reviews/{rid}       | 200 api.PullReview      | cnbFetch      |
 * | PATCH …/reviews/{rid}/comments/{cid} | 200 api.PullReviewComment | cnbFetch    |
 * | POST …/reviews/{rid}/replies         | 201 api.PullReviewComment | cnbFetch    |
 * | POST /pulls/{n}/reviewers            | 201 api.Pull            | cnbFetch      |
 * | DELETE /pulls/{n}/reviewers          | 200 api.Pull            | cnbFetch      |
 * | PUT/POST /pulls/{n}/labels           | 200 api.Label           | cnbFetch      |
 * | **DELETE /pulls/{n}/labels**         | **204 空 body**         | cnbFetchVoid  |
 * | DELETE /pulls/{n}/labels/{name}      | 200 api.Label           | cnbFetch      |
 * 同一评审域内通道不一致，**不可按「写操作一律 Void」推断**（踩坑#3）。
 *
 * 评审状态 state 枚举（swagger）：`approved` / `changes_requested` / `commented` /
 * `pending` —— 与 `RepoPullDetail.vue` 既有的 `reviewColor()` 一致，UI 直接复用，
 * 本层不做颜色映射（展示逻辑归组件）。
 *
 * 行级评论的 `subject_type` 为 `line` 时才有 start/end line/side；
 * `file` 时忽略行号（swagger 明确）—— 归一化保留原值，由渲染层分支。
 */
import { cnbFetch, cnbFetchVoid } from './useCnbAuth'
import { encodeRepoPath, normalizePull, type RepoLabel, type RepoPull } from './useCnbRepo'

/**
 * 评审动作（api.PullReviewCreationForm.event）。
 * - approve：批准
 * - request_changes：请求修改
 * - comment：仅评论
 * - pending：暂挂（不改变评审结论）
 */
export type ReviewEvent = 'approve' | 'request_changes' | 'comment' | 'pending'

/** 一条评审（api.PullReview 的 camelCase 镜像） */
export interface PullReview {
  id: string
  /** 评审结论：approved / changes_requested / commented / pending */
  state: string
  /** 评审正文（Markdown） */
  body: string
  author: string
  createdAt: string
  updatedAt: string
}

/** 一条行级评论 / 回复（api.PullReviewComment 的 camelCase 镜像） */
export interface ReviewComment {
  id: string
  reviewId: string
  body: string
  /** 文件路径（行级评论所属文件） */
  path: string
  /** 'line' 才有行号语义；'file' 为文件级评论 */
  subjectType: 'line' | 'file'
  startLine: number
  endLine: number
  /** 行所属侧：left=删除侧，right=新增侧 */
  startSide: 'left' | 'right'
  endSide: 'left' | 'right'
  /** 回复目标评论 id；空串表示顶层评论 */
  replyToCommentId: string
  /** 所属评审的结论状态（用于徽标） */
  reviewState: string
  author: string
  createdAt: string
}

/** 评审线程：一条顶层评论 + 它下面被收敛的回复 */
export interface ReviewThread {
  root: ReviewComment
  replies: ReviewComment[]
}

/** api.PullReview 原始结构（snake_case，仅声明用到的字段） */
interface RawPullReview {
  id?: unknown
  state?: unknown
  body?: unknown
  author?: { nickname?: unknown, username?: unknown } | unknown
  created_at?: unknown
  updated_at?: unknown
}

/** api.PullReviewComment 原始结构（snake_case） */
interface RawReviewComment {
  id?: unknown
  review_id?: unknown
  body?: unknown
  path?: unknown
  subject_type?: unknown
  start_line?: unknown
  end_line?: unknown
  start_side?: unknown
  end_side?: unknown
  reply_to_comment_id?: unknown
  review_state?: unknown
  author?: { nickname?: unknown, username?: unknown } | unknown
  created_at?: unknown
}

/** 从 author 字段提取展示名（字符串作者 / {nickname|username} 对象双兼容） */
function authorName(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  if (value && typeof value === 'object') {
    const obj = value as { nickname?: unknown, username?: unknown }
    if (typeof obj.nickname === 'string') {
      return obj.nickname
    }
    if (typeof obj.username === 'string') {
      return obj.username
    }
  }
  return ''
}

/** 字符串字段兜底 */
function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 数字字段兜底（非法 → 0；行号 0 表示"无行号"） */
function num(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** 归一化单条评审；无 id 的条目由调用方丢弃 */
function normalizeReview(raw: unknown): PullReview {
  const source = (raw && typeof raw === 'object' ? raw : {}) as RawPullReview
  return {
    id: str(source.id),
    state: str(source.state) || 'pending',
    body: str(source.body),
    author: authorName(source.author),
    createdAt: str(source.created_at),
    updatedAt: str(source.updated_at),
  }
}

/** 归一化单条行级评论 */
function normalizeReviewComment(raw: unknown): ReviewComment {
  const source = (raw && typeof raw === 'object' ? raw : {}) as RawReviewComment
  const side = (value: unknown): 'left' | 'right' => (value === 'left' ? 'left' : 'right')
  return {
    id: str(source.id),
    reviewId: str(source.review_id),
    body: str(source.body),
    path: str(source.path),
    subjectType: source.subject_type === 'file' ? 'file' : 'line',
    startLine: num(source.start_line),
    endLine: num(source.end_line),
    startSide: side(source.start_side),
    endSide: side(source.end_side),
    replyToCommentId: str(source.reply_to_comment_id),
    reviewState: str(source.review_state),
    author: authorName(source.author),
    createdAt: str(source.created_at),
  }
}

// ---------------------------------------------------------------------------
// 评审线程构建（纯函数，可单测 —— N3 要求"层级渲染单测覆盖"）
// ---------------------------------------------------------------------------

/**
 * 把扁平的评论列表构建成「顶层评论 + 回复」两层结构。
 *
 * 规则：
 * 1. `replyToCommentId` 为空的条目是顶层（root）；
 * 2. 非空的是回复，挂到对应 root 下（**只做两层**：回复的回复也归到同一 root，
 *    服务端 UI 就是两层展示，不做无限缩进）；
 * 3. **回复的回复**（父评论本身也是回复）需要沿引用链回溯到 root，否则会被
 *    误判为孤儿；回溯深度限制 10 层防环状脏数据死循环；
 * 4. 找不到 root 的孤儿回复（root 被删除/分页截断）**不丢弃**，降级为顶层条目，
 *    否则用户会"评论凭空消失"；
 * 5. 保持服务端返回顺序（同一 root 下的回复按出现顺序），便于时间线阅读。
 */
export function buildReviewThreads(comments: ReviewComment[]): ReviewThread[] {
  const threads: ReviewThread[] = []
  // id → thread 的索引，用于 O(1) 挂回复
  const byRootId = new Map<string, ReviewThread>()
  // id → 评论本身，用于沿 replyToCommentId 链回溯到 root
  const byId = new Map<string, ReviewComment>()

  // 第一遍：收集顶层评论（保持原顺序）
  for (const comment of comments) {
    if (comment.id) {
      byId.set(comment.id, comment)
    }
    if (comment.replyToCommentId === '') {
      const thread: ReviewThread = { root: comment, replies: [] }
      threads.push(thread)
      if (comment.id) {
        byRootId.set(comment.id, thread)
      }
    }
  }

  /**
   * 沿引用链回溯找 root：最多 10 层（防御环状数据）。
   * 返回 null 表示链断裂（找不到顶层祖先）。
   */
  function resolveRootId(startId: string): string | null {
    let currentId = startId
    for (let depth = 0; depth < 10; depth += 1) {
      const current = byId.get(currentId)
      if (!current) {
        return null
      }
      if (current.replyToCommentId === '') {
        return current.id
      }
      currentId = current.replyToCommentId
    }
    return null
  }

  // 第二遍：挂回复；孤儿回复降级为顶层（不丢失）
  for (const comment of comments) {
    if (comment.replyToCommentId === '') {
      continue
    }
    const rootId = resolveRootId(comment.replyToCommentId)
    const thread = rootId ? byRootId.get(rootId) : undefined
    if (thread) {
      thread.replies.push(comment)
    }
    else {
      const promoted: ReviewThread = { root: comment, replies: [] }
      threads.push(promoted)
      if (comment.id) {
        byRootId.set(comment.id, promoted)
      }
    }
  }

  return threads
}

// ---------------------------------------------------------------------------
// 读操作
// ---------------------------------------------------------------------------

/** 评审列表（GET /pulls/{n}/reviews，scope `repo-notes:r` / `repo-pr:r`） */
export async function listPullReviews(
  repoPath: string,
  number: string,
): Promise<PullReview[]> {
  const raw = await cnbFetch<unknown>(
    `/${encodeRepoPath(repoPath)}/-/pulls/${encodeURIComponent(number)}/reviews`,
  )
  if (!Array.isArray(raw)) {
    return []
  }
  return raw.map(normalizeReview).filter(item => item.id !== '')
}

/**
 * 行级评论列表（GET /pulls/{n}/reviews/{rid}/comments，scope `repo-notes:r`）。
 * 返回的是该评审下**全部**评论（顶层 + 回复），用 buildReviewThreads 分层。
 */
export async function listReviewComments(
  repoPath: string,
  number: string,
  reviewId: string,
): Promise<ReviewComment[]> {
  const raw = await cnbFetch<unknown>(
    `/${encodeRepoPath(repoPath)}/-/pulls/${encodeURIComponent(number)}/reviews/${encodeURIComponent(reviewId)}/comments`,
  )
  if (!Array.isArray(raw)) {
    return []
  }
  return raw.map(normalizeReviewComment).filter(item => item.id !== '')
}

/** PR 标签列表（GET /pulls/{n}/labels，scope `repo-pr:r`） */
export async function listPullLabels(
  repoPath: string,
  number: string,
): Promise<RepoLabel[]> {
  const raw = await cnbFetch<unknown>(
    `/${encodeRepoPath(repoPath)}/-/pulls/${encodeURIComponent(number)}/labels`,
  )
  if (!Array.isArray(raw)) {
    return []
  }
  return raw
    .map((item) => {
      const label = (item && typeof item === 'object' ? item : {}) as { name?: unknown, color?: unknown }
      return { name: str(label.name), color: str(label.color) }
    })
    .filter(item => item.name !== '')
}

// ---------------------------------------------------------------------------
// 写操作 —— 逐条按响应形态选通道
// ---------------------------------------------------------------------------

/** 创建评审的入参（对应 api.PullReviewCreationForm） */
export interface CreateReviewInput {
  /** 评审正文（可选；仅"评论"动作时可只给正文） */
  body?: string
  /** 评审动作 */
  event: ReviewEvent
  /** 可选：随评审一起提交的行级评论（本 UI 暂不构造，保留扩展位） */
  comments?: Record<string, unknown>[]
}

/**
 * 提交评审（POST /pulls/{n}/reviews，scope `repo-notes:rw`）
 * → **201 空 body**，必须 `cnbFetchVoid`。
 *
 * 成功后 UI 需重拉 `listPullReviews`（服务端不返回新评审实体，
 * 无法本地插入 —— 见设计 §8.4 写后一致性）。
 */
export async function createPullReview(
  repoPath: string,
  number: string,
  input: CreateReviewInput,
): Promise<void> {
  const body: Record<string, unknown> = { event: input.event }
  // body 只在提供时发送：空串会被服务端当成"清空评审正文"，语义不同
  if (input.body !== undefined && input.body !== '') {
    body.body = input.body
  }
  if (input.comments && input.comments.length > 0) {
    body.comments = input.comments
  }
  await cnbFetchVoid(
    `/${encodeRepoPath(repoPath)}/-/pulls/${encodeURIComponent(number)}/reviews`,
    { method: 'POST', body: JSON.stringify(body) },
  )
}

/** 更新评审正文（PATCH /pulls/{n}/reviews/{rid}）→ 200 api.PullReview（有 body） */
export async function updatePullReview(
  repoPath: string,
  number: string,
  reviewId: string,
  body: string,
): Promise<PullReview> {
  const raw = await cnbFetch<unknown>(
    `/${encodeRepoPath(repoPath)}/-/pulls/${encodeURIComponent(number)}/reviews/${encodeURIComponent(reviewId)}`,
    { method: 'PATCH', body: JSON.stringify({ body }) },
  )
  return normalizeReview(raw)
}

/** 更新单条行级评论（PATCH …/comments/{cid}）→ 200 api.PullReviewComment（有 body） */
export async function updateReviewComment(
  repoPath: string,
  number: string,
  reviewId: string,
  commentId: string,
  body: string,
): Promise<ReviewComment> {
  const raw = await cnbFetch<unknown>(
    `/${encodeRepoPath(repoPath)}/-/pulls/${encodeURIComponent(number)}/reviews/${encodeURIComponent(reviewId)}/comments/${encodeURIComponent(commentId)}`,
    { method: 'PATCH', body: JSON.stringify({ body }) },
  )
  return normalizeReviewComment(raw)
}

/**
 * 回复评审评论（POST …/reviews/{rid}/replies，scope `repo-notes:rw`）
 * → **201 api.PullReviewComment（有 body）**，走 `cnbFetch`。
 *
 * 注意与 createPullReview 的通道相反：同为 POST，但一个空 body 一个带实体。
 */
export async function replyReviewComment(
  repoPath: string,
  number: string,
  reviewId: string,
  input: { body: string, replyToCommentId: string },
): Promise<ReviewComment> {
  const raw = await cnbFetch<unknown>(
    `/${encodeRepoPath(repoPath)}/-/pulls/${encodeURIComponent(number)}/reviews/${encodeURIComponent(reviewId)}/replies`,
    {
      method: 'POST',
      body: JSON.stringify({
        body: input.body,
        reply_to_comment_id: input.replyToCommentId,
      }),
    },
  )
  return normalizeReviewComment(raw)
}

/** 添加 PR 评审人（POST /pulls/{n}/reviewers，scope `repo-pr:rw`）→ 201 api.Pull */
export async function addPullReviewers(
  repoPath: string,
  number: string,
  reviewers: string[],
): Promise<RepoPull> {
  const raw = await cnbFetch<unknown>(
    `/${encodeRepoPath(repoPath)}/-/pulls/${encodeURIComponent(number)}/reviewers`,
    { method: 'POST', body: JSON.stringify({ reviewers }) },
  )
  return normalizePull((raw || {}) as Record<string, never>)
}

/** 移除 PR 评审人（DELETE /pulls/{n}/reviewers，scope `repo-pr:rw`）→ 200 api.Pull */
export async function removePullReviewers(
  repoPath: string,
  number: string,
  reviewers: string[],
): Promise<RepoPull> {
  const raw = await cnbFetch<unknown>(
    `/${encodeRepoPath(repoPath)}/-/pulls/${encodeURIComponent(number)}/reviewers`,
    { method: 'DELETE', body: JSON.stringify({ reviewers }) },
  )
  return normalizePull((raw || {}) as Record<string, never>)
}

/** 覆盖设置 PR 标签（PUT /pulls/{n}/labels）→ 200 api.Label */
export async function setPullLabels(
  repoPath: string,
  number: string,
  labels: string[],
): Promise<RepoLabel> {
  const raw = await cnbFetch<unknown>(
    `/${encodeRepoPath(repoPath)}/-/pulls/${encodeURIComponent(number)}/labels`,
    { method: 'PUT', body: JSON.stringify({ labels }) },
  )
  const label = (raw && typeof raw === 'object' ? raw : {}) as { name?: unknown, color?: unknown }
  return { name: str(label.name), color: str(label.color) }
}

/** 追加 PR 标签（POST /pulls/{n}/labels）→ 200 api.Label */
export async function addPullLabels(
  repoPath: string,
  number: string,
  labels: string[],
): Promise<RepoLabel> {
  const raw = await cnbFetch<unknown>(
    `/${encodeRepoPath(repoPath)}/-/pulls/${encodeURIComponent(number)}/labels`,
    { method: 'POST', body: JSON.stringify({ labels }) },
  )
  const label = (raw && typeof raw === 'object' ? raw : {}) as { name?: unknown, color?: unknown }
  return { name: str(label.name), color: str(label.color) }
}

/**
 * 清空 PR 全部标签（DELETE /pulls/{n}/labels，scope `repo-pr:rw`）
 * → **204 空 body**，走 `cnbFetchVoid`。
 *
 * 注意与「按名删除单个标签」的通道相反（后者 200 带 api.Label）。
 */
export async function removePullLabels(repoPath: string, number: string): Promise<void> {
  await cnbFetchVoid(
    `/${encodeRepoPath(repoPath)}/-/pulls/${encodeURIComponent(number)}/labels`,
    { method: 'DELETE' },
  )
}

/** 按名删除单个 PR 标签（DELETE /pulls/{n}/labels/{name}）→ 200 api.Label */
export async function removePullLabelByName(
  repoPath: string,
  number: string,
  name: string,
): Promise<RepoLabel> {
  const raw = await cnbFetch<unknown>(
    `/${encodeRepoPath(repoPath)}/-/pulls/${encodeURIComponent(number)}/labels/${encodeURIComponent(name)}`,
    { method: 'DELETE' },
  )
  const label = (raw && typeof raw === 'object' ? raw : {}) as { name?: unknown, color?: unknown }
  return { name: str(label.name), color: str(label.color) }
}

/**
 * 标签差分计算（纯函数，导出供单测断言）。
 *
 * 为什么独立成纯函数：PR 标签保存走 PUT 整体覆盖（api.PutPullLabelsForm.labels
 * 是"最终列表"而非增量），UI 只需要知道"有没有变化"来决定是否发请求；
 * 把差分逻辑从组件里抽出来，才能在数据层单元测试里锁定边界行为
 * （重名去重、空串剔除、顺序无关）。
 *
 * 语义：
 * - `added`：selected 有而 original 没有的名字（保留 selected 中的首次出现顺序）；
 * - `removed`：original 有而 selected 没有的名字（保留 original 中的首次出现顺序）；
 * - 两边入参都会先做去空串 + 去重归一，避免 UI 层重复处理。
 */
export function diffLabelSelection(
  original: string[],
  selected: string[],
): { added: string[], removed: string[] } {
  // 归一：剔除空白名字并去重（Set 保序），差分只对"有效名字"进行
  const normalize = (list: string[]): string[] => [...new Set(list.map(name => name.trim()).filter(Boolean))]
  const from = normalize(original)
  const to = normalize(selected)
  const fromSet = new Set(from)
  const toSet = new Set(to)
  return {
    added: to.filter(name => !fromSet.has(name)),
    removed: from.filter(name => !toSet.has(name)),
  }
}
