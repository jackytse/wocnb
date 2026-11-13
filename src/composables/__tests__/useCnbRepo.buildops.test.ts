/**
 * 流水线写操作数据层单测（T04 验收标准 2/3）。
 *
 * 用 vitest mock cnbFetch，断言 triggerBuild 的请求体符合 dto.StartBuildReq
 * 的 3 个 swagger 陷阱要求：
 * 1. event 固定 'api_trigger'（传其他值会被服务端拒绝）；
 * 2. sync 是**字符串** 'false' 而非布尔（swagger 原文 {"type":"string"}）；
 * 3. HTTP 200 + success=false 是合法组合 —— 数据层原样返回不抛错，
 *    success 缺失按 false 处理。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const cnbFetchMock = vi.fn()

vi.mock('../useCnbAuth', () => {
  class FakeCnbApiError extends Error {
    status?: number
    kind: string
    constructor(message: string, status?: number, kind?: string) {
      super(message)
      this.status = status
      this.kind = kind ?? 'network'
    }
  }
  return {
    cnbFetch: (...args: unknown[]) => cnbFetchMock(...args),
    cnbFetchText: vi.fn(),
    CnbApiError: FakeCnbApiError,
  }
})

import { deleteBuildLogs, stopBuild, triggerBuild } from '../useCnbRepo'

beforeEach(() => {
  cnbFetchMock.mockReset()
})

describe('triggerBuild 请求体契约（T04-2）', () => {
  it('请求体含 event: "api_trigger" 且 sync 为字符串 "false"（非布尔）', async () => {
    cnbFetchMock.mockResolvedValueOnce({ sn: '42', success: true })
    await triggerBuild('org/repo', { branch: 'main' })

    expect(cnbFetchMock).toHaveBeenCalledTimes(1)
    const [path, options] = cnbFetchMock.mock.calls[0] as [string, { method: string, body: string }]
    // 端点与 method
    expect(path).toBe('/org/repo/-/build/start')
    expect(options.method).toBe('POST')
    // 请求体：解析 JSON 逐字段断言
    const body = JSON.parse(options.body)
    expect(body.event).toBe('api_trigger')
    expect(body.sync).toBe('false')
    // sync 必须是字符串类型（swagger 陷阱 2：布尔会被服务端拒绝）
    expect(typeof body.sync).toBe('string')
    expect(body.branch).toBe('main')
  })

  it('可选字段仅在提供时写入（title/sha/tag/env）', async () => {
    cnbFetchMock.mockResolvedValueOnce({ sn: '7', success: true })
    await triggerBuild('org/repo', { branch: 'dev', title: 'nightly', sha: 'abc', tag: 'v1', env: { FOO: '1' } })
    const body = JSON.parse((cnbFetchMock.mock.calls[0][1] as { body: string }).body)
    expect(body.title).toBe('nightly')
    expect(body.sha).toBe('abc')
    expect(body.tag).toBe('v1')
    expect(body.env).toEqual({ FOO: '1' })

    // 空表单：只有 event/sync 两个固定字段
    cnbFetchMock.mockResolvedValueOnce({ sn: '8', success: true })
    await triggerBuild('org/repo')
    const body2 = JSON.parse((cnbFetchMock.mock.calls[1][1] as { body: string }).body)
    expect(Object.keys(body2).sort()).toEqual(['event', 'sync'])
  })
})

describe('triggerBuild 响应契约（T04-3）', () => {
  it('HTTP 200 + success=false 原样返回不抛错（数据层不拦截，由 UI 判定）', async () => {
    // 分支不存在：HTTP 200 但 success=false —— 合法组合
    cnbFetchMock.mockResolvedValueOnce({ sn: '', buildLogUrl: '', message: 'branch not found', success: false })
    const result = await triggerBuild('org/repo', { branch: 'nope' })
    expect(result.success).toBe(false)
    expect(result.message).toBe('branch not found')
    expect(result.sn).toBe('')
  })

  it('success 字段缺失按 false 处理（防异常响应当成功）', async () => {
    cnbFetchMock.mockResolvedValueOnce({ sn: '9' })
    const result = await triggerBuild('org/repo')
    expect(result.success).toBe(false)
    expect(result.sn).toBe('9')
  })

  it('success=true 返回 sn 与日志直链', async () => {
    cnbFetchMock.mockResolvedValueOnce({ sn: '100', buildLogUrl: 'https://cnb.cool/o/r/-/builds/100', success: true })
    const result = await triggerBuild('org/repo')
    expect(result.success).toBe(true)
    expect(result.sn).toBe('100')
    expect(result.buildLogUrl).toContain('/builds/100')
  })
})

describe('stopBuild / deleteBuildLogs（T04-4 数据层）', () => {
  it('stopBuild：POST 到 /-/build/stop/{sn}，sn 编码进路径', async () => {
    cnbFetchMock.mockResolvedValueOnce({ code: 0, message: '' })
    const result = await stopBuild('org/repo', '1024')
    expect(cnbFetchMock.mock.calls[0][0]).toBe('/org/repo/-/build/stop/1024')
    expect((cnbFetchMock.mock.calls[0][1] as { method: string }).method).toBe('POST')
    expect(result).toEqual({ code: 0, message: '' })
  })

  it('deleteBuildLogs：DELETE 到 /-/build/logs/{sn}，响应缺字段兜底 0/空串', async () => {
    cnbFetchMock.mockResolvedValueOnce({})
    const result = await deleteBuildLogs('org/repo', '1024')
    expect(cnbFetchMock.mock.calls[0][0]).toBe('/org/repo/-/build/logs/1024')
    expect((cnbFetchMock.mock.calls[0][1] as { method: string }).method).toBe('DELETE')
    expect(result).toEqual({ code: 0, message: '' })
  })
})
