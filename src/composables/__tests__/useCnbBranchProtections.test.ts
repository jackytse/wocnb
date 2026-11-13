/**
 * useCnbBranchProtections 数据层单测（设计文档 §2.8 / §4.2）。
 *
 * 网络层 cnbFetch / cnbFetchVoid 全 mock。重点锁定：
 * - 归一化：缺失字段兜底、显式 false 不丢、两个数字区间 clamp、非对象入参不抛；
 * - 列表：非数组入参 → []、`rule` 为空的条目丢弃（无法展示也无法定位删除）；
 * - 写操作**只发 21 个可写字段且不含 id**（swagger 的 api.BranchProtection 共
 *   22 个属性，id 只读）；
 * - 写操作必须走 cnbFetchVoid（200 空 body，用 cnbFetch 会把成功报成失败）；
 * - id 走路径段并 encodeURIComponent（id 可能含 `/`、`#`、空格）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const cnbFetchMock = vi.fn()
const cnbFetchVoidMock = vi.fn()

vi.mock('../useCnbAuth', () => ({
  cnbFetch: (...args: unknown[]) => cnbFetchMock(...args),
  cnbFetchVoid: (...args: unknown[]) => cnbFetchVoidMock(...args),
}))

import {
  BRANCH_PROTECTION_LIMIT,
  buildBranchProtectionBody,
  createBranchProtection,
  createEmptyBranchProtection,
  deleteBranchProtection,
  fetchBranchProtections,
  normalizeBranchProtection,
  updateBranchProtection,
} from '../useCnbBranchProtections'

/**
 * 写操作请求体的期望键集合（21 个可写字段，snake_case）。
 * 顺序无关，比较前排序。
 */
const EXPECTED_BODY_KEYS = [
  'allow_creation',
  'allow_deletions',
  'allow_force_pushes',
  'allow_master_creation',
  'allow_master_deletions',
  'allow_master_force_pushes',
  'allow_master_manual_merge',
  'allow_master_pushes',
  'allow_pushes',
  'forbid_approve_pull_created_by_own_npc',
  'required_approved_review_count',
  'required_approved_review_ratio',
  'required_codeowner_approve',
  'required_linear_history',
  'required_master_approve',
  'required_must_auto_merge',
  'required_must_push_via_pull_request',
  'required_npc_approve',
  'required_pull_request_reviews',
  'required_status_checks',
  'rule',
].sort()

beforeEach(() => {
  cnbFetchMock.mockReset()
  cnbFetchVoidMock.mockReset()
})

describe('BRANCH_PROTECTION_LIMIT', () => {
  it('每个组织最多 10 条规则（swagger 原文）', () => {
    expect(BRANCH_PROTECTION_LIMIT).toBe(10)
  })
})

