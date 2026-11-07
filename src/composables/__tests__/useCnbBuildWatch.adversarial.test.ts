/**
 * useCnbBuildWatch 纯函数的**对抗性**用例（QA 补充，与工程师的
 * useCnbBuildWatch.test.ts 互补，不重复其已有断言）。
 *
 * 补的四类场景：
 * 1. 快照 diff 里「仓库键整条消失」与「仓库为空对象」的语义差异
 *    —— 二者在本函数里都判为"该仓库 pending 全部结束"，差异必须由
 *    轮询层（失败仓库合并）保证，测试把这条契约钉死；
 * 2. 组织切换后旧快照参与比对时不得把仍在 pending 的构建判成已结束；
 * 3. summarizeNotifications 的 5 / 6 条边界与"全 unknown"计数；
 * 4. 全 unknown 时摘要文案的计数渲染（i18n 插值不能漏掉 unknown）。
 *
 * 纯函数、无 IO、无定时器，node 环境可直接跑。
 */
import { describe, expect, it } from 'vitest'
import { i18n } from '../../i18n'
import {
  diffBuildSnapshot,
  summarizeNotifications,
  type BuildEntry,
  type BuildSnapshot,
  type ResolvedBuild,
} from '../useCnbBuildWatch'

/** 构造一条 pending 快照条目 */
function entry(sn: string): BuildEntry {
  return {
    sn,
    status: 'pending',
    commitTitle: `commit-${sn}`,
    sourceRef: 'main',
    nickName: 'tester',
    createTime: '2026-01-01T00:00:00Z',
  }
}

/** 构造一条已回查的构建结果 */
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
// 1. next 缺键 vs 空对象：语义差异的边界
// ---------------------------------------------------------------------------
describe('diffBuildSnapshot：仓库键消失与空对象的语义', () => {
  it('next 缺少该仓库键 == 该仓库空对象：两条 pending 都判为已结束', () => {
    const prev: BuildSnapshot = { 'org/repo': { '1': entry('1'), '2': entry('2') } }

    const missingKey = diffBuildSnapshot(prev, {})
    const emptyObject = diffBuildSnapshot(prev, { 'org/repo': {} })

    // 契约：二者在 diff 层等价。若哪天有人给"空对象"加了特殊语义（如"该仓库无 pending"），
    // 这条断言会立刻失败，提醒同步修改轮询层的失败仓库合并逻辑。
    expect(missingKey.finished.map(item => item.sn).sort()).toEqual(['1', '2'])
    expect(emptyObject.finished.map(item => item.sn).sort()).toEqual(['1', '2'])
    expect(missingKey).toEqual(emptyObject)
  })

  it('仓库在场但 pending 集合部分变化：只对消失的那条产生 finished', () => {
    const prev: BuildSnapshot = { 'org/repo': { '1': entry('1'), '2': entry('2') } }
    const next: BuildSnapshot = { 'org/repo': { '2': entry('2'), '3': entry('3') } }

    const { finished, started } = diffBuildSnapshot(prev, next)

    expect(finished.map(item => item.sn)).toEqual(['1'])
    expect(started).toEqual(['org/repo#3'])
  })

  it('空对象仓库留在快照里也不会反复产生 finished（幂等）', () => {
    // 第二轮 prev 里若残留空对象仓库，不应再次报结束（防止重复通知）
    const { finished } = diffBuildSnapshot({ 'org/repo': {} }, {})
    expect(finished).toEqual([])
  })

  it('仓库键带结尾斜杠与不带斜杠视为不同仓库（归一化责任在轮询层）', () => {
    // 说明性用例：diff 本身不做归一化，防止有人误以为这里能兜住
    const { finished } = diffBuildSnapshot({ 'org/repo/': { '1': entry('1') } }, { 'org/repo': { '1': entry('1') } })
    expect(finished.map(item => item.sn)).toEqual(['1'])
  })
})

// ---------------------------------------------------------------------------
// 2. 组织切换：快照仍含其他组织的 pending 时不得误报结束
// ---------------------------------------------------------------------------
describe('diffBuildSnapshot：组织切换后的快照污染防护', () => {
  it('把 A 组织的旧快照当基线去比 B 组织的 pending → 会把 A 的构建全判成结束（故轮询层必须先清快照）', () => {
    // 本用例固化"为什么组织切换必须 resetSnapshot"：
    // 若工程师哪天去掉 resetSnapshot，下面的宽松比对就会在真实轮询里造成整批误报。
    const prevA: BuildSnapshot = { 'orgA/repo1': { '1': entry('1') } }
    const nextB: BuildSnapshot = { 'orgB/repo2': { '2': entry('2') } }

    const { finished, started } = diffBuildSnapshot(prevA, nextB)

    expect(finished.map(item => `${item.repoPath}#${item.sn}`)).toEqual(['orgA/repo1#1'])
    expect(started).toEqual(['orgB/repo2#2'])
  })

  it('同一快照同时含 A/B 两个组织、只有 B 的构建结束 → 只报 B 那条', () => {
    const prev: BuildSnapshot = {
      'orgA/repo1': { '1': entry('1') },
      'orgB/repo2': { '2': entry('2') },
    }
    const next: BuildSnapshot = { 'orgA/repo1': { '1': entry('1') } }

    const { finished } = diffBuildSnapshot(prev, next)

    expect(finished).toHaveLength(1)
    expect(finished[0]?.repoPath).toBe('orgB/repo2')
  })
})

