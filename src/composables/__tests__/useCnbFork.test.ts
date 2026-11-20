/**
 * useCnbFork 单测：fork 同步状态判定与同步构建触发参数。
 *
 * 锁定口径：
 * - SHA 相同 → same；不同 → outdated；
 * - 上游分支 404 → upstream-missing（无法同步的合法场景）；
 * - 其他错误（网络/403）→ unknown（不显示入口，静默）；
 * - startForkSync：POST /-/build/start，event=api_trigger，config 为
 *   注入的同步流水线 YAML（含 set-url 兜底 / fetch / merge / push 四步）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const cnbFetchMock = vi.fn()
const cnbFetchVoidMock = vi.fn()

vi.mock('../useCnbAuth', () => {
  class FakeCnbApiError extends Error {
    status: number
    constructor(status: number, message: string) {
      super(message)
      this.status = status
    }
  }
  return {
    cnbFetch: (...args: unknown[]) => cnbFetchMock(...args),
    cnbFetchVoid: (...args: unknown[]) => cnbFetchVoidMock(...args),
    cnbFetchText: vi.fn(),
    CnbApiError: FakeCnbApiError,
  }
})

import { fetchForkSyncState, startForkSync } from '../useCnbFork'

beforeEach(() => {
  cnbFetchMock.mockReset()
  cnbFetchVoidMock.mockReset()
})

/** 构造分支详情响应（GET /-/git/branches/{branch}） */
function branchOf(sha: string) {
  return { name: 'refs/heads/main', commit: { sha } }
}

describe('fetchForkSyncState', () => {
  it('fork 与上游 SHA 相同 → same（无需同步）', async () => {
    cnbFetchMock.mockResolvedValue(branchOf('a'.repeat(40)))
    const state = await fetchForkSyncState('jackytse/hello-cnb', 'cnb/tutorial/hello-cnb', 'main')
    expect(state).toBe('same')
    // 两个分支并行请求：fork 与上游各一次
    expect(cnbFetchMock).toHaveBeenCalledTimes(2)
  })

  it('SHA 不同 → outdated（显示同步入口）', async () => {
    cnbFetchMock
      .mockResolvedValueOnce(branchOf('b'.repeat(40)))
      .mockResolvedValueOnce(branchOf('c'.repeat(40)))
    const state = await fetchForkSyncState('jackytse/hello-cnb', 'cnb/tutorial/hello-cnb', 'main')
    expect(state).toBe('outdated')
  })

  it('上游分支 404 → upstream-missing（上游删分支，无法同步）', async () => {
    cnbFetchMock
      .mockResolvedValueOnce(branchOf('b'.repeat(40)))
      .mockRejectedValueOnce(Object.assign(new Error('not found'), { status: 404 }))
    const state = await fetchForkSyncState('jackytse/hello-cnb', 'cnb/tutorial/hello-cnb', 'main')
    expect(state).toBe('upstream-missing')
  })

  it('上游探测网络失败（非 404）→ unknown（静默不显示入口）', async () => {
    cnbFetchMock
      .mockResolvedValueOnce(branchOf('b'.repeat(40)))
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 }))
    const state = await fetchForkSyncState('jackytse/hello-cnb', 'cnb/tutorial/hello-cnb', 'main')
    expect(state).toBe('unknown')
  })

  it('fork 侧分支不存在（异常场景）→ unknown', async () => {
    cnbFetchMock
      .mockRejectedValueOnce(Object.assign(new Error('not found'), { status: 404 }))
      .mockResolvedValueOnce(branchOf('c'.repeat(40)))
    const state = await fetchForkSyncState('jackytse/hello-cnb', 'cnb/tutorial/hello-cnb', 'main')
    expect(state).toBe('unknown')
  })
})

describe('startForkSync', () => {
  it('POST /-/build/start，event=api_trigger，config 为同步流水线', async () => {
    cnbFetchMock.mockResolvedValueOnce({ sn: 'cnb-x-1', buildLogUrl: 'https://cnb.cool/x' })
    const build = await startForkSync('jackytse/hello-cnb', 'cnb/tutorial/hello-cnb', 'main')

    expect(build).toEqual({ sn: 'cnb-x-1', buildLogUrl: 'https://cnb.cool/x' })
    const [path, options] = cnbFetchMock.mock.calls[0] as [string, { method: string, body: string }]
    expect(path).toBe('/jackytse/hello-cnb/-/build/start')
    expect(options.method).toBe('POST')
    const body = JSON.parse(options.body)
    expect(body.branch).toBe('main')
    expect(body.event).toBe('api_trigger')
    // 注入的流水线四要素：remote 兜底、fetch 上游、merge、push 回本仓库
    expect(body.config).toContain('git remote set-url upstream https://cnb.cool/cnb/tutorial/hello-cnb.git')
    expect(body.config).toContain('git fetch upstream main')
    expect(body.config).toContain('git merge --no-edit upstream/main')
    expect(body.config).toContain('git push origin HEAD:main')
  })

  it('响应缺 sn → 抛错（服务端契约破坏，调用方不能拿空号跳转）', async () => {
    cnbFetchMock.mockResolvedValueOnce({ buildLogUrl: 'https://cnb.cool/x' })
    await expect(startForkSync('a/b', 'c/d', 'main')).rejects.toThrow('缺少构建号')
  })
})
