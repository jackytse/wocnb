/**
 * useCnbBuildWatch 纯函数单测（快照比对 / 状态过滤 / 通知合并）。
 *
 * 只测纯逻辑：网络通道（useCnbAuth 的 cnbFetch、useCnbRepo 的 fetchBuildLogs）
 * 全部 mock —— 定时器与系统通知属于副作用层，由集成/手工验证覆盖。
 *
 * 重点覆盖工程师自报的三个高风险断言：
 * 1. 首次基线（prev 为空）绝不产生"已结束"（否则启动瞬间会轰炸历史构建）；
 * 2. 仓库整条从快照消失时，其所有 pending 都算结束（仓库被删/改名场景）；
 * 3. 同一 sn 出现在不同仓库时互不串味（sn 只在仓库内唯一）。
 */
import { describe, expect, it, vi } from 'vitest'

// mock 依赖：本模块顶层会 useStorage 并 import 网络层，全部替换为无副作用替身
vi.mock('../useCnbAuth', async () => {
  const { ref } = await import('vue')
  class FakeCnbApiError extends Error {
    kind: string
    status?: number
    constructor(message: string, status?: number, kind = 'network') {
      super(message)
      this.status = status
      this.kind = kind
    }
  }
  return {
    cnbToken: ref('test-token'),
    selectedGroup: ref<{ path: string } | null>({ path: 'test-org' }),
    fetchCnbGroupRepos: vi.fn(async () => []),
    CnbApiError: FakeCnbApiError,
  }
})

vi.mock('../useCnbRepo', () => ({
  fetchBuildLogs: vi.fn(async () => ({ total: 0, items: [] })),
}))

import {
  buildKey,
  diffBuildSnapshot,
  ensureTrailingSlashFree,
  isForbiddenError,
  isMissingScopeError,
  shouldNotifyStatus,
  summarizeNotifications,
  truncateText,
  type BuildEntry,
  type BuildSnapshot,
  type ResolvedBuild,
} from '../useCnbBuildWatch'

/** 构造一条 pending 快照条目（只写测试关心的字段） */
function entry(sn: string, commitTitle = `commit-${sn}`, sourceRef = 'main'): BuildEntry {
  return {
    sn,
    status: 'pending',
    commitTitle,
    sourceRef,
    nickName: 'tester',
    createTime: '2026-01-01T00:00:00Z',
  }
}

/** 构造 resolved 条目（已回查最终状态） */
function resolved(sn: string, status: string): ResolvedBuild {
  return {
    repoPath: 'org/repo',
    sn,
    commitTitle: `commit-${sn}`,
    sourceRef: 'main',
    nickName: 'tester',
    createTime: '2026-01-01T00:00:00Z',
    status,
  }
}