// ---------------------------------------------------------------------------
// 3. summarizeNotifications：5 / 6 边界
// ---------------------------------------------------------------------------
describe('summarizeNotifications：合并阈值边界', () => {
  it('恰好 5 条 → 逐条（不合并）', () => {
    const list = Array.from({ length: 5 }, (_, i) => resolved(String(i + 1), 'success'))
    const plan = summarizeNotifications(list)

    expect(plan.mode).toBe('single')
    expect(plan.singles).toHaveLength(5)
    expect(plan.digest.total).toBe(5)
  })

  it('恰好 6 条 → 合并成一条摘要（越过边界立刻合并）', () => {
    const list = Array.from({ length: 6 }, (_, i) => resolved(String(i + 1), 'error'))
    const plan = summarizeNotifications(list)

    expect(plan.mode).toBe('digest')
    expect(plan.singles).toEqual([])
    expect(plan.digest).toEqual({ total: 6, success: 0, error: 6, cancel: 0, unknown: 0 })
  })

  it('6 条全为 unknown（回查失败）→ unknown 计数等于总数，其余分项为 0', () => {
    const list = Array.from({ length: 6 }, (_, i) => resolved(String(i + 1), ''))
    const plan = summarizeNotifications(list)

    expect(plan.mode).toBe('digest')
    expect(plan.digest).toEqual({ total: 6, success: 0, error: 0, cancel: 0, unknown: 6 })
  })

  it('全 unknown 时摘要文案的计数渲染正确（未知数走独立后缀键，不再混进正文）', () => {
    // 文案口径变更（缺陷 #1 修复）：digestBody 只渲染三个确定终态的计数，
    // 未知数改由 digestUnknown 后缀追加；全 unknown 时根本不发系统通知
    // （行为断言在 useCnbBuildWatch.polling.test.ts），这里只校验文案渲染。
    const previous = i18n.global.locale.value
    i18n.global.locale.value = 'zh-CN'
    try {
      const plan = summarizeNotifications(
        [resolved('1', ''), resolved('2', ''), resolved('3', ''), resolved('4', ''), resolved('5', ''), resolved('6', '')],
      )
      const title = i18n.global.t('buildWatch.notify.digestTitle', { count: plan.digest.total })
      const body = i18n.global.t('buildWatch.notify.digestBody', {
        success: plan.digest.success,
        error: plan.digest.error,
        cancel: plan.digest.cancel,
      })
      const unknownSuffix = i18n.global.t('buildWatch.notify.digestUnknown', { count: plan.digest.unknown })

      expect(title).toBe('6 个构建已结束')
      expect(body).toContain('成功 0')
      expect(body).not.toContain('未知')
      expect(unknownSuffix).toContain('6')
      expect(unknownSuffix).toContain('状态未知')
    }
    finally {
      i18n.global.locale.value = previous
    }
  })

  it('maxSingle 传 0 / 负数时下限被夹到 1（不产生空计划）', () => {
    // 实现用 Math.max(1, floor(maxSingle)) 夹下限：单个条目仍逐条，两个及以上才合并。
    // 断言这个夹取行为，防止未来把阈值做成可配置（0 = 关闭逐条通知）时静默产生空计划。
    expect(summarizeNotifications([resolved('1', 'success')], 0).mode).toBe('single')
    expect(summarizeNotifications([resolved('1', 'success'), resolved('2', 'error')], 0).mode).toBe('digest')
    expect(summarizeNotifications([resolved('1', 'success'), resolved('2', 'error')], -3).mode).toBe('digest')
    // 无论如何都不会返回"既不是 single 也不是 digest"的空计划
    expect(summarizeNotifications([], 0).singles).toEqual([])
  })

  it('非终态混入（mystery / pending）一律计入 unknown，不误计成功', () => {
    const plan = summarizeNotifications([
      resolved('1', 'success'),
      resolved('2', 'pending'),
      resolved('3', 'mystery'),
      resolved('4', 'SUCCESS'),
    ])

    expect(plan.digest).toEqual({ total: 4, success: 1, error: 0, cancel: 0, unknown: 3 })
  })
})
