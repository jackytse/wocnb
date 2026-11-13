/**
 * useCnbExplore 数据层单测（T15）。
 *
 * 重点锁定（验收 2/3 的口径红线）：
 * - 搜索参数名是 **key**（不是 q）；空关键词不请求；topN 默认 30；
 * - **无分页**：URL 中不得出现 page 参数（API 不支持）；
 * - 榜单 type 进路径（daily|weekly|annual）；language 仅在有值时携带；
 * - language-list 的 **rankType 必填**。
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

import {
  fetchRankLanguageList,
  fetchRepoRank,
  searchPublicRepos,
} from '../useCnbExplore'

beforeEach(() => {
  cnbFetchMock.mockReset()
})

describe('searchPublicRepos', () => {
  it('空关键词不请求，直接返回 []（验收 2）', async () => {
    expect(await searchPublicRepos('')).toEqual([])
    expect(await searchPublicRepos('   ')).toEqual([])
    expect(cnbFetchMock).not.toHaveBeenCalled()
  })

  it('参数名为 key（不是 q）+ topN 默认 30 + 无分页参数', async () => {
    cnbFetchMock.mockResolvedValueOnce([{ path: 'org/repo', star_count: 5, fork_count: 2 }])
    const items = await searchPublicRepos('vue')
    const [path] = cnbFetchMock.mock.calls[0] as [string]
    expect(path).toContain('/search/public-repos?key=vue')
    expect(path).toContain('topN=30')
    expect(path).not.toContain('page=') // 无分页红线
    expect(items[0]).toMatchObject({ path: 'org/repo', starCount: 5, forkCount: 2 })
  })

  it('topN 可选值透传（10/30/50/100）', async () => {
    cnbFetchMock.mockResolvedValueOnce([])
    await searchPublicRepos('k', { topN: 100 })
    expect((cnbFetchMock.mock.calls[0] as [string])[0]).toContain('topN=100')
  })
})

describe('fetchRepoRank', () => {
  it('type 进路径（daily/weekly/annual），增量字段归一化（验收 4）', async () => {
    cnbFetchMock.mockResolvedValueOnce({
      rank_list: [{ path: 'org/hot', increase_star: 12, increase_fork: 3, star_count: 100 }],
      updated_at: '2026-02-08T00:00:00Z',
    })
    const result = await fetchRepoRank('daily')
    expect((cnbFetchMock.mock.calls[0] as [string])[0]).toContain('/ranks/repo/daily')
    expect(result.items[0]).toMatchObject({
      path: 'org/hot',
      increaseStar: 12,
      increaseFork: 3,
      starCount: 100,
    })
    expect(result.updatedAt).toBe('2026-02-08T00:00:00Z')
  })

  it('language 仅在有值时携带；无值不出现 language 参数', async () => {
    cnbFetchMock.mockResolvedValue({ rank_list: [] })
    await fetchRepoRank('weekly', { language: 'TypeScript' })
    expect((cnbFetchMock.mock.calls[0] as [string])[0]).toContain('language=TypeScript')

    await fetchRepoRank('weekly')
    expect((cnbFetchMock.mock.calls[1] as [string])[0]).not.toContain('language=')
  })
})

describe('fetchRankLanguageList', () => {
  it('rankType 必填（swagger）进 query，空语言项过滤', async () => {
    cnbFetchMock.mockResolvedValueOnce({ language: ['TypeScript', '', 'Rust'] })
    const langs = await fetchRankLanguageList('annual')
    expect((cnbFetchMock.mock.calls[0] as [string])[0]).toBe('/ranks/repo/language-list?rankType=annual')
    expect(langs).toEqual(['TypeScript', 'Rust'])
  })

  it('language 字段缺失 → 空数组不抛错', async () => {
    cnbFetchMock.mockResolvedValueOnce({})
    expect(await fetchRankLanguageList('daily')).toEqual([])
  })
})
