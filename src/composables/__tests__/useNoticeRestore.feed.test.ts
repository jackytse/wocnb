/**
 * useCnbBuildWatch 构建通知 SQLite 回灌单测（applyRestoredBuildNotices）。
 *
 * 覆盖：按时间倒序合并 / 未读数按 read=false 累加 / 与内存 feed 的
 * id 去重（回灌竞态防御）/ 容量裁剪（50 条）。直接导入模块级 ref
 * 操作，与其他通知测试同范式；测试环境无 Tauri 运行时，落库守卫
 * 自动跳过。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  applyRestoredBuildNotices,
  buildNoticeFeed,
  clearBuildNotices,
  unreadBuildCount,
  type BuildNotice,
} from '../useCnbBuildWatch'
import type { StoredBuildNotice } from '../useNoticeDb'

/** 构造一条内存形态的构建通知（各用例复用，字段按需覆写） */
function memoryNotice(id: string, time: number): BuildNotice {
  return {
    id,
    repoPath: 'group/repo',
    repoName: 'repo',
    sn: '42',
    status: 'success',
    commitTitle: 'feat: x',
    sourceRef: 'main',
    nickName: 'tester',
    time,
    leftover: false,
  }
}

/** 构造一条数据库形态的构建通知（read 按用例指定） */
function storedRow(id: string, time: number, read: boolean): StoredBuildNotice {
  return {
    noticeId: id,
    repoPath: 'group/repo',
    repoName: 'repo',
    sn: '42',
    status: 'success',
    commitTitle: 'feat: x',
    sourceRef: 'main',
    nickName: 'tester',
    time,
    leftover: false,
    read,
  }
}

beforeEach(() => {
  // 模块级 feed/未读数显式复位（项目测试范式：用例间互不干扰）
  clearBuildNotices()
})

describe('applyRestoredBuildNotices（SQLite 回灌）', () => {
  it('回灌空列表是 no-op', () => {
    buildNoticeFeed.value = [memoryNotice('a', 1)]
    applyRestoredBuildNotices([])
    expect(buildNoticeFeed.value).toHaveLength(1)
    expect(unreadBuildCount.value).toBe(0)
  })

  it('回灌历史通知：按时间倒序合并，未读数只累加 read=false 条目', () => {
    applyRestoredBuildNotices([
      storedRow('old', 100, true),
      storedRow('new', 200, false),
      storedRow('newer', 300, false),
    ])
    expect(buildNoticeFeed.value.map(n => n.id)).toEqual(['newer', 'new', 'old'])
    expect(unreadBuildCount.value).toBe(2)
  })

  it('与内存 feed 的 id 重复条目不重复合并（回灌竞态防御）', () => {
    // 回灌期间轮询刚好 push 了同 id 的通知：内存里已有 'x'
    buildNoticeFeed.value = [memoryNotice('x', 300)]
    unreadBuildCount.value = 1
    applyRestoredBuildNotices([storedRow('x', 300, false), storedRow('y', 100, true)])
    expect(buildNoticeFeed.value.map(n => n.id)).toEqual(['x', 'y'])
    // 'x' 未读已在内存计过，回灌只看新增条目（'y' 已读不计）
    expect(unreadBuildCount.value).toBe(1)
  })

  it('合并后超过 50 条时裁剪到 50 条（最新在前）', () => {
    // 内存已有 30 条
    const memory: BuildNotice[] = []
    for (let i = 0; i < 30; i++) {
      memory.push(memoryNotice(`m-${i}`, 1000 + i))
    }
    buildNoticeFeed.value = memory
    // 回灌 30 条更旧的历史：合并 60 → 裁剪 50，被裁掉的是最旧的
    const rows: StoredBuildNotice[] = []
    for (let i = 0; i < 30; i++) {
      rows.push(storedRow(`h-${i}`, i, true))
    }
    applyRestoredBuildNotices(rows)
    expect(buildNoticeFeed.value).toHaveLength(50)
    expect(buildNoticeFeed.value[0]?.id).toBe('m-29')
    // 裁掉的是最旧的 10 条历史（h-9~h-0），第 50 条是 h-10
    expect(buildNoticeFeed.value.at(-1)?.id).toBe('h-10')
  })
})
