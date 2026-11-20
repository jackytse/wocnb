/**
 * useRecentRepos 单测（托盘面板「最近打开」数据源）。
 *
 * 覆盖：记录置顶与同仓库去重 / 容量裁剪 / 脏数据容错 / 展示名兜底 /
 * 相对时间排序。node 环境无 localStorage —— 用内存 Map 桩替代（只实现
 * 被测代码用到的 getItem/setItem/removeItem）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearRecentRepos,
  loadRecentRepos,
  normalizeRecentRepoVisibility,
  readRecentRepos,
  recentRepos,
  recordRecentRepo,
} from '../useRecentRepos'

/** 内存版 localStorage（逐用例 clear 复位，避免串味） */
const store = new Map<string, string>()

beforeEach(() => {
  store.clear()
  recentRepos.value = []
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
    removeItem: (key: string) => { store.delete(key) },
  })
})

describe('recordRecentRepo / readRecentRepos', () => {
  it('记录后可按时间倒序读回，name 缺省取路径末段', () => {
    recordRecentRepo({ repoPath: 'cnb/feedback' })
    recordRecentRepo({ repoPath: 'jackytse/wocnb', name: 'WOCNB 客户端' })
    const list = readRecentRepos()
    expect(list).toHaveLength(2)
    // 后记录的在前（最近访问置顶）
    expect(list[0]?.repoPath).toBe('jackytse/wocnb')
    expect(list[0]?.name).toBe('WOCNB 客户端')
    // name 缺省 = 路径最后一段
    expect(list[1]?.name).toBe('feedback')
  })

  it('同一仓库重复访问只更新时间并置顶，不产生重复条目', () => {
    recordRecentRepo({ repoPath: 'cnb/feedback' })
    recordRecentRepo({ repoPath: 'jackytse/wocnb' })
    recordRecentRepo({ repoPath: 'cnb/feedback', name: 'Feedback 仓库' })
    const list = readRecentRepos()
    expect(list).toHaveLength(2)
    expect(list[0]?.repoPath).toBe('cnb/feedback')
    expect(list[0]?.name).toBe('Feedback 仓库')
  })

  it('超过 20 条时裁掉最旧的（面板只关心最近打开的）', () => {
    for (let i = 0; i < 25; i++) {
      recordRecentRepo({ repoPath: `group${i}/repo${i}` })
    }
    const list = readRecentRepos()
    expect(list).toHaveLength(20)
    // 最后一条记录（repo24）在最前，最早 5 条已被裁掉
    expect(list[0]?.repoPath).toBe('group24/repo24')
    expect(list.some(item => item.repoPath === 'group0/repo0')).toBe(false)
  })

  it('脏数据（坏 JSON / 非数组 / 缺字段条目）不抛错，按可读部分返回', () => {
    store.set('wocnb.recentRepos', '{not json')
    expect(readRecentRepos()).toEqual([])

    store.set('wocnb.recentRepos', JSON.stringify({ a: 1 }))
    expect(readRecentRepos()).toEqual([])

    store.set('wocnb.recentRepos', JSON.stringify([
      { repoPath: 'a/b', time: new Date().toISOString() },
      { repoPath: '', time: '2026-01-01T00:00:00Z' }, // 空路径：丢弃
      { time: '2026-01-01T00:00:00Z' }, // 缺 repoPath：丢弃
    ]))
    const list = readRecentRepos()
    expect(list).toHaveLength(1)
    expect(list[0]?.name).toBe('b')
  })

  it('loadRecentRepos 把磁盘内容灌进响应式列表（面板获焦刷新路径）', () => {
    store.set('wocnb.recentRepos', JSON.stringify([
      { repoPath: 'cnb/feedback', name: 'feedback', time: '2026-11-19T10:00:00Z' },
    ]))
    expect(recentRepos.value).toHaveLength(0)
    loadRecentRepos()
    expect(recentRepos.value).toHaveLength(1)
    expect(recentRepos.value[0]?.repoPath).toBe('cnb/feedback')
  })

  it('clearRecentRepos 清盘并复位响应式列表', () => {
    recordRecentRepo({ repoPath: 'cnb/feedback' })
    clearRecentRepos()
    expect(recentRepos.value).toHaveLength(0)
    expect(store.has('wocnb.recentRepos')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 可见性徽标数据（公开/私有/保密）：归一化 + 记录读回 + 脏值容错
// ---------------------------------------------------------------------------

describe('仓库可见性（visibility）', () => {
  it('normalizeRecentRepoVisibility：大小写归一 + 三值白名单', () => {
    // RepoDetail.visibility 是首字母大写三值，记录时统一转小写
    expect(normalizeRecentRepoVisibility('Public')).toBe('public')
    expect(normalizeRecentRepoVisibility('PRIVATE')).toBe('private')
    expect(normalizeRecentRepoVisibility('secret')).toBe('secret')
    // 脏值/空值/未知取值（含未来 API 扩展）→ undefined，面板不渲染徽标
    expect(normalizeRecentRepoVisibility('internal')).toBeUndefined()
    expect(normalizeRecentRepoVisibility('')).toBeUndefined()
    expect(normalizeRecentRepoVisibility(undefined)).toBeUndefined()
    expect(normalizeRecentRepoVisibility(123)).toBeUndefined()
  })

  it('recordRecentRepo 记录可见性后可读回（大小写归一为小写）', () => {
    recordRecentRepo({ repoPath: 'a/public-repo', visibility: 'Public' })
    recordRecentRepo({ repoPath: 'a/private-repo', visibility: 'Private' })
    const list = readRecentRepos()
    expect(list[0]?.visibility).toBe('private')
    expect(list[1]?.visibility).toBe('public')
  })

  it('未传可见性 / 脏可见性 → undefined（旧记录与未知值不误标成公开）', () => {
    recordRecentRepo({ repoPath: 'a/legacy' })
    recordRecentRepo({ repoPath: 'a/dirty', visibility: 'internal' })
    const list = readRecentRepos()
    expect(list[0]?.visibility).toBeUndefined()
    expect(list[1]?.visibility).toBeUndefined()
  })

  it('同一仓库重复访问会更新可见性（仓库中途转私有的场景）', () => {
    recordRecentRepo({ repoPath: 'a/b', visibility: 'Public' })
    recordRecentRepo({ repoPath: 'a/b', visibility: 'Private' })
    const list = readRecentRepos()
    expect(list).toHaveLength(1)
    expect(list[0]?.visibility).toBe('private')
  })
})
