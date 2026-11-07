/**
 * useCnbRepo 数据层单测（纯逻辑：归一化 / viewMode 降级 / 畸形输入守卫）。
 *
 * 网络层 cnbFetch/cnbFetchText 全部 mock —— 数据层的职责是"给定 API 原始
 * 响应，产出正确的归一化结果"，请求本身属通道层（useCnbAuth/ Rust），不在
 * 本测试范围。重点覆盖工程师自报风险区 #2：fetchBuildStatus 对 free-form
 * pipelinesStatus 的解析假设（空对象/非对象/缺字段 → parseOk:false 不抛错）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// mock 网络通道：cnbFetch 按用例注入响应；CnbApiError 用同签名替身
const cnbFetchMock = vi.fn()
const cnbFetchTextMock = vi.fn()

vi.mock('../useCnbAuth', () => {
  class FakeCnbApiError extends Error {
    status?: number
    kind: string
    missingScope?: string
    constructor(message: string, status?: number, kind?: string, missingScope?: string) {
      super(message)
      this.status = status
      this.kind = kind ?? 'network'
      this.missingScope = missingScope
    }
  }
  return {
    cnbFetch: (...args: unknown[]) => cnbFetchMock(...args),
    cnbFetchText: (...args: unknown[]) => cnbFetchTextMock(...args),
    CnbApiError: FakeCnbApiError,
  }
})

import {
  fetchBuildLogs,
  fetchBuildStatus,
  fetchRepoContents,
  fetchStageLog,
  normalizeRepoPath,
  repoSiteUrl,
  visibilityBadge,
} from '../useCnbRepo'

beforeEach(() => {
  cnbFetchMock.mockReset()
  cnbFetchTextMock.mockReset()
})

// ---------------------------------------------------------------------------
// normalizeRepoPath / repoSiteUrl：catch-all 路径单点编码
// ---------------------------------------------------------------------------

describe('normalizeRepoPath', () => {
  it('catch-all 数组按 / 拼接（多级子组织）', () => {
    expect(normalizeRepoPath(['org', 'sub', 'api'])).toBe('org/sub/api')
  })

  it('字符串输入原样透传', () => {
    expect(normalizeRepoPath('org/repo')).toBe('org/repo')
  })

  it('过滤空段（/repos/ 空参兜底不产生非法路径）', () => {
    expect(normalizeRepoPath(['', 'org', ''])).toBe('org')
    expect(normalizeRepoPath([])).toBe('')
  })
})

describe('repoSiteUrl', () => {
  it('拼接 cnb.cool 站点 URL，sub 可选', () => {
    expect(repoSiteUrl('org/repo')).toBe('https://cnb.cool/org/repo')
    expect(repoSiteUrl('org/repo', '/-/issues/42')).toBe('https://cnb.cool/org/repo/-/issues/42')
  })
})

describe('visibilityBadge', () => {
  it('Public/Secret/Private 三态颜色正确', () => {
    expect(visibilityBadge('Public').color).toBe('success')
    expect(visibilityBadge('Secret').color).toBe('warning')
    expect(visibilityBadge('Private').color).toBe('neutral')
  })

  it('未知枚举按 Private 处理（保守策略，不误标公开）', () => {
    expect(visibilityBadge('WeirdValue').color).toBe('neutral')
    expect(visibilityBadge('').color).toBe('neutral')
  })
})

// ---------------------------------------------------------------------------
// fetchRepoContents：viewMode 三档降级判定 + 目录排序 + entries 守卫
// ---------------------------------------------------------------------------

describe('fetchRepoContents（viewMode 降级与归一化）', () => {
  it('> 1MB 判定 too-large（不加载内容阈值）', async () => {
    cnbFetchMock.mockResolvedValue({ type: 'blob', size: 1024 * 1024 + 1, encoding: 'base64', content: 'xx' })
    const entry = await fetchRepoContents('org/repo')
    expect(entry.viewMode).toBe('too-large')
  })

  it('恰好 1MB 不算 too-large，落入 no-highlight 段', async () => {
    // 边界：判定条件是严格大于，1MB 整仍加载内容但关高亮
    cnbFetchMock.mockResolvedValue({ type: 'blob', size: 1024 * 1024, encoding: 'base64' })
    const entry = await fetchRepoContents('org/repo')
    expect(entry.viewMode).toBe('no-highlight')
  })

  it('> 256KB 且 <= 1MB 判定 no-highlight（关高亮阈值）', async () => {
    cnbFetchMock.mockResolvedValue({ type: 'blob', size: 300 * 1024 })
    const entry = await fetchRepoContents('org/repo')
    expect(entry.viewMode).toBe('no-highlight')
  })

  it('恰好 256KB 判定 ok', async () => {
    cnbFetchMock.mockResolvedValue({ type: 'blob', size: 256 * 1024 })
    expect((await fetchRepoContents('org/repo')).viewMode).toBe('ok')
  })

  it('lfs 类型 / lfs_download_url 存在时优先判定 lfs', async () => {
    cnbFetchMock.mockResolvedValue({ type: 'blob', size: 10, lfs_download_url: 'https://x' })
    expect((await fetchRepoContents('org/repo')).viewMode).toBe('lfs')
    cnbFetchMock.mockResolvedValue({ type: 'lfs', size: 10 })
    expect((await fetchRepoContents('org/repo')).viewMode).toBe('lfs')
  })

  it('size 缺失默认 ok（目录条目无 size 不误降级）', async () => {
    cnbFetchMock.mockResolvedValue({ type: 'blob', name: 'a.ts' })
    expect((await fetchRepoContents('org/repo')).viewMode).toBe('ok')
  })

  it('base64 内容仅在 type=blob 且 encoding=base64 时保留', async () => {
    cnbFetchMock.mockResolvedValue({ type: 'blob', encoding: 'base64', content: 'aGVsbG8=' })
    expect((await fetchRepoContents('org/repo')).contentBase64).toBe('aGVsbG8=')
    cnbFetchMock.mockResolvedValue({ type: 'blob', content: 'aGVsbG8=' })
    expect((await fetchRepoContents('org/repo')).contentBase64).toBeUndefined()
  })

  it('目录条目排序：目录优先 + 名称升序（PRD P0-A3）', async () => {
    cnbFetchMock.mockResolvedValue({
      type: 'tree',
      entries: [
        { name: 'z.txt', type: 'blob' },
        { name: 'src', type: 'tree' },
        { name: 'a.txt', type: 'blob' },
        { name: 'docs', type: 'tree' },
      ],
    })
    const entry = await fetchRepoContents('org/repo')
    expect(entry.entries?.map(e => e.name)).toEqual(['docs', 'src', 'a.txt', 'z.txt'])
  })

  it('entries 非数组/缺失降级为空数组不崩（空目录 / Secret 仓库）', async () => {
    cnbFetchMock.mockResolvedValue({ type: 'tree', entries: 'oops' })
    expect((await fetchRepoContents('org/repo')).entries).toEqual([])
    cnbFetchMock.mockResolvedValue({ type: 'tree' })
    expect((await fetchRepoContents('org/repo')).entries).toEqual([])
  })

  it('type 非法枚举兜底 blob', async () => {
    cnbFetchMock.mockResolvedValue({ type: 'mystery' })
    expect((await fetchRepoContents('org/repo')).type).toBe('blob')
  })

  it('ref 与 filePath 正确编码进请求路径', async () => {
    cnbFetchMock.mockResolvedValue({ type: 'blob', size: 1 })
    await fetchRepoContents('org/repo', { ref: 'feature/x', filePath: 'src/a b.ts' })
    const url = cnbFetchMock.mock.calls[0][0] as string
    expect(url).toContain('/-/git/contents/src/a%20b.ts')
    expect(url).toContain('ref=feature%2Fx')
  })
})

// ---------------------------------------------------------------------------
// fetchBuildStatus：pipelinesStatus free-form 解析守卫（风险区 #2）
// ---------------------------------------------------------------------------

describe('fetchBuildStatus（畸形输入降级，绝不抛错）', () => {
  // 统一入口：注入 status 接口响应后执行被测函数
  async function run(pipelinesStatus: unknown, status = 'success') {
    cnbFetchMock.mockResolvedValue({ status, pipelinesStatus })
    return fetchBuildStatus('org/repo', '123')
  }

  it('正常结构：pipelineId + stageId 可解析，duration 改名 durationMs', async () => {
    const out = await run({
      'pipe-1': {
        id: 'pipe-1',
        name: 'Build',
        status: 'success',
        duration: 1234,
        stages: [{ id: 'stage-1', name: 'install', status: 'success', duration: 100 }],
      },
    })
    expect(out.parseOk).toBe(true)
    expect(out.pipelines).toHaveLength(1)
    expect(out.pipelines[0]).toMatchObject({ id: 'pipe-1', name: 'Build', status: 'success', durationMs: 1234 })
    expect(out.pipelines[0].stages[0]).toMatchObject({ id: 'stage-1', durationMs: 100 })
  })

  it('空对象 → parseOk:false（无条目可渲染，走外跳降级）', async () => {
    const out = await run({})
    expect(out.parseOk).toBe(false)
    expect(out.pipelines).toEqual([])
  })

  it('pipelinesStatus 缺失 / null → parseOk:false 不抛错', async () => {
    const out = await run(undefined)
    expect(out.parseOk).toBe(false)
    expect(out.status).toBe('success')
  })

  it('非对象（字符串 / 数字 / 数组）→ parseOk:false 不抛错', async () => {
    expect((await run('weird')).parseOk).toBe(false)
    expect((await run(42)).parseOk).toBe(false)
    expect((await run([{ id: 'x' }])).parseOk).toBe(false)
  })

  it('条目值非对象被跳过；全部无效时 parseOk:false', async () => {
    const out = await run({ p1: 'junk', p2: null })
    expect(out.pipelines).toEqual([])
    expect(out.parseOk).toBe(false)
  })

  it('缺 id/name 时回退对象 key；stages 非数组降级空数组', async () => {
    const out = await run({
      'pipe-key': { status: 'error', stages: 'not-array' },
    })
    expect(out.parseOk).toBe(true)
    expect(out.pipelines[0].id).toBe('pipe-key')
    expect(out.pipelines[0].name).toBe('pipe-key')
    expect(out.pipelines[0].stages).toEqual([])
  })

  it('stage 缺 id 时兜底空串（外跳日志拿不到 stageId 由页面处理）', async () => {
    const out = await run({
      p: { id: 'p', stages: [{ name: 'no-id' }] },
    })
    expect(out.pipelines[0].stages[0].id).toBe('')
    expect(out.pipelines[0].stages[0].name).toBe('no-id')
  })
})

// ---------------------------------------------------------------------------
// fetchBuildLogs / fetchStageLog：camelCase 特例与数组守卫
// ---------------------------------------------------------------------------

describe('fetchBuildLogs', () => {
  it('dto.LogInfo 为 camelCase：duration 改名 durationMs，字段兜底', async () => {
    cnbFetchMock.mockResolvedValue({
      total: 5,
      data: [{ sn: '42', duration: 980, commitTitle: 'fix: x', event: 'push' }],
    })
    const { total, items } = await fetchBuildLogs('org/repo')
    expect(total).toBe(5)
    expect(items[0]).toMatchObject({ sn: '42', durationMs: 980, commitTitle: 'fix: x', event: 'push' })
    expect(items[0].nickName).toBe('')
  })

  it('data 非数组降级空 items；status 筛选进查询串', async () => {
    cnbFetchMock.mockResolvedValue({ data: null })
    const { items } = await fetchBuildLogs('org/repo', { status: 'error', page: 2 })
    expect(items).toEqual([])
    expect(cnbFetchMock.mock.calls[0][0]).toContain('status=error')
    expect(cnbFetchMock.mock.calls[0][0]).toContain('page=2')
  })
})

describe('fetchStageLog', () => {
  it('content 数组原样透传为 lines；URL 三段均编码', async () => {
    cnbFetchMock.mockResolvedValue({ name: 'install', status: 'success', duration: 5, error: '', content: ['line1', 'line2'] })
    const log = await fetchStageLog('org/repo', '123', 'p/1', 's 2')
    expect(log.lines).toEqual(['line1', 'line2'])
    const url = cnbFetchMock.mock.calls[0][0] as string
    expect(url).toContain('/-/build/logs/stage/123/p%2F1/s%202')
  })

  it('content 缺失/非数组降级空数组不崩', async () => {
    cnbFetchMock.mockResolvedValue({ name: 'x' })
    expect((await fetchStageLog('org/repo', '1', 'p', 's')).lines).toEqual([])
    cnbFetchMock.mockResolvedValue({ content: 'oops' })
    expect((await fetchStageLog('org/repo', '1', 'p', 's')).lines).toEqual([])
  })
})
