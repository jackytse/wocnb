/**
 * T02 数据层单测：Issue / PR 关联写端点（REQ-04 / REQ-05）。
 *
 * 核心防线：**逐端点通道断言**（风险 N2 / 踩坑#3）——相邻端点形态不同：
 * - assignees 写三端点（POST/PATCH/DELETE）全部返回 IssueDetail → cnbFetch；
 * - labels 的 DELETE 集合是 204 空 body → cnbFetchVoid，而 DELETE 单个是
 *   200 有 body → cnbFetch；**两者相邻，最易写反**；
 * - createPull（201 api.Pull）、pull assignees 写、commit-statuses → cnbFetch；
 * - canAssign 探测端点（204/404）→ cnbFetchVoid + 404 归一 false。
 * 另锁定：复用现有 RepoUser/RepoPull（code review 检查由 typecheck 间接保证）、
 * PR CI 六态独立映射未知中性色。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const cnbFetchMock = vi.fn()
const cnbFetchVoidMock = vi.fn()

vi.mock('../useCnbAuth', () => ({
  cnbFetch: (...args: unknown[]) => cnbFetchMock(...args),
  cnbFetchVoid: (...args: unknown[]) => cnbFetchVoidMock(...args),
  cnbFetchText: (...args: unknown[]) => cnbFetchMock(...args),
  canManageRole: () => false,
  CnbApiError: class CnbApiError extends Error {
    status?: number
    kind?: string
    constructor(message: string, status?: number, kind?: string) {
      super(message)
      this.status = status
      this.kind = kind
    }
  },
}))

import {
  addIssueLabels,
  canAssignIssue,
  canAssignPull,
  commitStatusMeta,
  createPull,
  fetchPullCommitStatuses,
  listIssueAssignees,
  listIssueLabels,
  listPullAssignees,
  removeIssueAssignees,
  removeIssueLabel,
  removeIssueLabels,
  removePullAssignees,
  setIssueAssignees,
  setIssueLabels,
  setPullAssignees,
  updateIssueAssignees,
  updatePull,
} from '../useCnbRepo'

/** 构造一个 404 形态的错误（CnbApiError 鸭式兼容，探测函数据此归一 false） */
function notFoundError(): Error {
  return Object.assign(new Error('not found'), { kind: 'notFound', status: 404 })
}
/** 构造一个 500 形态的错误（不应被吞掉） */
function serverError(): Error {
  return Object.assign(new Error('server error'), { kind: 'network', status: 500 })
}

beforeEach(() => {
  cnbFetchMock.mockReset()
  cnbFetchVoidMock.mockReset()
  cnbFetchVoidMock.mockResolvedValue(undefined)
  // 有 body 的写端点默认返回可用实体，避免归一化读 undefined 报错
  cnbFetchMock.mockResolvedValue({ number: '1', name: 'bug', color: 'ff0000' })
})

describe('Issue assignees：三个写端点全部 cnbFetch', () => {
  it('listIssueAssignees：GET 有 body → cnbFetch，字段归一化 + 空过滤', async () => {
    cnbFetchMock.mockResolvedValueOnce([
      { username: 'alice', nickname: 'Alice', avatar: 'a.png' },
      { nickname: '无名' }, // 无 username → 过滤
    ])
    const users = await listIssueAssignees('org/repo', '42')
    expect(cnbFetchMock).toHaveBeenCalledTimes(1)
    expect(cnbFetchMock.mock.calls[0][0]).toBe('/org/repo/-/issues/42/assignees')
    expect(users).toEqual([{ username: 'alice', nickname: 'Alice', avatar: 'a.png' }])
  })

  it('POST/PATCH/DELETE assignees 三端点都走 cnbFetch（不是 Void）', async () => {
    await setIssueAssignees('org/repo', '42', ['alice'])
    await updateIssueAssignees('org/repo', '42', ['alice', 'bob'])
    await removeIssueAssignees('org/repo', '42', ['bob'])
    expect(cnbFetchMock).toHaveBeenCalledTimes(3)
    expect(cnbFetchVoidMock).not.toHaveBeenCalled()
    expect(cnbFetchMock.mock.calls[0][1].method).toBe('POST')
    expect(cnbFetchMock.mock.calls[1][1].method).toBe('PATCH')
    expect(cnbFetchMock.mock.calls[2][1].method).toBe('DELETE')
    expect(JSON.parse(cnbFetchMock.mock.calls[0][1].body)).toEqual({ assignees: ['alice'] })
  })

  it('canAssignIssue：GET 探测走 cnbFetchVoid，204→true / 404→false / 500→抛出', async () => {
    cnbFetchVoidMock.mockResolvedValueOnce(undefined)
    expect(await canAssignIssue('org/repo', '42', 'alice')).toBe(true)
    expect(cnbFetchVoidMock.mock.calls[0][0]).toBe('/org/repo/-/issues/42/assignees/alice')
    expect(cnbFetchMock).not.toHaveBeenCalled()

    cnbFetchVoidMock.mockRejectedValueOnce(notFoundError())
    expect(await canAssignIssue('org/repo', '42', 'nobody')).toBe(false)

    cnbFetchVoidMock.mockRejectedValueOnce(serverError())
    await expect(canAssignIssue('org/repo', '42', 'x')).rejects.toThrow('server error')
  })
})

