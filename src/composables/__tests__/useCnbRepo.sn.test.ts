/**
 * sn 类型契约的单测（构建通知点击直达的隐式依赖）。
 *
 * ## 为什么专门测这个
 *
 * 「点击系统通知直达构建详情」把 sn 经两条通道传递：
 * 1. 通知 extra（JSON 序列化）→ Rust 侧 `extra_str` 只认 `Value::String`；
 * 2. 路由 query（字符串）。
 * 若服务端把 sn 返回成**数字**，而映射层只写 `d.sn || ''`，运行时字段
 * 就会是 number（TS 声明为 string 不报错）。后果：extra 里是 JSON number
 * → Rust 取不到 → 点击在所有平台静默退化成"打开通知面板"。
 *
 * ## 测试方式说明
 *
 * 映射逻辑内联在 fetchBuildLogs / triggerBuild 里，没有单独的纯映射函数，
 * 因此这里 mock 掉 `cnbFetch`（useCnbAuth）直接驱动真实映射代码 —— 比
 * "抽一个只为测试存在的导出"更贴近真实路径，也不会为测试破坏生产 API 表面。
 */
import { describe, expect, it, vi } from 'vitest'

const { cnbFetchMock } = vi.hoisted(() => ({ cnbFetchMock: vi.fn() }))

vi.mock('../useCnbAuth', () => ({
  canManageRole: () => false,
  cnbFetch: (...args: unknown[]) => cnbFetchMock(...args),
  cnbFetchText: vi.fn(),
  CnbApiError: class CnbApiError extends Error {},
}))

import { fetchBuildLogs, triggerBuild } from '../useCnbRepo'

describe('build logs / trigger 响应的 sn 类型收敛', () => {
  it('fetchBuildLogs：服务端返回数字 sn 时收敛为字符串', async () => {
    // 服务端返回数字（历史隐患）→ 映射必须 String() 收敛
    cnbFetchMock.mockResolvedValueOnce({ total: 1, data: [{ sn: 20250101, status: 'success' }] })
    const { items } = await fetchBuildLogs('cnb.cool/a/b')
    expect(items[0].sn).toBe('20250101')
    expect(typeof items[0].sn).toBe('string')
  })

  it('fetchBuildLogs：sn 缺失时为空串（不产生 undefined/null）', async () => {
    cnbFetchMock.mockResolvedValueOnce({ total: 1, data: [{ status: 'success' }] })
    const { items } = await fetchBuildLogs('cnb.cool/a/b')
    expect(items[0].sn).toBe('')
  })

  it('fetchBuildLogs：正常字符串 sn 原样保留', async () => {
    cnbFetchMock.mockResolvedValueOnce({ total: 1, data: [{ sn: '123', status: 'error' }] })
    const { items } = await fetchBuildLogs('cnb.cool/a/b')
    expect(items[0].sn).toBe('123')
  })

  it('triggerBuild：数字 sn 同样收敛为字符串', async () => {
    cnbFetchMock.mockResolvedValueOnce({ sn: 987654, success: true })
    const result = await triggerBuild('cnb.cool/a/b')
    expect(result.sn).toBe('987654')
    expect(typeof result.sn).toBe('string')
  })
})
