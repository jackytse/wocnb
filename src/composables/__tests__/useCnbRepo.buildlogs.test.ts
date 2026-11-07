/**
 * fetchBuildLogs 的**查询串**专项单测（QA 补充）。
 *
 * 工程师的 useCnbRepo.test.ts 覆盖了归一化与 GET 参数 status/page，
 * 但构建通知轮询新引入的两个参数（sn 精确回查、pageSize 放大）没有断言。
 * 这两个参数一旦丢失，症状是"构建结束时状态永远未知"（回查命中不了），
 * 属于静默失效，因此单独钉一遍。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const cnbFetchMock = vi.fn()

vi.mock('../useCnbAuth', () => {
  class FakeCnbApiError extends Error {
    status?: number
    kind: string
    constructor(message: string, status?: number, kind = 'network') {
      super(message)
      this.status = status
      this.kind = kind
    }
  }
  return {
    cnbFetch: (...args: unknown[]) => cnbFetchMock(...args),
    cnbFetchText: vi.fn(),
    CnbApiError: FakeCnbApiError,
  }
})

import { fetchBuildLogs } from '../useCnbRepo'

/** 取最近一次请求的完整 URL */
function lastUrl(): string {
  const calls = cnbFetchMock.mock.calls
  return String(calls[calls.length - 1]?.[0])
}

beforeEach(() => {
  cnbFetchMock.mockReset()
  cnbFetchMock.mockResolvedValue({ total: 0, data: [] })
})

describe('fetchBuildLogs 查询串', () => {
  it('sn 精确回查进查询串（构建结束后的终态回查依赖它）', async () => {
    await fetchBuildLogs('org/repo', { sn: '42', pageSize: 10 })

    const url = lastUrl()
    expect(url).toContain('sn=42')
    expect(url).toContain('page_size=10')
    // 回查不带 status 过滤：终态可能是 success/error/cancel 任一
    expect(url).not.toContain('status=')
  })

  it('status=pending 轮询不带 sn（每轮拉全量 pending）', async () => {
    await fetchBuildLogs('org/repo', { status: 'pending', pageSize: 100 })

    const url = lastUrl()
    expect(url).toContain('status=pending')
    expect(url).toContain('page_size=100')
    expect(url).not.toContain('sn=')
  })

  it('多级子组织路径按段编码、斜杠不被吞（否则请求打到错误仓库）', async () => {
    await fetchBuildLogs('guroads/team/sub/repo', { sn: '7' })

    const url = lastUrl()
    expect(url).toContain('/guroads/team/sub/repo/-/build/logs')
  })

  it('仓库路径中的特殊字符按段编码', async () => {
    await fetchBuildLogs('org/re po#1', { sn: '7' })

    const url = lastUrl()
    expect(url).toContain('/org/re%20po%231/-/build/logs')
  })
})
