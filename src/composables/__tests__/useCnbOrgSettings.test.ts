/**
 * useCnbOrgSettings 数据层单测（设计文档 §2.1 / §2.2 / §4.1）。
 *
 * 网络层 cnbFetch / cnbFetchVoid 全 mock（参考 useCnbOrg.test.ts 的写法）。
 * 重点锁定四类"错了就是数据事故"的行为：
 * 1. 归一化防御：服务端字段缺失、整型 0/1 与 boolean 混用、values 逗号串；
 * 2. 请求体白名单：GroupSettingReq 只允许 8 个字段（can_show_* / root_* 是只读位）；
 * 3. 增量提交：updateOrgProfile 只提交用户真正填写的键（空串=主动清空要保留）；
 * 4. 空 body 写端点走 cnbFetchVoid（走 cnbFetch 会把成功报成失败）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const cnbFetchMock = vi.fn()
const cnbFetchVoidMock = vi.fn()

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
    cnbFetchVoid: (...args: unknown[]) => cnbFetchVoidMock(...args),
    CnbApiError: FakeCnbApiError,
  }
})

import {
  buildCreateGroupBody,
  buildGroupSettingBody,
  buildUpdateGroupBody,
  createGroup,
  fetchOrgSettings,
  normalizeOrgSettings,
  saveOrgSettings,
  SETTING_VALUES,
  SETTING_VALUE_GROUPS,
  transferGroup,
  updateOrgProfile,
  type OrgSettings,
} from '../useCnbOrgSettings'

beforeEach(() => {
  cnbFetchMock.mockReset()
  cnbFetchVoidMock.mockReset()
  cnbFetchVoidMock.mockResolvedValue(undefined)
})

/** 取第 n 次 cnbFetchVoid 调用的 [path, options] */
function voidCall(index = 0): [string, { method?: string, body?: string }] {
  return cnbFetchVoidMock.mock.calls[index] as [string, { method?: string, body?: string }]
}

/** 构造一个全开的设置对象（覆盖写场景下最容易暴露字段遗漏） */
function fullSettings(): OrgSettings {
  return {
    hideMembers: true,
    hideSubGroups: true,
    showPrivateRepoWatermark: true,
    groupProtection: true,
    emailVerification: ['example.com', 'corp.example.com'],
    npcPriceLimit: 1200,
    visitorNpcPriceLimit: 300,
    values: ['disable_invitation', 'prevent_repository_creation'],
    canShowMembers: true,
    canShowSubGroups: true,
    canShowWatermark: true,
    rootGroupProtection: false,
    rootNpcPriceLimit: 5000,
  }
}

describe('SETTING_VALUES 清单', () => {
  it('共 33 个组织策略枚举（swagger organization.SettingValue.enum 实测），且无重复', () => {
    expect(SETTING_VALUES).toHaveLength(33)
    expect(new Set(SETTING_VALUES).size).toBe(SETTING_VALUES.length)
  })

  it('分组覆盖全部枚举（8 组，组内无重复、组间不重叠）', () => {
    expect(SETTING_VALUE_GROUPS).toHaveLength(8)
    const grouped = SETTING_VALUE_GROUPS.flatMap(group => group.values)
    expect(grouped).toHaveLength(SETTING_VALUES.length)
    expect(new Set(grouped).size).toBe(SETTING_VALUES.length)
  })
})

