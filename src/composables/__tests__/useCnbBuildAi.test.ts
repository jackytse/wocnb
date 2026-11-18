/**
 * T03 数据层单测：AI 用量三端点（REQ-06）。
 *
 * 重点锁定：
 * 1. 三函数均走 cnbFetch（有 body），路径拼装含 sn/pipelineId/page/requestId 各自编码；
 * 2. **code!==0 → 返回空结构**（风险 A2：HTTP 200 也可能业务失败，不把 content 当有效数据）；
 * 3. snake_case → camelCase 归一化 + 各 token 字段/时间缺失兜底；
 * 4. content 自由对象原样保留供 UI 折叠（不猜字段）。
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
  fetchBuildAiAudit,
  fetchBuildAiRequestDetail,
  fetchBuildAiRequests,
  normalizeAiAudit,
  normalizeAiRequestDetail,
  normalizeAiRequestEntry,
  normalizeAiRequests,
} from '../useCnbBuildAi'

beforeEach(() => {
  cnbFetchMock.mockReset()
  cnbFetchVoidMock.mockReset()
})

describe('AI 用量三端点：均走 cnbFetch + 路径正确', () => {
  it('fetchBuildAiAudit：GET ai-audit/{sn}/{pipelineId}，走 cnbFetch，snake_case 归一', async () => {
    cnbFetchMock.mockResolvedValueOnce({
      code: 0,
      content: { total_tokens: 1234, total_credit: 56 },
      request_log_pages: 5,
      request_log_page_size: 20,
    })
    const result = await fetchBuildAiAudit('org/repo', 'sn 1', 'pipe/1')
    expect(cnbFetchMock).toHaveBeenCalledTimes(1)
    expect(cnbFetchVoidMock).not.toHaveBeenCalled()
    // sn 与 pipelineId 各为独立路径段：空格/斜杠分别编码
    expect(cnbFetchMock.mock.calls[0][0]).toBe('/org/repo/-/build/logs/ai-audit/sn%201/pipe%2F1')
    expect(result).toEqual({
      code: 0,
      content: { total_tokens: 1234, total_credit: 56 },
      pageSize: 20,
      pages: 5,
    })
  })

  it('fetchBuildAiRequests：GET ai-request/{sn}/{pipelineId}/{page}，page 作为独立段', async () => {
    cnbFetchMock.mockResolvedValueOnce({ code: 0, content: [{ request_id: 'r1', success: true }] })
    const list = await fetchBuildAiRequests('org/repo', 'sn1', 'pid', 2)
    expect(cnbFetchMock).toHaveBeenCalledTimes(1)
    expect(cnbFetchVoidMock).not.toHaveBeenCalled()
    expect(cnbFetchMock.mock.calls[0][0]).toBe('/org/repo/-/build/logs/ai-request/sn1/pid/2')
    expect(list).toHaveLength(1)
    expect(list[0].requestId).toBe('r1')
    expect(list[0].success).toBe(true)
  })

  it('fetchBuildAiRequestDetail：GET ai-request-detail/.../{requestId}，requestId 编码', async () => {
    cnbFetchMock.mockResolvedValueOnce({ code: 0, content: { messages: [] } })
    const detail = await fetchBuildAiRequestDetail('org/repo', 'sn1', 'pid', 'req#1')
    expect(cnbFetchMock).toHaveBeenCalledTimes(1)
    expect(cnbFetchVoidMock).not.toHaveBeenCalled()
    expect(cnbFetchMock.mock.calls[0][0]).toBe('/org/repo/-/build/logs/ai-request-detail/sn1/pid/req%231')
    expect(detail.content).toEqual({ messages: [] })
  })
})

describe('code!==0 业务失败：一律空结构（A2 核心防线）', () => {
  it('normalizeAiAudit：code=1 → content={}、pages=0、pageSize=0', () => {
    expect(normalizeAiAudit({ code: 1, content: { secret: 'x' }, request_log_pages: 9 }))
      .toEqual({ code: 1, content: {}, pageSize: 0, pages: 0 })
  })

  it('normalizeAiRequests：code=1 → 空数组（不渲染 content）', () => {
    expect(normalizeAiRequests({ code: 1, content: [{ request_id: 'r1' }] })).toEqual([])
  })

  it('normalizeAiRequestDetail：code=1 → content={}', () => {
    expect(normalizeAiRequestDetail({ code: 1, content: { x: 1 } })).toEqual({ code: 1, content: {} })
  })

  it('真实网络返回经 fetch 后也应用 code 判定（端到端数据层）', async () => {
    cnbFetchMock.mockResolvedValueOnce({ code: 500, content: { err: 'boom' }, request_log_pages: 3 })
    const audit = await fetchBuildAiAudit('org/repo', 's', 'p')
    expect(audit.pages).toBe(0)
    expect(audit.content).toEqual({})
    cnbFetchMock.mockResolvedValueOnce({ code: 2, content: [{ request_id: 'x' }] })
    expect(await fetchBuildAiRequests('org/repo', 's', 'p', 1)).toEqual([])
  })
})

describe('字段兜底与自由对象保留', () => {
  it('normalizeAiRequestEntry：全字段 snake_case → camelCase，缺失数值兜底 0，可空字段 null', () => {
    expect(normalizeAiRequestEntry({})).toEqual({
      requestId: '', timestamp: '', model: '', success: false,
      promptTokens: 0, completionTokens: 0, totalTokens: 0,
      thinkingTokens: 0, promptCachedTokens: 0, promptCacheWriteTokens: 0,
      milliCredit: 0, originalMilliCredit: null, discount: null,
      statusCode: 0, failureReason: '', hasDetail: false,
      responseStartDurationMs: 0, responseEndDurationMs: 0,
    })
  })

  it('normalizeAiRequestEntry：合法 0 不被误判为缺失（0 与 null 语义不同）', () => {
    const item = normalizeAiRequestEntry({
      original_milli_credit: 0, discount: 0, milli_credit: 0,
      prompt_tokens: 10, total_tokens: 10,
      response_start_duration_ms: 120,
    })
    expect(item.originalMilliCredit).toBe(0) // 合法 0 保留，不是 null
    expect(item.discount).toBe(0)
    expect(item.promptTokens).toBe(10)
    expect(item.responseStartDurationMs).toBe(120)
  })

  it('content 非对象（null / 数组 / 字符串）降级 {}，不猜字段', () => {
    expect(normalizeAiAudit({ code: 0, content: null }).content).toEqual({})
    expect(normalizeAiAudit({ code: 0, content: [1, 2] }).content).toEqual({})
    expect(normalizeAiRequestDetail({ code: 0, content: 'raw' }).content).toEqual({})
    expect(normalizeAiRequests({ code: 0, content: null })).toEqual([])
  })
})
