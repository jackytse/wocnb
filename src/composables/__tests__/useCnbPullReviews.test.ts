/**
 * T11 数据层单测：PR 评审（REQ-10）。
 *
 * 重点：
 * 1. **同一评审域内通道不一致**——`POST /reviews` 是 201 空 body（Void），
 *    而 `POST /replies`、`POST/DELETE /reviewers`、`PUT|POST /labels`、
 *    `DELETE /labels/{name}` 都有 body（JSON）；只有 `DELETE /labels` 集合是 204 空（Void）。
 * 2. **层级构建** `buildReviewThreads`：顶层/回复分层、孤儿回复不丢失（N3 要求单测覆盖）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const cnbFetchMock = vi.fn()
const cnbFetchVoidMock = vi.fn()

vi.mock('../useCnbAuth', () => ({
  cnbFetch: (...args: unknown[]) => cnbFetchMock(...args),
  cnbFetchVoid: (...args: unknown[]) => cnbFetchVoidMock(...args),
  cnbFetchText: (...args: unknown[]) => cnbFetchMock(...args),
  canManageRole: () => false,
  CnbApiError: class extends Error {},
}))

import {
  addPullReviewers,
  buildReviewThreads,
  createPullReview,
  removePullLabelByName,
  removePullLabels,
  replyReviewComment,
  type ReviewComment,
} from '../useCnbPullReviews'

beforeEach(() => {
  cnbFetchMock.mockReset()
  cnbFetchVoidMock.mockReset()
  cnbFetchVoidMock.mockResolvedValue(undefined)
})

/** 构造一条评论的最小字段集（便于层级测试） */
function comment(partial: Partial<ReviewComment> & { id: string }): ReviewComment {
  return {
    id: partial.id,
    reviewId: partial.reviewId || 'r1',
    body: partial.body || '',
    path: partial.path || 'src/a.ts',
    subjectType: partial.subjectType || 'line',
    startLine: partial.startLine || 1,
    endLine: partial.endLine || 1,
    startSide: partial.startSide || 'right',
    endSide: partial.endSide || 'right',
    replyToCommentId: partial.replyToCommentId || '',
    reviewState: partial.reviewState || 'commented',
    author: partial.author || 'alice',
    createdAt: partial.createdAt || '',
  }
}

describe('buildReviewThreads：层级构建（纯函数）', () => {
  it('1 条评审 + 2 顶层 + 3 回复 → 正确分层且保持顺序', () => {
    const threads = buildReviewThreads([
      comment({ id: 'c1' }),
      comment({ id: 'c2' }),
      comment({ id: 'r1', replyToCommentId: 'c1' }),
      comment({ id: 'r2', replyToCommentId: 'c1' }),
      comment({ id: 'r3', replyToCommentId: 'c2' }),
    ])
    expect(threads).toHaveLength(2)
    expect(threads[0].root.id).toBe('c1')
    expect(threads[0].replies.map(item => item.id)).toEqual(['r1', 'r2'])
    expect(threads[1].root.id).toBe('c2')
    expect(threads[1].replies.map(item => item.id)).toEqual(['r3'])
  })

  it('孤儿回复（找不到 root）降级为顶层，不丢失', () => {
    const threads = buildReviewThreads([
      comment({ id: 'c1' }),
      comment({ id: 'orphan', replyToCommentId: 'missing' }),
    ])
    expect(threads).toHaveLength(2)
    expect(threads[1].root.id).toBe('orphan')
  })

  it('回复的回复归到同一 root（只做两层，不做无限缩进）', () => {
    const threads = buildReviewThreads([
      comment({ id: 'c1' }),
      comment({ id: 'r1', replyToCommentId: 'c1' }),
      comment({ id: 'r2', replyToCommentId: 'r1' }),
    ])
    expect(threads).toHaveLength(1)
    expect(threads[0].replies.map(item => item.id)).toEqual(['r1', 'r2'])
  })
})

describe('评审写端点通道', () => {
  it('createPullReview：POST /reviews 是 201 空 body → Void', async () => {
    await createPullReview('org/repo', '12', { event: 'approve', body: 'LGTM' })
    expect(cnbFetchVoidMock).toHaveBeenCalledTimes(1)
    expect(cnbFetchMock).not.toHaveBeenCalled()
    const [path, options] = cnbFetchVoidMock.mock.calls[0]
    expect(path).toBe('/org/repo/-/pulls/12/reviews')
    expect(options.method).toBe('POST')
    expect(JSON.parse(options.body)).toEqual({ event: 'approve', body: 'LGTM' })
  })

  it('createPullReview：request_changes 不带 body 时不发空串', async () => {
    await createPullReview('org/repo', '12', { event: 'request_changes' })
    expect(JSON.parse(cnbFetchVoidMock.mock.calls[0][1].body)).toEqual({
      event: 'request_changes',
    })
  })

  it('replyReviewComment：POST /replies 有 body → cnbFetch', async () => {
    cnbFetchMock.mockResolvedValue({ id: 'new', body: 'ok' })
    const created = await replyReviewComment('org/repo', '12', 'r1', {
      body: 'ok',
      replyToCommentId: 'c1',
    })
    expect(cnbFetchMock).toHaveBeenCalledTimes(1)
    expect(cnbFetchVoidMock).not.toHaveBeenCalled()
    expect(cnbFetchMock.mock.calls[0][0]).toBe(
      '/org/repo/-/pulls/12/reviews/r1/replies',
    )
    expect(JSON.parse(cnbFetchMock.mock.calls[0][1].body)).toEqual({
      body: 'ok',
      reply_to_comment_id: 'c1',
    })
    expect(created.id).toBe('new')
  })

  it('addPullReviewers：POST /reviewers 有 body → cnbFetch', async () => {
    cnbFetchMock.mockResolvedValue({ number: '12', title: 'x', reviewers: [] })
    const pull = await addPullReviewers('org/repo', '12', ['alice'])
    expect(cnbFetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(cnbFetchMock.mock.calls[0][1].body)).toEqual({ reviewers: ['alice'] })
    expect(pull.number).toBe('12')
  })
})

describe('PR 标签：集合删除与按名删除通道相反', () => {
  it('removePullLabels（集合）：DELETE 204 空 body → Void', async () => {
    await removePullLabels('org/repo', '12')
    expect(cnbFetchVoidMock).toHaveBeenCalledTimes(1)
    expect(cnbFetchMock).not.toHaveBeenCalled()
    expect(cnbFetchVoidMock.mock.calls[0][0]).toBe('/org/repo/-/pulls/12/labels')
  })

  it('removePullLabelByName（单个）：200 api.Label → cnbFetch', async () => {
    cnbFetchMock.mockResolvedValue({ name: 'bug', color: 'f00' })
    const label = await removePullLabelByName('org/repo', '12', 'bug')
    expect(cnbFetchMock).toHaveBeenCalledTimes(1)
    expect(cnbFetchVoidMock).not.toHaveBeenCalled()
    expect(cnbFetchMock.mock.calls[0][0]).toBe('/org/repo/-/pulls/12/labels/bug')
    expect(label.name).toBe('bug')
  })
})
