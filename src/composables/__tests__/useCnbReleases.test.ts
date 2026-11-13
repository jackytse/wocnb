/**
 * useCnbReleases 数据层单测（T06 验收标准逐条覆盖）。
 *
 * 网络层 cnbFetch 全部 mock（与 useCnbRepo.test.ts 同范式）。重点锁定：
 * - normalizeRelease 的兜底规则（assets 缺失 / name 空 / published_at 空）；
 * - **不读取 brower_download_url**（官方拼写错误字段）—— 用"仅含该字段"
 *   的原始数据断言 browserUrl 为空；
 * - fetchLatestRelease 404 → null 不抛；非 404 照常抛。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// mock 网络通道：cnbFetch 按用例注入响应；CnbApiError 用同签名替身
const cnbFetchMock = vi.fn()

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
    cnbFetchText: vi.fn(),
    CnbApiError: FakeCnbApiError,
  }
})

import { CnbApiError } from '../useCnbAuth'
import {
  fetchLatestRelease,
  fetchReleases,
  normalizeRelease,
  releaseAssetApiUrl,
} from '../useCnbReleases'

beforeEach(() => {
  cnbFetchMock.mockReset()
})

// ---------------------------------------------------------------------------
// normalizeRelease：归一化兜底规则（T06 验收标准）
// ---------------------------------------------------------------------------

describe('normalizeRelease', () => {
  it('assets 缺失 → 空数组；assets 非数组同样兜底为空数组', () => {
    // 整个 assets 字段缺失
    expect(normalizeRelease({ id: '1', tag_name: 'v1' }).assets).toEqual([])
    // assets 显式为 null / 非数组（服务端畸形响应防御）
    expect(normalizeRelease({ id: '1', tag_name: 'v1', assets: null as never }).assets).toEqual([])
    expect(normalizeRelease({ id: '1', tag_name: 'v1', assets: 'bad' as never }).assets).toEqual([])
  })

  it('name 为空 → 回退 tagName；name 有值原样保留', () => {
    expect(normalizeRelease({ id: '1', tag_name: 'v1.0.0', name: '' }).name).toBe('v1.0.0')
    expect(normalizeRelease({ id: '1', tag_name: 'v1.0.0' }).name).toBe('v1.0.0')
    expect(normalizeRelease({ id: '1', tag_name: 'v1.0.0', name: '首个版本' }).name).toBe('首个版本')
  })

  it('published_at 为空 → 回退 created_at；两者都有时取 published_at', () => {
    expect(
      normalizeRelease({ id: '1', tag_name: 'v1', created_at: '2026-01-01T00:00:00Z' }).publishedAt,
    ).toBe('2026-01-01T00:00:00Z')
    expect(
      normalizeRelease({
        id: '1',
        tag_name: 'v1',
        created_at: '2026-01-01T00:00:00Z',
        published_at: '2026-02-02T00:00:00Z',
      }).publishedAt,
    ).toBe('2026-02-02T00:00:00Z')
    // 两者皆空 → 空串（界面隐藏时间区，不报错）
    expect(normalizeRelease({ id: '1', tag_name: 'v1' }).publishedAt).toBe('')
  })

  it('禁止读取 brower_download_url（官方拼写错误字段）：仅含该字段时 browserUrl 为空', () => {
    const item = normalizeRelease({
      id: '1',
      tag_name: 'v1',
      assets: [
        {
          id: 'a1',
          name: 'app.zip',
          // 仅有拼写错误字段（无正确拼写字段）—— 归一化结果必须为空串
          brower_download_url: 'https://cnb.cool/wrong',
        },
      ],
    })
    expect(item.assets).toHaveLength(1)
    expect(item.assets[0].browserUrl).toBe('')
  })

  it('读取正确拼写的 browser_download_url 与 API 域 url', () => {
    const item = normalizeRelease({
      id: '1',
      tag_name: 'v1',
      assets: [{
        id: 'a1',
        name: 'app.zip',
        url: 'https://api.cnb.cool/o/r/-/releases/download/v1/app.zip',
        browser_download_url: 'https://cnb.cool/o/r/releases/download/v1/app.zip',
        size: 1024,
      }],
    })
    expect(item.assets[0].apiUrl).toBe('https://api.cnb.cool/o/r/-/releases/download/v1/app.zip')
    expect(item.assets[0].browserUrl).toBe('https://cnb.cool/o/r/releases/download/v1/app.zip')
    expect(item.assets[0].size).toBe(1024)
  })

  it('布尔/作者/正文等字段的兜底（畸形输入不抛错）', () => {
    // 全空对象：所有字段有定义且不抛错
    const empty = normalizeRelease({})
    expect(empty.id).toBe('')
    expect(empty.tagName).toBe('')
    expect(empty.name).toBe('')
    expect(empty.isDraft).toBe(false)
    expect(empty.isPrerelease).toBe(false)
    expect(empty.isLatest).toBe(false)
    expect(empty.authorName).toBe('')
    expect(empty.body).toBe('')

    const full = normalizeRelease({
      id: '9',
      tag_name: 'v2',
      draft: true,
      prerelease: true,
      is_latest: true,
      body: '# changelog',
      author: { nickname: 'Alex', username: 'alex' },
    })
    expect(full.isDraft).toBe(true)
    expect(full.isPrerelease).toBe(true)
    expect(full.isLatest).toBe(true)
    expect(full.authorName).toBe('Alex')
  })
})

// ---------------------------------------------------------------------------
// fetchReleases / fetchLatestRelease：网络层行为
// ---------------------------------------------------------------------------

describe('fetchReleases', () => {
  it('数组响应逐条归一化；非数组响应兜底空数组', async () => {
    cnbFetchMock.mockResolvedValueOnce([{ id: '1', tag_name: 'v1' }])
    const items = await fetchReleases('org/repo', { page: 2, pageSize: 20 })
    expect(items).toHaveLength(1)
    expect(items[0].tagName).toBe('v1')
    // 请求路径与分页参数断言
    expect(cnbFetchMock.mock.calls[0][0]).toBe('/org/repo/-/releases?page=2&page_size=20')

    cnbFetchMock.mockResolvedValueOnce('not-an-array' as never)
    expect(await fetchReleases('org/repo')).toEqual([])
  })

  it('错误照常抛出（403/网络），由页面 StateAlert 呈现', async () => {
    cnbFetchMock.mockRejectedValueOnce(new CnbApiError('forbidden', 403, 'forbidden'))
    await expect(fetchReleases('org/repo')).rejects.toMatchObject({ kind: 'forbidden' })
  })
})

describe('fetchLatestRelease', () => {
  it('404（无 Release 的正常态）→ 返回 null 不抛', async () => {
    cnbFetchMock.mockRejectedValueOnce(new CnbApiError('not found', 404, 'notFound'))
    await expect(fetchLatestRelease('org/repo')).resolves.toBeNull()
  })

  it('正常响应 → 归一化 ReleaseItem', async () => {
    cnbFetchMock.mockResolvedValueOnce({ id: '5', tag_name: 'v9', is_latest: true })
    const item = await fetchLatestRelease('org/repo')
    expect(item?.id).toBe('5')
    expect(item?.isLatest).toBe(true)
    expect(cnbFetchMock.mock.calls[0][0]).toBe('/org/repo/-/releases/latest')
  })

  it('非 404 错误照常抛出（403 权限不足 / 网络异常不能被吞）', async () => {
    cnbFetchMock.mockRejectedValueOnce(new CnbApiError('forbidden', 403, 'forbidden'))
    await expect(fetchLatestRelease('org/repo')).rejects.toMatchObject({ kind: 'forbidden' })
    cnbFetchMock.mockRejectedValueOnce(new CnbApiError('network', undefined, 'network'))
    await expect(fetchLatestRelease('org/repo')).rejects.toMatchObject({ kind: 'network' })
  })
})

// ---------------------------------------------------------------------------
// releaseAssetApiUrl：附件下载地址拼装（api.cnb.cool 域 + 路径段编码）
// ---------------------------------------------------------------------------

describe('releaseAssetApiUrl', () => {
  it('拼装 api.cnb.cool 域下载地址，tag 与文件名逐段编码', () => {
    expect(releaseAssetApiUrl('org/repo', 'v1.0.0', 'app.zip')).toBe(
      'https://api.cnb.cool/org/repo/-/releases/download/v1.0.0/app.zip',
    )
    // 含特殊字符的文件名被编码（不破坏 URL 结构）
    expect(releaseAssetApiUrl('org/repo', 'v1', 'a b.tar.gz')).toContain(
      '/-/releases/download/v1/a%20b.tar.gz',
    )
  })
})
