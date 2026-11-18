/**
 * T12 数据层单测：仓库成员（REQ-11）。
 *
 * 重点：
 * 1. 三个写端点均 200 空 body → cnbFetchVoid（若误用 cnbFetch 会把成功报成失败）；
 * 2. 仓库路径**逐段编码**，多级路径的 `/` 不能被压成 %2F（踩坑#4）；
 * 3. 权限批量端点复用三形态归一化；继承成员按 inherit_path 分组。
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
  cnbAvatarUrl: (name: string) => `https://avatar/${name}`,
}))

import {
  addRepoMember,
  fetchRepoInheritMembers,
  fetchRepoMembers,
  fetchRepoMembersAccessLevel,
  removeRepoMember,
  updateRepoMemberRole,
} from '../useCnbMembers'

beforeEach(() => {
  cnbFetchMock.mockReset()
  cnbFetchVoidMock.mockReset()
  cnbFetchVoidMock.mockResolvedValue(undefined)
})

describe('仓库成员写端点：200 空 body → cnbFetchVoid', () => {
  it('addRepoMember：POST /{repo}/-/members/{username}，路径逐段编码', async () => {
    await addRepoMember('org/sub/repo', 'a@b.com', 'Developer')
    expect(cnbFetchVoidMock).toHaveBeenCalledTimes(1)
    expect(cnbFetchMock).not.toHaveBeenCalled()
    const [path, options] = cnbFetchVoidMock.mock.calls[0]
    // 多级路径的 '/' 保留，username 单段编码（@ → %40）
    expect(path).toBe('/org/sub/repo/-/members/a%40b.com')
    expect(options.method).toBe('POST')
    expect(JSON.parse(options.body)).toEqual({ access_level: 'Developer' })
  })

  it('updateRepoMemberRole：PUT 走 Void', async () => {
    await updateRepoMemberRole('org/repo', 'alice', 'Master')
    expect(cnbFetchVoidMock).toHaveBeenCalledTimes(1)
    expect(cnbFetchVoidMock.mock.calls[0][1].method).toBe('PUT')
    expect(cnbFetchVoidMock.mock.calls[0][0]).toBe('/org/repo/-/members/alice')
  })

  it('removeRepoMember：DELETE 走 Void', async () => {
    await removeRepoMember('org/repo', 'alice')
    expect(cnbFetchVoidMock).toHaveBeenCalledTimes(1)
    expect(cnbFetchVoidMock.mock.calls[0][1].method).toBe('DELETE')
  })

  it('空用户名抛错（避免把 /members/ 当写目标）', async () => {
    await expect(addRepoMember('org/repo', '', 'Developer')).rejects.toThrow()
  })
})

describe('读端点与归一化', () => {
  it('fetchRepoMembers：列表归一化 + 过滤无用户名条目', async () => {
    cnbFetchMock.mockResolvedValue([
      { username: 'alice', nickname: 'Alice', access_level: 'Master' },
      { username: '' },
    ])
    const members = await fetchRepoMembers('org/repo', { pageSize: 10 })
    expect(members).toHaveLength(1)
    expect(members[0]).toMatchObject({ username: 'alice', accessLevel: 'Master' })
    // 头像缺失时按 CNB 规则兜底
    expect(members[0].avatar).toContain('alice')
  })

  it('fetchRepoMembersAccessLevel：map 形态 → Map<username, level>', async () => {
    cnbFetchMock.mockResolvedValue({
      alice: { access_level: 'Master' },
      bob: { access_level: 'Developer' },
    })
    const map = await fetchRepoMembersAccessLevel('org/repo', false)
    expect(map.get('alice')).toBe('Master')
    expect(map.get('bob')).toBe('Developer')
    expect(cnbFetchMock.mock.calls[0][0]).toBe(
      '/org/repo/-/members/access-level?include_inherit=false',
    )
  })

  it('fetchRepoInheritMembers：按 inherit_path 分组，users 归一化', async () => {
    cnbFetchMock.mockResolvedValue([
      {
        inherit_path: 'org',
        total: 2,
        users: [
          { username: 'alice', nickname: 'Alice', access_level: 'Owner' },
          { user: { username: 'bob', nickname: 'Bob', access_level: 'Master' } },
        ],
      },
    ])
    const groups = await fetchRepoInheritMembers('org/repo')
    expect(groups).toHaveLength(1)
    expect(groups[0].inheritPath).toBe('org')
    expect(groups[0].users.map(u => u.username)).toEqual(['alice', 'bob'])
  })

  it('空仓库路径不发请求', async () => {
    expect(await fetchRepoMembers('')).toEqual([])
    expect(await fetchRepoInheritMembers('')).toEqual([])
    expect(cnbFetchMock).not.toHaveBeenCalled()
  })
})
