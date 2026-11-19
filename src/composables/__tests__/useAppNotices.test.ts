/**
 * useAppNotices 单测（应用通知记录：面板「应用通知」分区的数据源）。
 *
 * 覆盖：追加置顶 / 容量裁剪 / 未读计数与清零 / 清空 / id 唯一性
 * （同一毫秒内多次 push 不重复）/ 数据库回灌（去重合并 + 未读数）。
 * 模块级状态在各用例间显式复位。push 路径会尝试落库，但测试环境
 * 无 Tauri 运行时，useNoticeDb 的环境守卫会自动跳过（不落库）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  appNoticeFeed,
  applyRestoredAppNotices,
  clearAppNotices,
  markAppNoticesRead,
  pushAppNotice,
  resetAppNoticesForTest,
  unreadAppNoticeCount,
} from '../useAppNotices'
import type { StoredAppNotice } from '../useNoticeDb'

beforeEach(() => {
  resetAppNoticesForTest()
})

describe('pushAppNotice（追加记录）', () => {
  it('新记录置顶，未读数 +1', () => {
    pushAppNotice({ kind: 'update', title: '发现新版本 0.1.0-rc.30', body: '正文', version: '0.1.0-rc.30', time: 1000 })
    pushAppNotice({ kind: 'update', title: '发现新版本 0.1.0-rc.31', body: '正文', version: '0.1.0-rc.31', time: 2000 })

    expect(appNoticeFeed.value).toHaveLength(2)
    // 最新的在最前面
    expect(appNoticeFeed.value[0]?.version).toBe('0.1.0-rc.31')
    expect(appNoticeFeed.value[1]?.version).toBe('0.1.0-rc.30')
    expect(unreadAppNoticeCount.value).toBe(2)
  })

  it('同一毫秒内多次 push 的 id 仍唯一', () => {
    for (let i = 0; i < 5; i++) {
      pushAppNotice({ kind: 'update', title: `t${i}`, body: '', version: '', time: 12345 })
    }
    const ids = appNoticeFeed.value.map(item => item.id)
    expect(new Set(ids).size).toBe(5)
  })

  it('超过容量上限（20 条）时裁剪掉最旧的，未读数不回退', () => {
    for (let i = 0; i < 25; i++) {
      pushAppNotice({ kind: 'update', title: `t${i}`, body: '', version: String(i), time: i })
    }
    expect(appNoticeFeed.value).toHaveLength(20)
    // 最旧的 5 条（0~4）被裁掉，最新（24）在首位
    expect(appNoticeFeed.value[0]?.version).toBe('24')
    expect(appNoticeFeed.value[19]?.version).toBe('5')
    expect(unreadAppNoticeCount.value).toBe(25)
  })
})

describe('已读与清空', () => {
  it('markAppNoticesRead 只清未读数，列表保留', () => {
    pushAppNotice({ kind: 'update', title: 't', body: '', version: '1.0.0', time: 1 })
    markAppNoticesRead()
    expect(unreadAppNoticeCount.value).toBe(0)
    expect(appNoticeFeed.value).toHaveLength(1)
  })

  it('clearAppNotices 清空列表与未读数', () => {
    pushAppNotice({ kind: 'update', title: 't', body: '', version: '1.0.0', time: 1 })
    clearAppNotices()
    expect(appNoticeFeed.value).toHaveLength(0)
    expect(unreadAppNoticeCount.value).toBe(0)
  })
})

describe('applyRestoredAppNotices（SQLite 回灌）', () => {
  /** 构造一条数据库形态的应用通知（各用例复用） */
  function row(id: string, time: number, read: boolean): StoredAppNotice {
    return { noticeId: id, kind: 'update', title: `t-${id}`, body: '', version: id, time, read }
  }

  it('回灌空列表是 no-op，不影响现有 feed', () => {
    pushAppNotice({ kind: 'update', title: 't', body: '', version: '1', time: 1 })
    applyRestoredAppNotices([])
    expect(appNoticeFeed.value).toHaveLength(1)
  })

  it('回灌历史通知：按时间倒序合并、未读数按 read=false 累加', () => {
    // 库里两条历史：一条已读、一条未读
    applyRestoredAppNotices([
      row('old', 100, true),
      row('new', 200, false),
    ])
    expect(appNoticeFeed.value.map(n => n.id)).toEqual(['new', 'old'])
    // 只有未读的历史通知计入徽标（已读的不重复打扰）
    expect(unreadAppNoticeCount.value).toBe(1)
  })

  it('与内存 feed 的 id 重复条目不重复合并（回灌竞态防御）', () => {
    // 回灌期间轮询刚好 push 了同毫秒通知：内存 id 为 `${time}-${seq}` = '300-1'，
    // 库里同一条落库时也用该 id —— 回灌时按 id 去重
    pushAppNotice({ kind: 'update', title: 't', body: '', version: 'x', time: 300 })
    expect(appNoticeFeed.value[0]?.id).toBe('300-1')
    applyRestoredAppNotices([row('300-1', 300, false), row('y', 100, true)])
    // '300-1' 只出现一次，'y' 正常并入
    const ids = appNoticeFeed.value.map(n => n.id)
    expect(ids).toEqual(['300-1', 'y'])
    // '300-1' 的未读在 push 时已计 1，回灌只补 'y'（read=true 不计）
    expect(unreadAppNoticeCount.value).toBe(1)
  })

  it('超过容量上限（20 条）时合并后仍裁剪到 20 条', () => {
    for (let i = 0; i < 15; i++) {
      pushAppNotice({ kind: 'update', title: `t${i}`, body: '', version: String(i), time: i })
    }
    // 回灌 10 条更旧的历史：合并 25 条 → 裁剪到 20
    const rows: StoredAppNotice[] = []
    for (let i = 0; i < 10; i++) {
      rows.push(row(`h${i}`, i - 100, true))
    }
    applyRestoredAppNotices(rows)
    expect(appNoticeFeed.value).toHaveLength(20)
  })
})
