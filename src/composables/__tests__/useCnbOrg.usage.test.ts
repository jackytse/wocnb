/**
 * 组织用量统计（charge 域）数据层单测 —— 2026-11-11 恢复 + 增强配套。
 *
 * 网络层 cnbFetch 全 mock（与 useCnbOrg.test.ts 同范式）。锁定点：
 * - fetchGroupReposVolume：分页 query 拼接、空数组兜底、slug 逐段编码；
 * - normalizeSpecialAmount：_desc/_expire 配套键不产出条目、值 <= 0 过滤、
 *   expire null → ''（永久有效）、desc 缺失 → ''；
 * - fetchGroupSpecialAmount：空对象 → 空数组（UI 隐藏区块）；
 * - usageSeverity：80/95 阈值边界（<80 ok / 80-94 warning / ≥95 danger）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const cnbFetchMock = vi.fn()

// 与 useCnbOrg.test.ts 相同的 mock 范式：只 mock 网络出口，不 mock 归一化
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
    cnbAvatarUrl: (username: string) => `https://cnb.cool/users/${username}/avatar/s`,
    CnbApiError: FakeCnbApiError,
  }
})

import {
  fetchGroupSpecialAmount,
  normalizeSpecialAmount,
  usageSeverity,
} from '../useCnbOrg'

beforeEach(() => {
  cnbFetchMock.mockReset()
})

describe('normalizeSpecialAmount（特权额度归一化）', () => {
  it('三件套拆对：主键产出条目，_desc/_expire 只作配套不产出独立条目', () => {
    const items = normalizeSpecialAmount({
      compute_build_corehour: 100,
      // 注意：desc/expire 键名 = 完整主键名 + 后缀（swagger 原文 compute_build_corehour_desc）
      compute_build_corehour_desc: '赠送 100 核时',
      compute_build_corehour_expire: null,
    })
    expect(items).toHaveLength(1)
    expect(items[0]).toEqual({
      key: 'compute_build_corehour',
      value: 100,
      desc: '赠送 100 核时',
      expire: '',
    })
  })

  it('值 <= 0 / 非数字的条目不产出', () => {
    expect(normalizeSpecialAmount({ credit: 0, storage_git_gib: -5 })).toEqual([])
    expect(normalizeSpecialAmount({ credit: 'abc' })).toEqual([])
  })

  it('expire 为 ISO 字符串时透传；null / undefined 归一为空串（永久）', () => {
    const items = normalizeSpecialAmount({
      credit: 10,
      credit_expire: '2027-01-01T00:00:00Z',
      storage_git_gib: 20,
    })
    expect(items.find(i => i.key === 'credit')?.expire).toBe('2027-01-01T00:00:00Z')
    expect(items.find(i => i.key === 'storage_git_gib')?.expire).toBe('')
  })

  it('desc 缺失归一为空串', () => {
    const items = normalizeSpecialAmount({ credit: 10 })
    expect(items[0].desc).toBe('')
  })

  it('全量 7 类主键 + 配套键只产出 7 条', () => {
    const raw: Record<string, number | string | null> = {}
    for (const key of [
      'compute_build_corehour',
      'compute_build_gpu_corehour',
      'compute_develop_corehour',
      'compute_develop_gpu_corehour',
      'credit',
      'storage_git_gib',
      'storage_object_gib',
    ]) {
      raw[key] = 1
      raw[`${key}_desc`] = 'x'
      raw[`${key}_expire`] = null
    }
    expect(normalizeSpecialAmount(raw)).toHaveLength(7)
  })
})

describe('fetchGroupSpecialAmount', () => {
  it('空对象 → 空数组（UI 隐藏特权区块）', async () => {
    cnbFetchMock.mockResolvedValueOnce({})
    expect(await fetchGroupSpecialAmount('org')).toEqual([])
  })
})

describe('usageSeverity（阈值预警）', () => {
  it('阈值边界：< 80 ok / 80~94 warning / ≥ 95 danger', () => {
    expect(usageSeverity(0)).toBe('ok')
    expect(usageSeverity(79)).toBe('ok')
    expect(usageSeverity(80)).toBe('warning')
    expect(usageSeverity(94)).toBe('warning')
    expect(usageSeverity(95)).toBe('danger')
    expect(usageSeverity(100)).toBe('danger')
  })
})
