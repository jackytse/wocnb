/**
 * useAppNotices 单测（应用通知记录：面板「应用通知」分区的数据源）。
 *
 * 覆盖：追加置顶 / 容量裁剪 / 未读计数与清零 / 清空 / id 唯一性
 * （同一毫秒内多次 push 不重复）。模块级状态在各用例间显式复位。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  appNoticeFeed,
  clearAppNotices,
  markAppNoticesRead,
  pushAppNotice,
  resetAppNoticesForTest,
  unreadAppNoticeCount,
} from '../useAppNotices'

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