describe('normalizeBranchProtection', () => {
  it('缺失字段兜底：布尔 false、数字 clamp 到合法下限、id/rule 空串', () => {
    const rule = normalizeBranchProtection({})
    expect(rule.id).toBe('')
    expect(rule.rule).toBe('')
    expect(rule.allowPushes).toBe(false)
    expect(rule.forbidApprovePullCreatedByOwnNpc).toBe(false)
    // 缺失 → 0 → clamp 到下限（1 / 1），保证回填进表单是合法值
    expect(rule.requiredApprovedReviewCount).toBe(1)
    expect(rule.requiredApprovedReviewRatio).toBe(1)
  })

  it('显式 false 与 true 都原样保留（false 不被默认值覆盖）', () => {
    const rule = normalizeBranchProtection({
      id: 'rule-1',
      rule: 'main',
      allow_pushes: true,
      allow_creation: false,
      required_must_push_via_pull_request: true,
      required_linear_history: false,
    })
    expect(rule.allowPushes).toBe(true)
    expect(rule.allowCreation).toBe(false)
    expect(rule.requiredMustPushViaPullRequest).toBe(true)
    expect(rule.requiredLinearHistory).toBe(false)
  })

  it('布尔只认严格 true（字符串 "true" / 1 一律按 false）', () => {
    const rule = normalizeBranchProtection({ allow_pushes: 'true', allow_deletions: 1 })
    expect(rule.allowPushes).toBe(false)
    expect(rule.allowDeletions).toBe(false)
  })

  it('评审人数超上限 / 越下限 clamp 到 [1,5]', () => {
    expect(normalizeBranchProtection({ required_approved_review_count: 99 }).requiredApprovedReviewCount).toBe(5)
    expect(normalizeBranchProtection({ required_approved_review_count: 0 }).requiredApprovedReviewCount).toBe(1)
    expect(normalizeBranchProtection({ required_approved_review_count: -3 }).requiredApprovedReviewCount).toBe(1)
    expect(normalizeBranchProtection({ required_approved_review_count: 3 }).requiredApprovedReviewCount).toBe(3)
  })

  it('通过率 clamp 到 [1,100]，非数字兜底 1', () => {
    expect(normalizeBranchProtection({ required_approved_review_ratio: 250 }).requiredApprovedReviewRatio).toBe(100)
    expect(normalizeBranchProtection({ required_approved_review_ratio: 'abc' }).requiredApprovedReviewRatio).toBe(1)
    expect(normalizeBranchProtection({ required_approved_review_ratio: 80 }).requiredApprovedReviewRatio).toBe(80)
  })

  it('入参非对象（null / 字符串 / 数字）不抛错', () => {
    for (const raw of [null, undefined, 'x', 42, []]) {
      const rule = normalizeBranchProtection(raw)
      expect(rule.rule).toBe('')
      expect(rule.allowPushes).toBe(false)
    }
  })
})

describe('buildBranchProtectionBody', () => {
  it('只产出 21 个可写字段，且不含 id', () => {
    const body = buildBranchProtectionBody({ ...createEmptyBranchProtection(), id: 'should-be-ignored', rule: 'main' })
    expect(Object.keys(body).sort()).toEqual(EXPECTED_BODY_KEYS)
    expect(body).not.toHaveProperty('id')
    expect(body.rule).toBe('main')
  })

  it('数字字段在请求体里再 clamp 一次（防调用方绕过表单校验）', () => {
    const body = buildBranchProtectionBody({
      ...createEmptyBranchProtection(),
      rule: 'main',
      requiredApprovedReviewCount: 42,
      requiredApprovedReviewRatio: -1,
    })
    expect(body.required_approved_review_count).toBe(5)
    expect(body.required_approved_review_ratio).toBe(1)
  })
})

describe('fetchBranchProtections', () => {
  it('GET 根组织的规则列表并归一化为 camelCase', async () => {
    cnbFetchMock.mockResolvedValueOnce([
      {
        id: 'r1',
        rule: 'main',
        allow_pushes: true,
        required_approved_review_count: 2,
        required_approved_review_ratio: 60,
      },
    ])
    const rules = await fetchBranchProtections('org')
    const [path] = cnbFetchMock.mock.calls[0] as [string]
    expect(path).toBe('/org/-/git-group-settings/branch-protections')
    expect(rules).toHaveLength(1)
    expect(rules[0]).toMatchObject({
      id: 'r1',
      rule: 'main',
      allowPushes: true,
      requiredApprovedReviewCount: 2,
      requiredApprovedReviewRatio: 60,
    })
  })

  it('非数组入参 → []（对象包裹 / null / 空 body 都按空态处理）', async () => {
    for (const raw of [null, undefined, {}, { data: [] }]) {
      cnbFetchMock.mockResolvedValueOnce(raw)
      expect(await fetchBranchProtections('org')).toEqual([])
    }
  })

  it('rule 为空的条目被丢弃（无法展示，也无法定位删除目标）', async () => {
    cnbFetchMock.mockResolvedValueOnce([
      { id: 'r1', rule: 'main' },
      { id: 'r2' },
      {},
    ])
    const rules = await fetchBranchProtections('org')
    expect(rules.map(item => item.id)).toEqual(['r1'])
  })

  it('空 slug 不发请求', async () => {
    expect(await fetchBranchProtections('')).toEqual([])
    expect(cnbFetchMock).not.toHaveBeenCalled()
  })

  it('slug 逐段编码（子组织路径的 `/` 保留为分隔符）', async () => {
    cnbFetchMock.mockResolvedValueOnce([])
    await fetchBranchProtections('my org/sub')
    const [path] = cnbFetchMock.mock.calls[0] as [string]
    expect(path).toBe('/my%20org/sub/-/git-group-settings/branch-protections')
  })
})