describe('Issue labels：集合 DELETE 走 Void，单个 DELETE 走 JSON', () => {
  it('listIssueLabels：GET 有 body → cnbFetch，非数组降级 []', async () => {
    cnbFetchMock.mockResolvedValueOnce([{ name: 'bug', color: 'f00' }, {}])
    expect(await listIssueLabels('org/repo', '42')).toEqual([{ name: 'bug', color: 'f00' }])
    cnbFetchMock.mockResolvedValueOnce(null)
    expect(await listIssueLabels('org/repo', '42')).toEqual([])
  })

  it('POST / PUT labels 走 cnbFetch', async () => {
    await addIssueLabels('org/repo', '42', ['bug'])
    await setIssueLabels('org/repo', '42', ['bug', 'enhancement'])
    expect(cnbFetchMock).toHaveBeenCalledTimes(2)
    expect(cnbFetchVoidMock).not.toHaveBeenCalled()
    expect(cnbFetchMock.mock.calls[0][1].method).toBe('POST')
    expect(cnbFetchMock.mock.calls[1][1].method).toBe('PUT')
    expect(JSON.parse(cnbFetchMock.mock.calls[1][1].body)).toEqual({ labels: ['bug', 'enhancement'] })
  })

  it('DELETE /labels（集合）：204 空 body → cnbFetchVoid，仍发送 body', async () => {
    await removeIssueLabels('org/repo', '42', ['bug'])
    expect(cnbFetchVoidMock).toHaveBeenCalledTimes(1)
    expect(cnbFetchMock).not.toHaveBeenCalled()
    const [path, options] = cnbFetchVoidMock.mock.calls[0]
    expect(path).toBe('/org/repo/-/issues/42/labels')
    expect(options.method).toBe('DELETE')
    expect(JSON.parse(options.body)).toEqual({ labels: ['bug'] })
  })

  it('DELETE /labels/{name}（单个）：200 有 body → cnbFetch，中文名编码', async () => {
    cnbFetchMock.mockResolvedValueOnce({ name: '待评审', color: '0f0' })
    const label = await removeIssueLabel('org/repo', '42', '待评审')
    expect(cnbFetchMock).toHaveBeenCalledTimes(1)
    expect(cnbFetchVoidMock).not.toHaveBeenCalled()
    expect(cnbFetchMock.mock.calls[0][0]).toBe('/org/repo/-/issues/42/labels/%E5%BE%85%E8%AF%84%E5%AE%A1')
    expect(cnbFetchMock.mock.calls[0][1].method).toBe('DELETE')
    expect(label).toEqual({ name: '待评审', color: '0f0' })
  })
})

