/**
 * T09 数据层单测：提交 / 标签元数据（REQ-08）。
 *
 * 核心锁定两件事（本模块最易出错处）：
 * 1. **通道**：PUT / DELETE 均为 200 空 body → cnbFetchVoid；GET 与 batch 有 body → cnbFetch。
 * 2. **两种 DELETE 的编码形态不同**：
 *    - tag 版 `tag_with_key` 是单段内嵌斜杠 → 整体 `%2F`；
 *    - commit 版 `{sha}/{key}` 是两个独立段 → 分隔符 `/` 必须保留。
 * 写反不会报错，只会静默 404，因此必须有 URL 级断言。
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
  deleteCommitAnnotation,
  deleteTagAnnotation,
  listCommitAnnotations,
  listCommitAnnotationsBatch,
  listTagAnnotations,
  putCommitAnnotations,
  putTagAnnotations,
} from '../useCnbAnnotations'

beforeEach(() => {
  cnbFetchMock.mockReset()
  cnbFetchVoidMock.mockReset()
  cnbFetchVoidMock.mockResolvedValue(undefined)
})

describe('读端点：走 cnbFetch', () => {
  it('listTagAnnotations：GET /git/tag-annotations/{tag}，过滤无 key 条目', async () => {
    cnbFetchMock.mockResolvedValue([
      { key: 'ci', value: 'green', meta: { operator: 'alice' } },
      { key: '', value: 'ignored' },
    ])
    const result = await listTagAnnotations('org/sub/repo', 'v1.0 beta')
    expect(cnbFetchMock).toHaveBeenCalledTimes(1)
    expect(cnbFetchVoidMock).not.toHaveBeenCalled()
    // 仓库路径逐段编码（'/' 保留），tag 单段编码（空格 → %20）
    expect(cnbFetchMock.mock.calls[0][0]).toBe(
      '/org/sub/repo/-/git/tag-annotations/v1.0%20beta',
    )
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ key: 'ci', value: 'green' })
    expect(result[0].meta).toEqual({ operator: 'alice' })
  })

  it('listCommitAnnotations：非数组响应降级为 []', async () => {
    cnbFetchMock.mockResolvedValue({ unexpected: true })
    const result = await listCommitAnnotations('org/repo', 'abc123')
    expect(result).toEqual([])
  })
})

describe('写端点：200 空 body 一律走 cnbFetchVoid', () => {
  it('putTagAnnotations：PUT 走 Void，body 只含 key/value（不回传 meta）', async () => {
    await putTagAnnotations('org/repo', 'v1.0', [
      { key: 'ci', value: 'green', meta: { operator: 'alice' } },
    ])
    expect(cnbFetchVoidMock).toHaveBeenCalledTimes(1)
    expect(cnbFetchMock).not.toHaveBeenCalled()
    const [path, options] = cnbFetchVoidMock.mock.calls[0]
    expect(path).toBe('/org/repo/-/git/tag-annotations/v1.0')
    expect(options.method).toBe('PUT')
    expect(JSON.parse(options.body)).toEqual({
      annotations: [{ key: 'ci', value: 'green' }],
    })
  })

  it('putCommitAnnotations：PUT 走 Void', async () => {
    await putCommitAnnotations('org/repo', 'abc123', [{ key: 'k', value: 'v', meta: {} }])
    expect(cnbFetchVoidMock).toHaveBeenCalledTimes(1)
    expect(cnbFetchVoidMock.mock.calls[0][0]).toBe(
      '/org/repo/-/git/commit-annotations/abc123',
    )
  })
})

describe('两种 DELETE 的路径编码形态（本模块最大的坑）', () => {
  it('deleteTagAnnotation：tag/key 整体编码为单段（%2F）', async () => {
    await deleteTagAnnotation('org/repo', 'v1.0', 'ci/status')
    const [path, options] = cnbFetchVoidMock.mock.calls[0]
    // 整体编码：v1.0%2Fci%2Fstatus —— 全程没有裸 '/'
    expect(path).toBe('/org/repo/-/git/tag-annotations/v1.0%2Fci%2Fstatus')
    expect(options.method).toBe('DELETE')
  })

  it('deleteCommitAnnotation：sha 与 key 是两个独立段（保留分隔斜杠）', async () => {
    await deleteCommitAnnotation('org/repo', 'abc123', 'ci/status')
    const [path] = cnbFetchVoidMock.mock.calls[0]
    // 两段分别编码：abc123 / ci%2Fstatus（key 内部的斜杠被编码，段间斜杠保留）
    expect(path).toBe('/org/repo/-/git/commit-annotations/abc123/ci%2Fstatus')
  })
})

describe('批量查询：一次请求 + 缺失 hash 补空条目', () => {
  it('listCommitAnnotationsBatch：body 带 commit_hashes，按入参顺序补齐', async () => {
    cnbFetchMock.mockResolvedValue([
      { commit_hash: 'a1', annotations: [{ key: 'k', value: 'v' }] },
    ])
    const result = await listCommitAnnotationsBatch('org/repo', ['a1', 'b2'])
    expect(cnbFetchMock).toHaveBeenCalledTimes(1)
    const [path, options] = cnbFetchMock.mock.calls[0]
    expect(path).toBe('/org/repo/-/git/commit-annotations-in-batch')
    expect(options.method).toBe('POST')
    expect(JSON.parse(options.body)).toEqual({ commit_hashes: ['a1', 'b2'] })
    // b2 服务端没返回 → 补空条目，保证与提交行一一对齐
    expect(result).toHaveLength(2)
    expect(result[1]).toEqual({ commitHash: 'b2', annotations: [] })
  })

  it('listCommitAnnotationsBatch：空 hashes 不发请求', async () => {
    const result = await listCommitAnnotationsBatch('org/repo', [])
    expect(result).toEqual([])
    expect(cnbFetchMock).not.toHaveBeenCalled()
  })
})
