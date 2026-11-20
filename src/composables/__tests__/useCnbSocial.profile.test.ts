/**
 * useCnbSocial 用户资料卡单测（2026-11-20 需求：仓库内查看贡献者信息）。
 *
 * 锁定口径：
 * - fetchUserProfile 走 GET /users/{username}，username 逐段编码；
 * - dto.UsersResult snake_case → camelCase 归一化，缺省字段兜底空值/0；
 * - nickname 缺省回退：归一化层不回退（'' 透传），展示层负责；
 * - verified / isFollowing 布尔透传（!! 归一）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const cnbFetchMock = vi.fn()

vi.mock('../useCnbAuth', () => ({
  cnbFetch: (...args: unknown[]) => cnbFetchMock(...args),
  cnbAvatarUrl: (username: string) => `https://cnb.cool/users/${username}/avatar/s`,
  cnbFetchVoid: vi.fn(),
  cnbFetchText: vi.fn(),
}))

import { cnbUserProfileUrl, fetchUserProfile, userProfileAvatar } from '../useCnbSocial'

beforeEach(() => {
  cnbFetchMock.mockReset()
})

/** 构造 GET /users/{username} 的 dto.UsersResult 响应 */
function userResultOf(overrides: Record<string, unknown> = {}) {
  return {
    username: 'jackytse',
    nickname: 'Jacky',
    avatar: 'https://cnb.cool/avatar.png',
    bio: 'AI coding 爱好者',
    company: 'CNB',
    location: '上海',
    site: 'example.com',
    created_at: '2024-01-01T00:00:00Z',
    public_repo_count: 12,
    follower_count: 34,
    follow_count: 56,
    is_following: true,
    verified: true,
    ...overrides,
  }
}

describe('fetchUserProfile', () => {
  it('完整字段归一化：snake_case → camelCase 全透传', async () => {
    cnbFetchMock.mockResolvedValue(userResultOf())
    const profile = await fetchUserProfile('jackytse')
    expect(cnbFetchMock).toHaveBeenCalledWith('/users/jackytse')
    expect(profile).toEqual({
      username: 'jackytse',
      nickname: 'Jacky',
      avatar: 'https://cnb.cool/avatar.png',
      bio: 'AI coding 爱好者',
      company: 'CNB',
      location: '上海',
      site: 'example.com',
      createdAt: '2024-01-01T00:00:00Z',
      publicRepoCount: 12,
      followerCount: 34,
      followCount: 56,
      isFollowing: true,
      verified: true,
    })
  })

  it('字段缺省兜底：计数归 0、字符串归空串、布尔归 false', async () => {
    cnbFetchMock.mockResolvedValue({})
    const profile = await fetchUserProfile('ghost')
    expect(profile.username).toBe('ghost') // 入参兜底（服务端未回 username）
    expect(profile.nickname).toBe('')
    expect(profile.avatar).toBe('')
    expect(profile.publicRepoCount).toBe(0)
    expect(profile.followerCount).toBe(0)
    expect(profile.followCount).toBe(0)
    expect(profile.isFollowing).toBe(false)
    expect(profile.verified).toBe(false)
  })

  it('用户名含特殊字符时逐段编码（encodeURIComponent）', async () => {
    cnbFetchMock.mockResolvedValue(userResultOf({ username: 'user name' }))
    await fetchUserProfile('user name')
    expect(cnbFetchMock).toHaveBeenCalledWith('/users/user%20name')
  })
})

describe('userProfileAvatar / cnbUserProfileUrl', () => {
  it('avatar 非空直接用服务端地址', () => {
    expect(userProfileAvatar({ avatar: 'https://x.png', username: 'a' })).toBe('https://x.png')
  })

  it('avatar 为空回退 CNB 规则头像 URL', () => {
    expect(userProfileAvatar({ avatar: '', username: 'jackytse' }))
      .toBe('https://cnb.cool/users/jackytse/avatar/s')
  })

  it('主页外跳地址为 https://cnb.cool/{username}（应用内无用户页路由）', () => {
    expect(cnbUserProfileUrl('jackytse')).toBe('https://cnb.cool/jackytse')
  })
})