// ---------------------------------------------------------------------------
// diffBuildSnapshot：快照比对的四条核心规则
// ---------------------------------------------------------------------------
describe('diffBuildSnapshot', () => {
  it('新增 pending 只记入 started，不产生 finished（构建开始不发通知）', () => {
    const prev: BuildSnapshot = {}
    const next: BuildSnapshot = { 'org/repo': { '10': entry('10') } }

    const { finished, started } = diffBuildSnapshot(prev, next)

    expect(finished).toHaveLength(0)
    expect(started).toEqual([buildKey('org/repo', '10')])
  })

  it('上一轮 pending 这一轮消失 → finished，并带上上一轮的文案字段', () => {
    const prev: BuildSnapshot = { 'org/repo': { '10': entry('10', '修复登录', 'feat/login') } }
    const next: BuildSnapshot = {}

    const { finished } = diffBuildSnapshot(prev, next)

    expect(finished).toHaveLength(1)
    expect(finished[0]).toEqual({
      repoPath: 'org/repo',
      sn: '10',
      commitTitle: '修复登录',
      sourceRef: 'feat/login',
      nickName: 'tester',
      createTime: '2026-01-01T00:00:00Z',
    })
  })

  it('仓库整条从快照消失 → 该仓库全部 sn 都算 finished', () => {
    const prev: BuildSnapshot = {
      'org/repoA': { '1': entry('1'), '2': entry('2') },
      'org/repoB': { '3': entry('3') },
    }
    // repoA 整个不见了（仓库被删除 / 改名 / 移出关注列表），repoB 仍有一条 pending
    const next: BuildSnapshot = { 'org/repoB': { '3': entry('3') } }

    const { finished } = diffBuildSnapshot(prev, next)

    expect(finished.map(item => item.sn).sort()).toEqual(['1', '2'])
    expect(finished.every(item => item.repoPath === 'org/repoA')).toBe(true)
  })

  it('快照从空到非空（首次基线）不产生 finished', () => {
    const prev: BuildSnapshot = {}
    const next: BuildSnapshot = {
      'org/repo': { '1': entry('1'), '2': entry('2'), '3': entry('3') },
    }

    const { finished, started } = diffBuildSnapshot(prev, next)

    // 历史 pending 全被当成"新出现"，而不是"刚结束" —— 这正是基线的意义
    expect(finished).toHaveLength(0)
    expect(started).toHaveLength(3)
  })

  it('同一 sn 出现在不同仓库时互不串味（A 结束不影响 B 的同号构建）', () => {
    const prev: BuildSnapshot = {
      'org/repoA': { '7': entry('7') },
      'org/repoB': { '7': entry('7') },
    }
    // 只有 repoA 的那条结束了
    const next: BuildSnapshot = { 'org/repoB': { '7': entry('7') } }

    const { finished, started } = diffBuildSnapshot(prev, next)

    expect(finished).toHaveLength(1)
    expect(finished[0]?.repoPath).toBe('org/repoA')
    // repoB 的 7 号还在跑，不该被判成"新增"
    expect(started).toEqual([])
  })

  it('两轮完全相同 → 无新增无结束', () => {
    const snapshot: BuildSnapshot = { 'org/repo': { '1': entry('1') } }
    const { finished, started } = diffBuildSnapshot(snapshot, snapshot)
    expect(finished).toEqual([])
    expect(started).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// shouldNotifyStatus：只有终态才打扰用户
// ---------------------------------------------------------------------------
describe('shouldNotifyStatus', () => {
  it('success / error / cancel 为真', () => {
    expect(shouldNotifyStatus('success')).toBe(true)
    expect(shouldNotifyStatus('error')).toBe(true)
    expect(shouldNotifyStatus('cancel')).toBe(true)
  })

  it('pending（运行中/排队中）与未知值为假', () => {
    // CNB 的 pending 就是"运行中/排队中"，没有单独的 running 枚举
    expect(shouldNotifyStatus('pending')).toBe(false)
    expect(shouldNotifyStatus('')).toBe(false)
    expect(shouldNotifyStatus('running')).toBe(false)
    expect(shouldNotifyStatus('whatever')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// summarizeNotifications：少量逐条、大量合并
// ---------------------------------------------------------------------------
describe('summarizeNotifications', () => {
  it('3 条 → 逐条通知，singles 保序', () => {
    const plan = summarizeNotifications([
      resolved('1', 'success'),
      resolved('2', 'error'),
      resolved('3', 'cancel'),
    ])

    expect(plan.mode).toBe('single')
    expect(plan.singles.map(item => item.sn)).toEqual(['1', '2', '3'])
    expect(plan.digest).toEqual({ total: 3, success: 1, error: 1, cancel: 1, unknown: 0 })
  })

  it('恰好 5 条仍逐条（边界值，<= maxSingle）', () => {
    const list = Array.from({ length: 5 }, (_, index) => resolved(String(index), 'success'))
    const plan = summarizeNotifications(list)

    expect(plan.mode).toBe('single')
    expect(plan.singles).toHaveLength(5)
  })

  it('8 条 → 合并成一条摘要，计数含 success/error/unknown 分项', () => {
    const list: ResolvedBuild[] = [
      resolved('1', 'success'),
      resolved('2', 'success'),
      resolved('3', 'success'),
      resolved('4', 'error'),
      resolved('5', 'error'),
      resolved('6', 'cancel'),
      // 回查失败 / 非终态归入 unknown
      resolved('7', ''),
      resolved('8', 'mystery'),
    ]
    const plan = summarizeNotifications(list)

    expect(plan.mode).toBe('digest')
    // 合并模式不再逐条通知
    expect(plan.singles).toEqual([])
    expect(plan.digest).toEqual({ total: 8, success: 3, error: 2, cancel: 1, unknown: 2 })
  })

  it('空列表 → 逐条模式但无条目（调用方据此跳过发送）', () => {
    const plan = summarizeNotifications([])
    expect(plan.mode).toBe('single')
    expect(plan.singles).toEqual([])
    expect(plan.digest.total).toBe(0)
  })

  it('自定义 maxSingle 生效（传 1 时 2 条即合并）', () => {
    const plan = summarizeNotifications([resolved('1', 'success'), resolved('2', 'error')], 1)
    expect(plan.mode).toBe('digest')
    expect(plan.digest).toEqual({ total: 2, success: 1, error: 1, cancel: 0, unknown: 0 })
  })
})

// ---------------------------------------------------------------------------
// 小工具：路径归一 / 文本截断 / 403 识别
// ---------------------------------------------------------------------------
describe('ensureTrailingSlashFree', () => {
  it('去掉结尾多余斜杠与首尾空白', () => {
    expect(ensureTrailingSlashFree('org/repo/')).toBe('org/repo')
    expect(ensureTrailingSlashFree('  org/repo//  ')).toBe('org/repo')
    expect(ensureTrailingSlashFree('org/repo')).toBe('org/repo')
    expect(ensureTrailingSlashFree('')).toBe('')
  })
})

describe('truncateText', () => {
  it('超长截断并追加省略号，短文本原样返回', () => {
    expect(truncateText('abcdef', 10)).toBe('abcdef')
    expect(truncateText('abcdefghij', 5)).toBe('abcd…')
    // 空值兜底为空串（通知里不能出现 undefined）
    expect(truncateText('', 5)).toBe('')
  })
})

describe('isForbiddenError', () => {
  it('kind === forbidden 时为真（403 只跳过仓库，绝不登出）', () => {
    expect(isForbiddenError({ kind: 'forbidden' })).toBe(true)
    expect(isForbiddenError({ kind: 'network' })).toBe(false)
    expect(isForbiddenError(new Error('boom'))).toBe(false)
    expect(isForbiddenError(null)).toBe(false)
    expect(isForbiddenError('forbidden')).toBe(false)
  })
})

describe('isMissingScopeError（403 的二分：缺 scope vs 风控）', () => {
  it('403 + 能解析出 scope 名 → 真缺权限（才允许永久跳过该仓库）', () => {
    expect(isMissingScopeError({ kind: 'forbidden', missingScope: 'repo-cnb-history:r' })).toBe(true)
  })

  it('403 但解析不出 scope（网关风控等）→ 不算缺权限，须按普通失败重试', () => {
    expect(isMissingScopeError({ kind: 'forbidden' })).toBe(false)
    expect(isMissingScopeError({ kind: 'forbidden', missingScope: '' })).toBe(false)
    expect(isMissingScopeError({ kind: 'forbidden', missingScope: null })).toBe(false)
  })

  it('非 403 一律为假（401/404/网络错误都不该触发跳过）', () => {
    expect(isMissingScopeError({ kind: 'unauthorized', status: 401, missingScope: 'repo-cnb-history:r' })).toBe(false)
    expect(isMissingScopeError({ kind: 'network' })).toBe(false)
    expect(isMissingScopeError(new Error('boom'))).toBe(false)
    expect(isMissingScopeError(null)).toBe(false)
  })
})