describe('写操作（必须走 cnbFetchVoid：200 空 body）', () => {
  it('createBranchProtection：POST + 只发 21 个可写字段 + 不含 id', async () => {
    cnbFetchVoidMock.mockResolvedValueOnce(undefined)
    await createBranchProtection('org', { ...createEmptyBranchProtection(), id: 'server-generated', rule: 'release/*' })

    const [path, options] = cnbFetchVoidMock.mock.calls[0] as [string, { method: string, body: string }]
    expect(path).toBe('/org/-/git-group-settings/branch-protections')
    expect(options.method).toBe('POST')
    const body = JSON.parse(options.body) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(EXPECTED_BODY_KEYS)
    expect(body).not.toHaveProperty('id')
    expect(body.rule).toBe('release/*')
    // 空 body 端点绝不能走 JSON 通道（否则成功会被报成 "Unexpected end of JSON input"）
    expect(cnbFetchMock).not.toHaveBeenCalled()
  })

  it('updateBranchProtection：PATCH + id 走路径段且编码 + 请求体不含 id', async () => {
    cnbFetchVoidMock.mockResolvedValueOnce(undefined)
    await updateBranchProtection('org', 'a/b#c d', { ...createEmptyBranchProtection(), id: 'a/b#c d', rule: 'main' })

    const [path, options] = cnbFetchVoidMock.mock.calls[0] as [string, { method: string, body: string }]
    expect(path).toBe(`/org/-/git-group-settings/branch-protections/${encodeURIComponent('a/b#c d')}`)
    expect(path).toContain('a%2Fb%23c%20d')
    expect(options.method).toBe('PATCH')
    const body = JSON.parse(options.body) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(EXPECTED_BODY_KEYS)
    expect(body).not.toHaveProperty('id')
    expect(cnbFetchMock).not.toHaveBeenCalled()
  })

  it('deleteBranchProtection：DELETE + id 编码', async () => {
    cnbFetchVoidMock.mockResolvedValueOnce(undefined)
    await deleteBranchProtection('org', 'rule:1/2 #a')

    const [path, options] = cnbFetchVoidMock.mock.calls[0] as [string, { method: string }]
    expect(path).toBe(`/org/-/git-group-settings/branch-protections/${encodeURIComponent('rule:1/2 #a')}`)
    expect(options.method).toBe('DELETE')
    // DELETE 无请求体
    expect((options as { body?: string }).body).toBeUndefined()
    expect(cnbFetchMock).not.toHaveBeenCalled()
  })

  it('写操作错误原样抛出（403/422 由调用方决定文案）', async () => {
    const failure = Object.assign(new Error('每个组织最多可创建 10 条规则'), { status: 422 })
    cnbFetchVoidMock.mockRejectedValueOnce(failure)
    await expect(createBranchProtection('org', createEmptyBranchProtection())).rejects.toMatchObject({ status: 422 })
  })
})

describe('createEmptyBranchProtection', () => {
  it('默认值落在服务端合法区间内（直接提交不会被 422）', () => {
    const rule = createEmptyBranchProtection()
    expect(rule.id).toBe('')
    expect(rule.rule).toBe('')
    expect(rule.requiredApprovedReviewCount).toBe(1)
    expect(rule.requiredApprovedReviewRatio).toBe(100)
    // 默认不放行任何推送/删除能力（最严格策略）
    expect(rule.allowPushes).toBe(false)
    expect(rule.allowDeletions).toBe(false)
    expect(rule.allowForcePushes).toBe(false)
  })
})