describe('normalizeOrgSettings', () => {
  it('字段全部缺失：布尔 false、数组 []、数字 0，不抛错', () => {
    const settings = normalizeOrgSettings({})
    expect(settings).toMatchObject({
      hideMembers: false,
      hideSubGroups: false,
      showPrivateRepoWatermark: false,
      groupProtection: false,
      emailVerification: [],
      npcPriceLimit: 0,
      visitorNpcPriceLimit: 0,
      values: [],
    })
  })

  it('非对象入参（null / 字符串）一律按全默认处理', () => {
    expect(normalizeOrgSettings(null).hideMembers).toBe(false)
    expect(normalizeOrgSettings('oops').values).toEqual([])
    expect(normalizeOrgSettings(undefined).emailVerification).toEqual([])
  })

  it('整型 0/1 与 boolean 混用都能归一（hide_members=1 → true，0/1 字符串亦兼容）', () => {
    const settings = normalizeOrgSettings({
      hide_members: 1,
      hide_sub_groups: 0,
      group_protection: true,
      show_private_repo_watermark: '1',
    })
    expect(settings.hideMembers).toBe(true)
    expect(settings.hideSubGroups).toBe(false)
    expect(settings.groupProtection).toBe(true)
    expect(settings.showPrivateRepoWatermark).toBe(true)
  })

  it('values 是逗号串 → 拆分 + trim + 去空 + 去重', () => {
    const settings = normalizeOrgSettings({
      values: 'disable_invitation, prevent_repository_creation ,, disable_invitation',
    })
    expect(settings.values).toEqual(['disable_invitation', 'prevent_repository_creation'])
  })

  it('values 已是数组时同样兼容（网关版本差异防御）', () => {
    expect(normalizeOrgSettings({ values: ['a', 'b'] }).values).toEqual(['a', 'b'])
  })

  it('email_verification 非数组 → []；数组则 trim + 去空 + 去重', () => {
    expect(normalizeOrgSettings({ email_verification: 'example.com' }).emailVerification).toEqual([])
    expect(normalizeOrgSettings({}).emailVerification).toEqual([])
    expect(normalizeOrgSettings({
      email_verification: [' a@b.com ', '', 42, 'a@b.com'],
    }).emailVerification).toEqual(['a@b.com'])
  })

  it('金额上限：数字字符串转 int、负数/非法按 0（0 = 不限是合法值）', () => {
    const settings = normalizeOrgSettings({
      npc_price_limit: '1500',
      visitor_npc_price_limit: -20,
      root_npc_price_limit: 'abc',
    })
    expect(settings.npcPriceLimit).toBe(1500)
    expect(settings.visitorNpcPriceLimit).toBe(0)
    expect(settings.rootNpcPriceLimit).toBe(0)
  })

  it('can_show_* 缺失按「无限制」（true）处理，显式 false 则保留', () => {
    expect(normalizeOrgSettings({}).canShowMembers).toBe(true)
    const restricted = normalizeOrgSettings({
      can_show_members: false,
      can_show_sub_groups: false,
      can_show_watermark: false,
    })
    expect(restricted.canShowMembers).toBe(false)
    expect(restricted.canShowSubGroups).toBe(false)
    expect(restricted.canShowWatermark).toBe(false)
  })
})

describe('buildGroupSettingBody', () => {
  it('只包含 dto.GroupSettingReq 的 8 个字段（不夹带 can_show_* / root_* 只读位）', () => {
    const body = buildGroupSettingBody(fullSettings())
    expect(Object.keys(body).sort()).toEqual([
      'email_verification',
      'group_protection',
      'hide_members',
      'hide_sub_groups',
      'npc_price_limit',
      'show_private_repo_watermark',
      'values',
      'visitor_npc_price_limit',
    ])
  })

  it('boolean 转 0/1；values 数组拼成逗号串；金额原样提交', () => {
    const body = buildGroupSettingBody(fullSettings())
    expect(body).toEqual({
      hide_members: 1,
      hide_sub_groups: 1,
      show_private_repo_watermark: 1,
      group_protection: 1,
      email_verification: ['example.com', 'corp.example.com'],
      npc_price_limit: 1200,
      visitor_npc_price_limit: 300,
      values: 'disable_invitation,prevent_repository_creation',
    })
  })

  it('全关 + 空集合 → 0 与空串（覆盖写语义：清空也要显式提交）', () => {
    const body = buildGroupSettingBody(normalizeOrgSettings({}))
    expect(body).toMatchObject({
      hide_members: 0,
      values: '',
      email_verification: [],
    })
  })

  it('values 重复项去重、金额负数归零', () => {
    const settings = fullSettings()
    settings.values = ['a', 'a', 'b']
    settings.npcPriceLimit = -5
    const body = buildGroupSettingBody(settings)
    expect(body.values).toBe('a,b')
    expect(body.npc_price_limit).toBe(0)
  })
})

