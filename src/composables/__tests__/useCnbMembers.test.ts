/**
 * useCnbMembers 数据层单测。
 *
 * 回归背景（线上缺陷）：成员页「外部贡献者」页签传的是**组织路径**，
 * CNB 网关返回 `400 This feature is not supported for organizations.`，
 * 页面显示成红色「加载失败」。本单测锁定三件事：
 * 1. 仓库路径按段编码（`/` 保留），整体编码会让网关路由不到仓库资源；
 * 2. 归一化兜底（access_level 两种形态、avatar 缺省、空 username 过滤）；
 * 3. 「组织不支持」判定只认服务端那句固定 errmsg，不误伤其他错误。
 *
 * 写操作增量（组织能力扩展 §2.5 / §2.6 / §2.7）另外锁定：
 * 4. 三个成员写端点的方法（POST / PUT / DELETE）与 body（access_level）正确；
 * 5. 空 body 端点一律走 `cnbFetchVoid` —— 走 `cnbFetch` 会把成功报成失败；
 * 6. username 作为路径段必须 `encodeURIComponent`（`.` `@` 等字符）；
 * 7. 外部贡献者 role 走 **query**、路径是 org/repo（传组织路径必 400）；
 * 8. 批量权限兼容 map / 数组 / 单对象三种形态（单对象降级为空 Map）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const cnbFetchMock = vi.fn()
const cnbFetchVoidMock = vi.fn()

vi.mock('../useCnbAuth', () => ({
  cnbFetch: (...args: unknown[]) => cnbFetchMock(...args),
  // 空 body 写端点专用通道（cnbFetch 会在 response.json() 上把成功当失败）
  cnbFetchVoid: (...args: unknown[]) => cnbFetchVoidMock(...args),
  cnbAvatarUrl: (username: string) => `https://cnb.cool/users/${username}/avatar/s`,
}))

import {
  addGroupMember,
  encodeSlugPath,
  fetchGroupMembers,
  fetchGroupMembersAccessLevel,
  fetchOutsideCollaborators,
  isOutsideCollaboratorsUnsupported,
  MEMBER_ROLES,
  normalizeMemberAccessLevel,
  OUTSIDE_COLLABORATOR_ROLES,
  removeGroupMember,
  removeOutsideCollaborator,
  updateGroupMemberRole,
  updateOutsideCollaborator,
} from '../useCnbMembers'

beforeEach(() => {
  cnbFetchMock.mockReset()
  cnbFetchVoidMock.mockReset()
})

describe('encodeSlugPath', () => {
  it('保留层级分隔符 /，只对每段转义', () => {
    expect(encodeSlugPath('my-group/my-repo')).toBe('my-group/my-repo')
    // 多级子组织：层级必须完整保留
    expect(encodeSlugPath('a/b/c')).toBe('a/b/c')
  })

  it('转义每段中的特殊字符（空格 / # / ?）', () => {
    expect(encodeSlugPath('my group/re po')).toBe('my%20group/re%20po')
    expect(encodeSlugPath('g/r#1')).toBe('g/r%231')
    expect(encodeSlugPath('g/r?x=1')).toBe('g/r%3Fx%3D1')
  })

  it('忽略首尾与重复的斜杠（防御用户/接口给脏路径）', () => {
    expect(encodeSlugPath('/g/r/')).toBe('g/r')
    expect(encodeSlugPath('g//r')).toBe('g/r')
  })

  it('不再把 / 压成 %2F（历史缺陷：整体 encodeURIComponent）', () => {
    expect(encodeSlugPath('g/r')).not.toContain('%2F')
  })
})

describe('fetchGroupMembers', () => {
  it('请求组织成员端点并归一化（access_level 字符串）', async () => {
    cnbFetchMock.mockResolvedValueOnce([
      { username: 'alice', nickname: 'Alice', access_level: 'Master', join_time: '2026-01-01T00:00:00Z' },
    ])
    const list = await fetchGroupMembers('my-group')
    expect(cnbFetchMock.mock.calls[0][0]).toContain('/my-group/-/members?')
    expect(list).toEqual([
      {
        username: 'alice',
        nickname: 'Alice',
        avatar: 'https://cnb.cool/users/alice/avatar/s',
        accessLevel: 'Master',
        joinTime: '2026-01-01T00:00:00Z',
      },
    ])
  })

  it('多级子组织按段编码，路径层级完整', async () => {
    cnbFetchMock.mockResolvedValueOnce([])
    await fetchGroupMembers('outer/inner')
    expect(cnbFetchMock.mock.calls[0][0]).toContain('/outer/inner/-/members?')
  })

  it('access_level 为对象时取 name；nickname 缺失回退 username；空 username 过滤', async () => {
    cnbFetchMock.mockResolvedValueOnce([
      { username: 'bob', access_level: { name: 'Developer' } },
      { username: '', nickname: 'ghost' },
    ])
    const list = await fetchGroupMembers('g')
    expect(list).toHaveLength(1)
    expect(list[0].accessLevel).toBe('Developer')
    expect(list[0].nickname).toBe('bob')
  })

  it('响应非数组时返回空数组（不抛错）', async () => {
    cnbFetchMock.mockResolvedValueOnce({ errcode: 0 })
    await expect(fetchGroupMembers('g')).resolves.toEqual([])
  })
})

describe('fetchOutsideCollaborators', () => {
  it('请求仓库级端点，路径为「组织/仓库」且带分页参数', async () => {
    cnbFetchMock.mockResolvedValueOnce([])
    await fetchOutsideCollaborators('my-group/my-repo', { page: 2, pageSize: 20, search: 'tom' })
    const url = cnbFetchMock.mock.calls[0][0] as string
    expect(url.startsWith('/my-group/my-repo/-/outside-collaborators?')).toBe(true)
    expect(url).toContain('page=2')
    expect(url).toContain('page_size=20')
    expect(url).toContain('search=tom')
  })

  it('组织路径不会被悄悄改写（调用方必须传仓库路径 —— 见函数注释）', async () => {
    cnbFetchMock.mockResolvedValueOnce([])
    await fetchOutsideCollaborators('my-group')
    // 函数不做"猜仓库"的魔法：仍然是组织路径，服务端会 400，由 UI 降级处理
    expect(cnbFetchMock.mock.calls[0][0]).toContain('/my-group/-/outside-collaborators?')
  })
})

describe('isOutsideCollaboratorsUnsupported', () => {
  it('命中服务端固定 errmsg（大小写不敏感）', () => {
    const err = new Error(
      'CNB API 请求失败: 400，服务器返回：This feature is not supported for organizations.',
    )
    expect(isOutsideCollaboratorsUnsupported(err)).toBe(true)
    expect(isOutsideCollaboratorsUnsupported(new Error('THIS FEATURE IS NOT SUPPORTED FOR ORGANIZATIONS'))).toBe(true)
  })

  it('其他错误不误判（403 缺权限 / 404 / 网络）', () => {
    expect(isOutsideCollaboratorsUnsupported(new Error('CNB API 请求失败: 403，服务器返回：Forbidden'))).toBe(false)
    expect(isOutsideCollaboratorsUnsupported(new Error('not supported for repositories'))).toBe(false)
    expect(isOutsideCollaboratorsUnsupported(null)).toBe(false)
    expect(isOutsideCollaboratorsUnsupported(undefined)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 写操作 · 角色枚举
// ---------------------------------------------------------------------------

describe('角色枚举', () => {
  it('MEMBER_ROLES 为五档且首字母大写（服务端大小写敏感）', () => {
    expect([...MEMBER_ROLES]).toEqual(['Guest', 'Reporter', 'Developer', 'Master', 'Owner'])
  })

  it('OUTSIDE_COLLABORATOR_ROLES 只有三档（无 Master / Owner）', () => {
    expect([...OUTSIDE_COLLABORATOR_ROLES]).toEqual(['Guest', 'Reporter', 'Developer'])
  })
})

// ---------------------------------------------------------------------------
// 写操作 · 组织直属成员（POST / PUT / DELETE /{group}/-/members/{username}）
// ---------------------------------------------------------------------------

describe('addGroupMember', () => {
  it('POST 成员端点，body 为 { access_level }，且走 cnbFetchVoid（空 body 通道）', async () => {
    cnbFetchVoidMock.mockResolvedValueOnce(undefined)
    await addGroupMember('my-group', 'alice', 'Developer')

    // 空 body 端点禁止走 JSON 通道：cnbFetch 会在 response.json() 抛
    // "Unexpected end of JSON input"，把成功报成失败
    expect(cnbFetchMock).not.toHaveBeenCalled()
    const [path, options] = cnbFetchVoidMock.mock.calls[0] as [string, RequestInit]
    expect(path).toBe('/my-group/-/members/alice')
    expect(options.method).toBe('POST')
    expect(JSON.parse(String(options.body))).toEqual({ access_level: 'Developer' })
  })

  it('勾选外部协作者时 body 带 is_outside_collaborator=true', async () => {
    cnbFetchVoidMock.mockResolvedValueOnce(undefined)
    await addGroupMember('g', 'bob', 'Guest', { isOutsideCollaborator: true })
    const body = JSON.parse(String((cnbFetchVoidMock.mock.calls[0] as [string, RequestInit])[1].body))
    expect(body).toEqual({ access_level: 'Guest', is_outside_collaborator: true })
  })

  it('未勾选时不带该键（缺省语义是「不改动」，传 false 会清除已有标记）', async () => {
    cnbFetchVoidMock.mockResolvedValueOnce(undefined)
    await addGroupMember('g', 'bob', 'Guest')
    const body = JSON.parse(String((cnbFetchVoidMock.mock.calls[0] as [string, RequestInit])[1].body))
    expect(body).toEqual({ access_level: 'Guest' })
    expect(Object.keys(body)).not.toContain('is_outside_collaborator')
  })

  it('多级子组织逐段编码 + username 里的 . 与 @ 被转义', async () => {
    cnbFetchVoidMock.mockResolvedValueOnce(undefined)
    await addGroupMember('outer/inner', 'a.b@example.com', 'Reporter')
    const [path] = cnbFetchVoidMock.mock.calls[0] as [string]
    expect(path).toBe('/outer/inner/-/members/a.b%40example.com')
    // `/` 仍是层级分隔符（未被压成 %2F）
    expect(path).not.toContain('%2F')
  })

  it('username 为空时直接抛错，不发请求（防打到列表端点）', async () => {
    await expect(addGroupMember('g', '', 'Guest')).rejects.toThrow()
    expect(cnbFetchVoidMock).not.toHaveBeenCalled()
  })
})

describe('updateGroupMemberRole', () => {
  it('PUT（不是 POST）成员端点，body 结构与新增一致', async () => {
    cnbFetchVoidMock.mockResolvedValueOnce(undefined)
    await updateGroupMemberRole('my-group', 'alice', 'Master')

    expect(cnbFetchMock).not.toHaveBeenCalled()
    const [path, options] = cnbFetchVoidMock.mock.calls[0] as [string, RequestInit]
    expect(path).toBe('/my-group/-/members/alice')
    expect(options.method).toBe('PUT')
    expect(JSON.parse(String(options.body))).toEqual({ access_level: 'Master' })
  })

  it('username 含空格时被编码为 %20（路径段不可裸空格）', async () => {
    cnbFetchVoidMock.mockResolvedValueOnce(undefined)
    await updateGroupMemberRole('g', 'a b', 'Guest')
    const [path] = cnbFetchVoidMock.mock.calls[0] as [string]
    expect(path).toBe('/g/-/members/a%20b')
  })
})

describe('removeGroupMember', () => {
  it('DELETE 成员端点，无请求体', async () => {
    cnbFetchVoidMock.mockResolvedValueOnce(undefined)
    await removeGroupMember('my-group', 'alice')

    expect(cnbFetchMock).not.toHaveBeenCalled()
    const [path, options] = cnbFetchVoidMock.mock.calls[0] as [string, RequestInit]
    expect(path).toBe('/my-group/-/members/alice')
    expect(options.method).toBe('DELETE')
    expect(options.body).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 批量权限（GET /{group}/-/members/access-level）
// ---------------------------------------------------------------------------

describe('fetchGroupMembersAccessLevel', () => {
  it('走 JSON 通道请求 access-level，include_inherit 以 true/false 传参', async () => {
    cnbFetchMock.mockResolvedValueOnce({})
    await fetchGroupMembersAccessLevel('my-group', true)
    const url = cnbFetchMock.mock.calls[0][0] as string
    expect(url).toBe('/my-group/-/members/access-level?include_inherit=true')

    cnbFetchMock.mockResolvedValueOnce({})
    await fetchGroupMembersAccessLevel('my-group/sub', false)
    const url2 = cnbFetchMock.mock.calls[1][0] as string
    expect(url2).toBe('/my-group/sub/-/members/access-level?include_inherit=false')
    // 批量读端点不会被误当写端点
    expect(cnbFetchVoidMock).not.toHaveBeenCalled()
  })

  it('形态 1（map[username] 对象）：逐键转条目，兼容 { name } 包装的角色', async () => {
    cnbFetchMock.mockResolvedValueOnce({
      alice: { access_level: 'Master', inherit: false, read_privilege: true, write_privilege: true },
      bob: { access_level: { name: 'Reporter' } },
    })
    const levels = await fetchGroupMembersAccessLevel('g', false)
    expect(levels.get('alice')).toBe('Master')
    expect(levels.get('bob')).toBe('Reporter')
    expect(levels.size).toBe(2)
  })

  it('形态 2（数组）：username 从元素取', async () => {
    cnbFetchMock.mockResolvedValueOnce([
      { username: 'alice', access_level: 'Owner' },
      { username: 'carol', access_level: 'Guest' },
    ])
    const levels = await fetchGroupMembersAccessLevel('g', false)
    expect([...levels.entries()]).toEqual([['alice', 'Owner'], ['carol', 'Guest']])
  })

  it('形态 3（单对象，无 username 维度）：返回空 Map 由 UI 降级', async () => {
    cnbFetchMock.mockResolvedValueOnce({
      access_level: 'Master',
      inherit: true,
      read_privilege: true,
      write_privilege: false,
    })
    const levels = await fetchGroupMembersAccessLevel('g', false)
    expect(levels.size).toBe(0)
  })

  it('无法识别的结构（字符串 / null / 空数组 / 数字）一律空 Map，不抛错', async () => {
    for (const raw of ['unexpected', null, [], 42]) {
      cnbFetchMock.mockResolvedValueOnce(raw)
      // 逐个 await：断言与 mock 队列顺序一致，串行才能对上
      await expect(fetchGroupMembersAccessLevel('g', false)).resolves.toBeInstanceOf(Map)
    }
    expect(cnbFetchMock.mock.calls).toHaveLength(4)
  })
})

describe('normalizeMemberAccessLevel', () => {
  it('角色归一化为空字符串的条目被丢弃', () => {
    const levels = normalizeMemberAccessLevel({
      alice: { access_level: 'Master' },
      ghost: { inherit: true },
      nobody: { access_level: { weird: 1 } },
    })
    expect([...levels.keys()]).toEqual(['alice'])
  })

  it('map 里混入标量值即判定为单对象形态，整体放弃（不产出垃圾键）', () => {
    const levels = normalizeMemberAccessLevel({ alice: { access_level: 'Master' }, total: 1 })
    expect(levels.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 写操作 · 外部贡献者（仓库级：PUT / DELETE /{slug}/-/outside-collaborators/…）
// ---------------------------------------------------------------------------

describe('updateOutsideCollaborator', () => {
  it('PUT 仓库级端点，role 走 query（不在 body 里）', async () => {
    cnbFetchVoidMock.mockResolvedValueOnce(undefined)
    await updateOutsideCollaborator('my-group/my-repo', 'alice', 'Developer')

    expect(cnbFetchMock).not.toHaveBeenCalled()
    const [path, options] = cnbFetchVoidMock.mock.calls[0] as [string, RequestInit]
    expect(path).toBe('/my-group/my-repo/-/outside-collaborators/alice?role=Developer')
    expect(options.method).toBe('PUT')
    // role 是 query 参数：body 必须为空（带上会被服务端忽略或报参数非法）
    expect(options.body).toBeUndefined()
  })

  it('username 的 @ 与 . 被编码，仓库路径的 / 保留为层级分隔符', async () => {
    cnbFetchVoidMock.mockResolvedValueOnce(undefined)
    await updateOutsideCollaborator('org/repo', 'tom.x@example.com', 'Guest')
    const [path] = cnbFetchVoidMock.mock.calls[0] as [string]
    expect(path).toBe('/org/repo/-/outside-collaborators/tom.x%40example.com?role=Guest')
    expect(path).not.toContain('%2F')
  })

  it('没有仓库路径时抛错（传组织路径必 400，先拦住）', async () => {
    await expect(updateOutsideCollaborator('', 'alice', 'Guest')).rejects.toThrow()
    expect(cnbFetchVoidMock).not.toHaveBeenCalled()
  })
})

describe('removeOutsideCollaborator', () => {
  it('DELETE 仓库级端点，无请求体', async () => {
    cnbFetchVoidMock.mockResolvedValueOnce(undefined)
    await removeOutsideCollaborator('my-group/my-repo', 'alice')

    const [path, options] = cnbFetchVoidMock.mock.calls[0] as [string, RequestInit]
    expect(path).toBe('/my-group/my-repo/-/outside-collaborators/alice')
    expect(options.method).toBe('DELETE')
    expect(options.body).toBeUndefined()
  })
})
