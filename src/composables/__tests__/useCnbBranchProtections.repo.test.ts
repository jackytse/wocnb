/**
 * T08 数据层单测：仓库级保护分支规则（REQ-07）。
 *
 * 与组织级的关系：归一化/字段表复用同一份，差异只在**端点前缀与 scope**。
 * 因此本测试聚焦：
 * 1. 5 个函数打的都是 `/-/settings/branch-protections`（不是组织的 git-group-settings）；
 * 2. 三个写端点均空 body → cnbFetchVoid（POST 是 201，仍是空 body）；
 * 3. 请求体沿用 buildBranchProtectionBody：21 个可写字段、**不含 id**。
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
  createEmptyBranchProtection,
  createRepoBranchProtection,
  deleteRepoBranchProtection,
  fetchRepoBranchProtection,
  fetchRepoBranchProtections,
  updateRepoBranchProtection,
} from '../useCnbBranchProtections'

beforeEach(() => {
  cnbFetchMock.mockReset()
  cnbFetchVoidMock.mockReset()
  cnbFetchVoidMock.mockResolvedValue(undefined)
})

describe('仓库级保护分支：端点前缀与通道', () => {
  it('fetchRepoBranchProtections：GET /-/settings/branch-protections，丢弃空 rule', async () => {
    cnbFetchMock.mockResolvedValue([
      { id: '1', rule: 'main', allow_pushes: true },
      { id: '2', rule: '' },
    ])
    const rules = await fetchRepoBranchProtections('org/sub/repo')
    expect(cnbFetchMock).toHaveBeenCalledTimes(1)
    expect(cnbFetchVoidMock).not.toHaveBeenCalled()
    expect(cnbFetchMock.mock.calls[0][0]).toBe(
      '/org/sub/repo/-/settings/branch-protections',
    )
    expect(rules).toHaveLength(1)
    expect(rules[0]).toMatchObject({ id: '1', rule: 'main', allowPushes: true })
  })

  it('fetchRepoBranchProtection：GET 单条，id 编码', async () => {
    cnbFetchMock.mockResolvedValue({ id: 'a/b', rule: 'release/*' })
    const rule = await fetchRepoBranchProtection('org/repo', 'a/b')
    expect(cnbFetchMock.mock.calls[0][0]).toBe(
      '/org/repo/-/settings/branch-protections/a%2Fb',
    )
    expect(rule.rule).toBe('release/*')
  })

  it('createRepoBranchProtection：POST 走 Void，body 不含 id', async () => {
    const payload = createEmptyBranchProtection()
    payload.id = 'should-not-be-sent'
    payload.rule = 'main'
    await createRepoBranchProtection('org/repo', payload)
    expect(cnbFetchVoidMock).toHaveBeenCalledTimes(1)
    expect(cnbFetchMock).not.toHaveBeenCalled()
    const [path, options] = cnbFetchVoidMock.mock.calls[0]
    expect(path).toBe('/org/repo/-/settings/branch-protections')
    expect(options.method).toBe('POST')
    const body = JSON.parse(options.body)
    expect(body.rule).toBe('main')
    expect(body).not.toHaveProperty('id')
    // 21 个可写字段：rule + 18 布尔 + 2 数字
    expect(Object.keys(body)).toHaveLength(21)
  })

  it('updateRepoBranchProtection：PATCH 走 Void，id 编码且不进 body', async () => {
    const payload = createEmptyBranchProtection()
    payload.rule = 'main'
    await updateRepoBranchProtection('org/repo', 'x/y', payload)
    const [path, options] = cnbFetchVoidMock.mock.calls[0]
    expect(path).toBe('/org/repo/-/settings/branch-protections/x%2Fy')
    expect(options.method).toBe('PATCH')
    expect(JSON.parse(options.body)).not.toHaveProperty('id')
  })

  it('deleteRepoBranchProtection：DELETE 走 Void', async () => {
    await deleteRepoBranchProtection('org/repo', '1')
    expect(cnbFetchVoidMock.mock.calls[0][0]).toBe(
      '/org/repo/-/settings/branch-protections/1',
    )
    expect(cnbFetchVoidMock.mock.calls[0][1].method).toBe('DELETE')
  })
})