describe('fetchOrgSettings', () => {
  it('GET /{slug}/-/settings 并归一化响应', async () => {
    cnbFetchMock.mockResolvedValueOnce({ hide_members: 1, values: 'disable_invitation' })
    const settings = await fetchOrgSettings('org')
    expect(cnbFetchMock.mock.calls[0][0]).toBe('/org/-/settings')
    expect(settings.hideMembers).toBe(true)
    expect(settings.values).toEqual(['disable_invitation'])
  })

  it('多级子组织路径逐段编码，保留 "/"（整体编码会 404）', async () => {
    cnbFetchMock.mockResolvedValueOnce({})
    await fetchOrgSettings('parent/sub group')
    expect(cnbFetchMock.mock.calls[0][0]).toBe('/parent/sub%20group/-/settings')
  })
})

describe('saveOrgSettings', () => {
  it('走 cnbFetchVoid（空 body 端点）并全量提交当前设置', async () => {
    await saveOrgSettings('org', fullSettings())
    const [path, options] = voidCall()
    expect(path).toBe('/org/-/settings')
    expect(options.method).toBe('PUT')
    expect(JSON.parse(options.body ?? '{}')).toEqual(buildGroupSettingBody(fullSettings()))
    expect(cnbFetchMock).not.toHaveBeenCalled()
  })
})

describe('updateOrgProfile 增量语义（设计文档 §2.1）', () => {
  it('只填 description 时请求体只有 description 一个键', async () => {
    await updateOrgProfile('org', { description: '新描述' })
    const [path, options] = voidCall()
    expect(path).toBe('/org')
    expect(options.method).toBe('PUT')
    expect(JSON.parse(options.body ?? '{}')).toEqual({ description: '新描述' })
  })

  it('空串是用户主动清空 → 必须保留在请求体（email 清空场景）', async () => {
    await updateOrgProfile('org', { email: '' })
    expect(JSON.parse(voidCall()[1].body ?? '{}')).toEqual({ email: '' })
  })

  it('未传的键（undefined）绝不出现 —— 否则会清空线上已有邮箱/域名', async () => {
    await updateOrgProfile('org', { site: 'https://example.com', domain: undefined })
    const body = JSON.parse(voidCall()[1].body ?? '{}')
    expect(Object.keys(body)).toEqual(['site'])
  })

  it('camelCase → snake_case 映射（wechatMp / readmeRepoPath）', () => {
    expect(buildUpdateGroupBody({ wechatMp: 'mp', readmeRepoPath: 'org/readme' })).toEqual({
      wechat_mp: 'mp',
      readme_repo_path: 'org/readme',
    })
  })

  it('没有任何改动时不发请求（空 body PUT 无意义且可能误清空）', async () => {
    await updateOrgProfile('org', {})
    expect(cnbFetchVoidMock).not.toHaveBeenCalled()
  })
})

describe('createGroup', () => {
  it('body 只放有值字段，path 必填并 trim', async () => {
    await createGroup({ path: ' parent/new-group ', description: '描述', remark: '' })
    const [path, options] = voidCall()
    expect(path).toBe('/groups')
    expect(options.method).toBe('POST')
    expect(JSON.parse(options.body ?? '{}')).toEqual({
      path: 'parent/new-group',
      description: '描述',
    })
  })

  it('bindDomain → bind_domain', () => {
    expect(buildCreateGroupBody({ path: 'o/n', bindDomain: 'example.com' })).toEqual({
      path: 'o/n',
      bind_domain: 'example.com',
    })
  })

  it('path 为空属编程错误 → 抛错且不发请求', async () => {
    await expect(createGroup({ path: '   ' })).rejects.toThrow()
    expect(cnbFetchVoidMock).not.toHaveBeenCalled()
  })
})

describe('transferGroup', () => {
  it('POST /{group}/-/transfer，body 为 { source, target }', async () => {
    await transferGroup('org/sub', ' new-parent ')
    const [path, options] = voidCall()
    expect(path).toBe('/org/sub/-/transfer')
    expect(options.method).toBe('POST')
    expect(JSON.parse(options.body ?? '{}')).toEqual({ source: 'org/sub', target: 'new-parent' })
  })
})
