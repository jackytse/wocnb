/**
 * useCnbOrg 数据层单测（T13）。
 *
 * 网络层 cnbFetch 全 mock。重点锁定：
 * - 概览归一化：follow_count 缺失 → -1（UI「—」），0 是合法值不混淆；
 * - 仓库墙 PUT：全量有序 string[]（§8.5 排序口径）；
 * - pickAccessLevelForSlug：精确匹配 / 首条回退 / 空兜底；
 * - 继承成员：按 inherit_path 分区 + 人数兜底。
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
    cnbAvatarUrl: (username: string) => `https://cnb.cool/users/${username}/avatar/s`,
    CnbApiError: FakeCnbApiError,
  }
})

import {
  fetchInheritMembers,
  fetchMemberAccessLevel,
  fetchOrgOverview,
  fetchPinnedRepos,
  fetchSubGroups,
  pickAccessLevelForSlug,
  savePinnedRepos,
} from '../useCnbOrg'

beforeEach(() => {
  cnbFetchMock.mockReset()
})

describe('fetchOrgOverview', () => {
  it('follow_count 缺失 → -1（「—」）；0 是合法值', async () => {
    cnbFetchMock.mockResolvedValueOnce({ name: 'org', path: 'org', member_count: 5 })
    const info = await fetchOrgOverview('org')
    expect(info.followCount).toBe(-1)

    cnbFetchMock.mockResolvedValueOnce({ name: 'org', path: 'org', follow_count: 0 })
    expect((await fetchOrgOverview('org')).followCount).toBe(0)
  })

  it('仓库/成员/子组织数字段兜底（all_* 优先，缺省 0）', async () => {
    cnbFetchMock.mockResolvedValueOnce({ path: 'org', all_sub_repo_count: 12, sub_group_count: 2 })
    const info = await fetchOrgOverview('org')
    expect(info.allSubRepoCount).toBe(12)
    expect(info.subGroupCount).toBe(2)
    expect(info.memberCount).toBe(0)
    expect(info.description).toBe('')
  })

  /**
   * access_role → accessRole（**本轮最关键的一行映射**，别删）。
   *
   * 背景：`GET /{group}` 的 schema 是 dto.OrganizationAccess，含 access_role。
   * 早期实现误以为不返回、下钻子组织时把角色置空串，导致 canManage 恒 false
   * —— 用户对自己的子组织三个页签全部只读（2026-11-11 QA 抓到的 P1）。
   * 这条断言是那个缺陷的防回归网：删掉映射这行就会红。
   */
  it('access_role 映射为 accessRole（子组织写入口依赖它）', async () => {
    cnbFetchMock.mockResolvedValueOnce({ path: 'org/sub', access_role: 'Owner' })
    expect((await fetchOrgOverview('org/sub')).accessRole).toBe('Owner')
    // 缺失/空值时归一为空串（canManageRole('') = false，写入口保守隐藏）
    cnbFetchMock.mockResolvedValueOnce({ path: 'org' })
    expect((await fetchOrgOverview('org')).accessRole).toBe('')
  })

  /** 组织信息表单回填的 5 个字段（P2-1：早期只回填 description/site） */
  it('信息表单字段回填：email/domain/remark/wechat_mp/readme_repo_path，缺失归一空串', async () => {
    cnbFetchMock.mockResolvedValueOnce({
      path: 'org',
      email: 'a@b.com',
      domain: 'b.com',
      remark: 'note',
      wechat_mp: 'wx-account',
      readme_repo_path: 'org/readme-repo',
    })
    const info = await fetchOrgOverview('org')
    expect([
      info.email,
      info.domain,
      info.remark,
      info.wechatMp,
      info.readmeRepoPath,
    ]).toEqual(['a@b.com', 'b.com', 'note', 'wx-account', 'org/readme-repo'])

    cnbFetchMock.mockResolvedValueOnce({ path: 'org' })
    const empty = await fetchOrgOverview('org')
    expect([empty.email, empty.domain, empty.remark, empty.wechatMp, empty.readmeRepoPath])
      .toEqual(['', '', '', '', ''])
  })
})

describe('fetchSubGroups', () => {
  it('归一化并过滤无 path 条目', async () => {
    cnbFetchMock.mockResolvedValueOnce([
      { name: 'A', path: 'org/a', member_count: 3, all_sub_repo_count: 9 },
      { name: 'B' },
    ])
    const items = await fetchSubGroups('org')
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ path: 'org/a', allSubRepoCount: 9 })
  })
})

describe('fetchPinnedRepos / savePinnedRepos', () => {
  it('GET 归一化：path/name/star 等兜底', async () => {
    cnbFetchMock.mockResolvedValueOnce([{ path: 'org/r1', star_count: 3, fork_count: 1 }])
    const items = await fetchPinnedRepos('org')
    expect(items[0]).toMatchObject({ path: 'org/r1', name: 'r1', starCount: 3, forkCount: 1 })
  })

  it('PUT 提交全量有序 path 数组（§8.5），返回服务端权威顺序', async () => {
    cnbFetchMock.mockResolvedValueOnce([{ path: 'org/b' }, { path: 'org/a' }])
    const items = await savePinnedRepos('org', ['org/a', 'org/b'])
    const [path, options] = cnbFetchMock.mock.calls[0] as [string, { method: string, body: string }]
    expect(path).toBe('/org/-/pinned-repos')
    expect(options.method).toBe('PUT')
    // 全量 string[]（提交顺序 = 展示顺序，不引入拖拽库的排序口径）
    expect(JSON.parse(options.body)).toEqual(['org/a', 'org/b'])
    expect(items.map(item => item.path)).toEqual(['org/b', 'org/a'])
  })
})

describe('fetchMemberAccessLevel / pickAccessLevelForSlug', () => {
  it('单成员权限归一化（access_level 对象形态兼容）', async () => {
    cnbFetchMock.mockResolvedValueOnce([
      { path: 'org', access_level: { name: 'Owner' } },
    ])
    const levels = await fetchMemberAccessLevel('org', 'alice')
    expect(pickAccessLevelForSlug(levels, 'org')).toBe('Owner')
  })

  it('pickAccessLevelForSlug：无精确匹配回退第一条；空数组兜底空串', () => {
    expect(pickAccessLevelForSlug([{ path: 'other', accessLevel: 'Developer' }], 'org')).toBe('Developer')
    expect(pickAccessLevelForSlug([], 'org')).toBe('')
  })
})

describe('fetchInheritMembers', () => {
  it('按 inherit_path 分区 + 人数兜底（total 缺失取 users.length）', async () => {
    cnbFetchMock.mockResolvedValueOnce([
      {
        inherit_path: 'parent-org',
        users: [{ username: 'u1', nickname: 'U1', access_level: 'Developer' }, { username: 'u2' }],
      },
    ])
    const groups = await fetchInheritMembers('org')
    expect(groups).toHaveLength(1)
    expect(groups[0].inheritPath).toBe('parent-org')
    expect(groups[0].total).toBe(2)
    expect(groups[0].users[0]).toMatchObject({ username: 'u1', accessLevel: 'Developer' })
    // 头像按 CNB 规则兜底
    expect(groups[0].users[1].avatar).toContain('/users/u2/avatar')
  })

  it('过滤掉无来源路径且无成员的空分区', async () => {
    cnbFetchMock.mockResolvedValueOnce([{ inherit_path: '', users: [] }])
    expect(await fetchInheritMembers('org')).toEqual([])
  })
})