describe('PR create / update / assignees / CI：通道与复用', () => {
  it('createPull：POST /pulls 走 cnbFetch，head_repo 转 snake_case，复用 RepoPull 归一化', async () => {
    cnbFetchMock.mockResolvedValueOnce({
      number: '7', title: 'feat', state: 'open',
      base: { ref: 'refs/heads/main', repo: { path: 'org/repo' } },
      head: { ref: 'refs/heads/feature/x', repo: { path: 'org/repo' } },
    })
    const pull = await createPull('org/repo', {
      title: 'feat', head: 'feature/x', base: 'main', body: 'desc', headRepo: 'fork/repo',
    })
    expect(cnbFetchMock).toHaveBeenCalledTimes(1)
    expect(cnbFetchVoidMock).not.toHaveBeenCalled()
    const [path, options] = cnbFetchMock.mock.calls[0]
    expect(path).toBe('/org/repo/-/pulls')
    expect(options.method).toBe('POST')
    expect(JSON.parse(options.body)).toEqual({
      title: 'feat', head: 'feature/x', base: 'main', body: 'desc', head_repo: 'fork/repo',
    })
    expect(pull.number).toBe('7')
    expect(pull.baseRef).toBe('main') // stripRefsHeads 复用
    expect(pull.headRef).toBe('feature/x')
  })

  it('updatePull：PATCH 走 cnbFetch，只提交显式字段', async () => {
    cnbFetchMock.mockResolvedValueOnce({ number: '7', title: 'new title' })
    await updatePull('org/repo', '7', { title: 'new title' })
    expect(cnbFetchMock).toHaveBeenCalledTimes(1)
    expect(cnbFetchMock.mock.calls[0][1].method).toBe('PATCH')
    expect(JSON.parse(cnbFetchMock.mock.calls[0][1].body)).toEqual({ title: 'new title' })
  })

  it('listPullAssignees：GET 有 body → cnbFetch', async () => {
    cnbFetchMock.mockResolvedValueOnce([{ username: 'bob', nickname: 'Bob' }])
    expect(await listPullAssignees('org/repo', '7')).toEqual([{ username: 'bob', nickname: 'Bob', avatar: '' }])
    expect(cnbFetchMock.mock.calls[0][0]).toBe('/org/repo/-/pulls/7/assignees')
  })

  it('POST / DELETE pull assignees 都走 cnbFetch', async () => {
    cnbFetchMock.mockResolvedValue({ number: '7', title: 'p' })
    await setPullAssignees('org/repo', '7', ['bob'])
    await removePullAssignees('org/repo', '7', ['bob'])
    expect(cnbFetchMock).toHaveBeenCalledTimes(2)
    expect(cnbFetchVoidMock).not.toHaveBeenCalled()
    expect(cnbFetchMock.mock.calls[0][1].method).toBe('POST')
    expect(cnbFetchMock.mock.calls[1][1].method).toBe('DELETE')
  })

  it('canAssignPull：204→true / 404→false / 500→抛出，走 cnbFetchVoid', async () => {
    cnbFetchVoidMock.mockResolvedValueOnce(undefined)
    expect(await canAssignPull('org/repo', '7', 'bob')).toBe(true)
    cnbFetchVoidMock.mockRejectedValueOnce(notFoundError())
    expect(await canAssignPull('org/repo', '7', 'x')).toBe(false)
    cnbFetchVoidMock.mockRejectedValueOnce(serverError())
    await expect(canAssignPull('org/repo', '7', 'x')).rejects.toThrow()
    expect(cnbFetchMock).not.toHaveBeenCalled() // 全程无 JSON 通道
  })

  it('fetchPullCommitStatuses：GET 走 cnbFetch，复用 CommitStatusResult 归一化', async () => {
    cnbFetchMock.mockResolvedValueOnce({
      sha: 'abc', state: 'success',
      statuses: [{ context: 'ci/build', state: 'success', description: 'ok', target_url: 'https://x' }],
    })
    const result = await fetchPullCommitStatuses('org/repo', '7')
    expect(cnbFetchMock).toHaveBeenCalledTimes(1)
    expect(cnbFetchVoidMock).not.toHaveBeenCalled()
    expect(cnbFetchMock.mock.calls[0][0]).toBe('/org/repo/-/pulls/7/commit-statuses')
    expect(result.sha).toBe('abc')
    expect(result.checks).toEqual([{ context: 'ci/build', state: 'success', description: 'ok', targetUrl: 'https://x' }])
  })

  it('commitStatusMeta 六态独立映射：success/failed/weird 断言，未知中性', () => {
    // 复用现有映射：PR CI 与单提交 CI 同口径（GitLab 六态，禁止构建四态）
    expect(commitStatusMeta('success').color).toBe('success')
    expect(commitStatusMeta('failed').color).toBe('error')
    expect(commitStatusMeta('running').color).toBe('info')
    expect(commitStatusMeta('canceled').color).toBe('neutral')
    expect(commitStatusMeta('weird').color).toBe('neutral')
    expect(commitStatusMeta('weird').i18nKey).toBe('repo.commitStatus.unknown')
  })
})
