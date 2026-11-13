/**
 * useCnbPackages 数据层单测（T08-1 + 多态归一化）。
 *
 * 网络层 cnbFetch 全 mock。重点锁定：
 * - pickByType 的三条规则（精确键 / 回退首个非空键 / 全空 null）；
 * - docker tag 的派生字段（size = Σ images、digest = images[0]、arches）；
 * - tag ?? name 兜底（列表用 name、详情用 tag）；
 * - type=all 400 → fanout 降级（断言请求次数与并发后的合并去重）。
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

import { CnbApiError } from '../useCnbAuth'
import {
  deletePackageTag,
  fetchPackageTags,
  fetchPackages,
  normalizeProvenance,
  pickByType,
} from '../useCnbPackages'

beforeEach(() => {
  cnbFetchMock.mockReset()
})

// ---------------------------------------------------------------------------
// pickByType：多态取键三条规则（T08-1）
// ---------------------------------------------------------------------------

describe('pickByType', () => {
  it('精确键命中：{package, docker:[...]} + type=docker → 取到数组', () => {
    const docker = [{ name: 'v1' }]
    expect(pickByType({ package: 'x', docker }, 'docker')).toBe(docker)
  })

  it('回退首个非空键：type=npm 且无 npm 键 → 取到 docker（首个非空类型键）', () => {
    const docker = [{ name: 'v1' }]
    expect(pickByType({ package: 'x', docker }, 'npm')).toBe(docker)
  })

  it('跳过 package 标识键：仅 package 有值时不能把字符串当类型子对象返回', () => {
    expect(pickByType({ package: 'x' }, 'npm')).toBeNull()
  })

  it('全空（无任何非空类型键）→ null；raw 非 object → null', () => {
    expect(pickByType({ npm: [], docker: {} }, 'npm')).toBeNull()
    expect(pickByType(null, 'npm')).toBeNull()
    expect(pickByType(undefined, 'npm')).toBeNull()
    expect(pickByType('bad', 'npm')).toBeNull()
  })

  it('精确键为空数组时回退（空数组不算"非空"），对象/字符串同理', () => {
    const helm = [{ name: 'chart-1' }]
    // npm 为空数组 → 回退 helm
    expect(pickByType({ npm: [], helm }, 'npm')).toBe(helm)
    // npm 为空对象 → 回退
    expect(pickByType({ npm: {}, helm }, 'npm')).toBe(helm)
  })
})

// ---------------------------------------------------------------------------
// normalize：tag ?? name、docker 派生、溯源公共子集
// ---------------------------------------------------------------------------

describe('tag 归一化（经 fetchPackageTags 触发）', () => {
  it('tag ?? name 兜底：详情条目用 tag 字段，列表条目用 name 字段', async () => {
    // 列表形态（name）
    cnbFetchMock.mockResolvedValueOnce({ package: 'app', npm: [{ name: '1.0.0', size: 10 }] })
    const list = await fetchPackageTags('org/repo', 'npm', 'app')
    expect(list[0].name).toBe('1.0.0')

    // 详情形态（tag）
    cnbFetchMock.mockResolvedValueOnce({ package: 'app', npm: [{ tag: '1.0.0', size: 10 }] })
    const detailList = await fetchPackageTags('org/repo', 'npm', 'app')
    expect(detailList[0].name).toBe('1.0.0')
  })

  it('docker tag：size = Σ images[].size、digest = images[0].digest、arches 去重派生', async () => {
    cnbFetchMock.mockResolvedValueOnce({
      package: 'app',
      docker: [{
        name: 'v2',
        images: [
          { size: 100, digest: 'sha256:a', arch: 'linux/amd64/v3' },
          { size: 50, digest: 'sha256:b', arch: 'linux/arm64' },
          { size: 30, digest: 'sha256:c', arch: 'linux/amd64/v3' },
        ],
      }],
    })
    const tags = await fetchPackageTags('org/repo', 'docker', 'app')
    expect(tags[0].size).toBe(180)
    expect(tags[0].digest).toBe('sha256:a')
    expect(tags[0].arches).toEqual(['linux/amd64/v3', 'linux/arm64'])
    // docker 无 status 字段 → 空串兜底
    expect(tags[0].status).toBe('')
  })

  it('非 docker tag：digest/size/status 直接取自有字段，arches 为空', async () => {
    cnbFetchMock.mockResolvedValueOnce({
      package: 'app',
      maven: [{ name: '1.0', digest: 'sha256:m', size: 2048, status: 'ready' }],
    })
    const tags = await fetchPackageTags('org/repo', 'maven', 'app')
    expect(tags[0].digest).toBe('sha256:m')
    expect(tags[0].size).toBe(2048)
    expect(tags[0].status).toBe('ready')
    expect(tags[0].arches).toEqual([])
  })

  it('多态响应结构异常（无任何类型键）→ 空数组不抛错', async () => {
    cnbFetchMock.mockResolvedValueOnce({ package: 'app' })
    expect(await fetchPackageTags('org/repo', 'npm', 'app')).toEqual([])
  })
})

describe('normalizeProvenance（溯源公共子集）', () => {
  it('snake_case → camelCase，原始对象原样保留', () => {
    const info = normalizeProvenance({
      digest: 'sha256:aa',
      git_address: 'https://cnb.cool/o/r',
      git_commit: 'abc123',
      registry_address: 'docker.cnb.cool/o/r',
      sn: '42',
      tag: 'v1',
    })
    expect(info.gitAddress).toBe('https://cnb.cool/o/r')
    expect(info.gitCommit).toBe('abc123')
    expect(info.registryAddress).toBe('docker.cnb.cool/o/r')
    expect(info.sn).toBe('42')
    expect(info.raw).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// fetchPackages：type 必填 + 400 fanout 降级
// ---------------------------------------------------------------------------

describe('fetchPackages fanout（R13）', () => {
  it('type=all 正常 200 → 直接返回，不触发 fanout', async () => {
    cnbFetchMock.mockResolvedValueOnce([{ name: 'app', package_type: 'npm' }])
    const items = await fetchPackages('org/repo', { type: 'all' })
    expect(items).toHaveLength(1)
    expect(items[0].type).toBe('npm')
    expect(cnbFetchMock).toHaveBeenCalledTimes(1)
  })

  it('type=all 返回 400 → fanout 逐类型请求并合并去重（并发受限）', async () => {
    // 第一次（all）400，随后 12 个类型：docker/npm 有数据，其余 404 静默跳过
    cnbFetchMock.mockRejectedValueOnce(new CnbApiError('bad type', 400))
    cnbFetchMock.mockImplementation((_path: string) => {
      const p = _path as string
      // fanout 把 type 放在 query 参数（列表端点 /-/packages?type=x），按 query 匹配
      if (p.includes('type=docker')) {
        return Promise.resolve([{ name: 'img', package_type: 'docker' }])
      }
      if (p.includes('type=npm')) {
        return Promise.resolve([{ name: 'pkg', package_type: 'npm' }, { name: 'img', package_type: 'docker' }])
      }
      return Promise.reject(new CnbApiError('nf', 404, 'notFound'))
    })
    const items = await fetchPackages('org/repo')
    // 12 类型 = 1(all 失败) + 12 次 fanout 请求
    expect(cnbFetchMock).toHaveBeenCalledTimes(13)
    // 合并去重：docker 的 img 与 npm 里重复的 img（type|name 同键）只留一条
    expect(items.map(i => `${i.type}/${i.name}`).sort()).toEqual(['docker/img', 'npm/pkg'])
  })

  it('单类型 400 不触发 fanout（直接抛出）', async () => {
    cnbFetchMock.mockRejectedValueOnce(new CnbApiError('bad', 400))
    await expect(fetchPackages('org/repo', { type: 'npm' })).rejects.toMatchObject({ status: 400 })
    expect(cnbFetchMock).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// deletePackageTag：DELETE 路径与编码
// ---------------------------------------------------------------------------

describe('deletePackageTag', () => {
  it('DELETE 到 …/-/tag/{tag}，type/tag 逐段编码、name 整段编码', async () => {
    cnbFetchMock.mockResolvedValueOnce({})
    await deletePackageTag('org/repo', 'docker', 'my/app', 'v1.0.0')
    const [path, options] = cnbFetchMock.mock.calls[0] as [string, { method: string }]
    // 制品名（如 docker 的 my/app）含 '/'，但 swagger 把 {name} 声明为单个
    // path 段 —— 必须整段编码成 %2F 才不破坏路径结构（与 fetchPackageDetail
    // 同一口径），故期望 my%2Fapp 而非 my/app
    expect(path).toBe('/org/repo/-/packages/docker/my%2Fapp/-/tag/v1.0.0')
    expect(options.method).toBe('DELETE')
  })
})
