/**
 * src/utils/index.ts 格式化函数单测（纯函数，node 环境无 DOM）。
 *
 * 覆盖边界：空串 / 0 / 负数 / NaN / Infinity / 非法日期字符串。
 * 注：formatRelativeTime 依赖 useAppLocale 的 resolvedLocale，
 * 此处 mock 为固定 zh-CN，避免 node 环境触发 navigator/localStorage。
 */
import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

// mock 语言模块：utils 内 formatRelativeTime 只读取 resolvedLocale.value
vi.mock('../../composables/useAppLocale', () => ({
  resolvedLocale: ref('zh-CN'),
}))

import { formatBytes, formatDateTime, formatDuration, formatRelativeTime } from '../index'

// ---------------------------------------------------------------------------
// formatDateTime：ISO -> 'yyyy-MM-dd HH:mm'
// ---------------------------------------------------------------------------

describe('formatDateTime', () => {
  it('空串返回空串（调用方据此隐藏时间区块）', () => {
    expect(formatDateTime('')).toBe('')
  })

  it('无时区的 ISO 串按本地时间格式化为 yyyy-MM-dd HH:mm', () => {
    // 不带 Z/时区后缀的串按本地时区解析，断言与本地时区无关
    expect(formatDateTime('2026-10-27T09:30:00')).toBe('2026-10-27 09:30')
  })

  it('非法日期串原样返回不抛错', () => {
    // date-fns 对 Invalid Date 抛 RangeError，函数应捕获并原样返回
    expect(formatDateTime('not-a-date')).toBe('not-a-date')
  })

  it('ISO 带毫秒与 Z 后缀也能正确格式化（截断到分钟）', () => {
    // 固定 UTC 时间，用本地时区换算校验"格式形状"而非具体钟点
    const out = formatDateTime('2026-10-27T09:30:45.123Z')
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  })
})

// ---------------------------------------------------------------------------
// formatRelativeTime：ISO -> 相对时间（i18n locale 随语言）
// ---------------------------------------------------------------------------

describe('formatRelativeTime', () => {
  it('空串返回空串', () => {
    expect(formatRelativeTime('')).toBe('')
  })

  it('非法日期串原样返回（NaN 提前拦截）', () => {
    expect(formatRelativeTime('garbage-input')).toBe('garbage-input')
  })

  it('过去时间返回带"前"的相对描述（zh-CN locale）', () => {
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString()
    const out = formatRelativeTime(twoMinutesAgo)
    // 不锁死具体文案（date-fns 版本可能微调空格），只断言中文后缀方向
    expect(out).toContain('前')
  })
})

// ---------------------------------------------------------------------------
// formatDuration：毫秒 -> 人类可读
// ---------------------------------------------------------------------------

describe('formatDuration', () => {
  it('非正数与非法值返回空串', () => {
    expect(formatDuration(0)).toBe('')
    expect(formatDuration(-5)).toBe('')
    expect(formatDuration(Number.NaN)).toBe('')
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('')
  })

  it('小于 1 秒返回一位小数秒', () => {
    expect(formatDuration(800)).toBe('0.8s')
  })

  it('1 秒 ~ 1 分钟内返回整秒', () => {
    expect(formatDuration(12_300)).toBe('12s')
    expect(formatDuration(1000)).toBe('1s')
    expect(formatDuration(59_400)).toBe('59s')
  })

  it('分钟段返回 "Xm Ys"', () => {
    expect(formatDuration(60_000)).toBe('1m 0s')
    expect(formatDuration(205_000)).toBe('3m 25s')
  })

  it('小时段返回 "Xh YYm"（分钟补零）', () => {
    expect(formatDuration(3_900_000)).toBe('1h 05m')
    expect(formatDuration(7_320_000)).toBe('2h 02m')
  })
})

// ---------------------------------------------------------------------------
// formatBytes：字节 -> 人类可读大小
// ---------------------------------------------------------------------------

describe('formatBytes', () => {
  it('0 / 负数 / 非法值返回 "0 B"', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(-1)).toBe('0 B')
    expect(formatBytes(Number.NaN)).toBe('0 B')
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('0 B')
  })

  it('字节段（< 1KB）不带小数', () => {
    expect(formatBytes(1)).toBe('1 B')
    expect(formatBytes(1023)).toBe('1023 B')
  })

  it('KB/MB 段保留一位小数', () => {
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
    expect(Math.round(Number.parseFloat(formatBytes(1.2 * 1024 * 1024)) * 10) / 10).toBe(1.2)
  })

  it('百级大数不带小数（避免过长文案）', () => {
    expect(formatBytes(123 * 1024 * 1024)).toBe('123 MB')
    expect(formatBytes(5 * 1024 * 1024 * 1024)).toBe('5.0 GB')
  })

  it('TB 级封顶在 GB 单位（不出现未知单位）', () => {
    expect(formatBytes(1024 ** 4)).toBe('1024 GB')
  })
})
