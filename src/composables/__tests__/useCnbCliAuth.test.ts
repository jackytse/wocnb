/**
 * useCnbCliAuth 纯逻辑单测：临期判定边界 + 设备码提取。
 *
 * 只测不依赖网络的纯函数；CLI 检测/安装/设备授权流程属 IPC 通道层，
 * 由 Rust 侧单测（cnb_cli.rs：令牌解析/过期判定/输出解析）与
 * QA 真机验收覆盖。
 * 环境依赖 mock：useStorage（node 无 localStorage）、i18n（无需真实翻译）。
 */
import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

// node 环境无 localStorage：把 useStorage 换成普通 ref（仅取其签名）
vi.mock('@vueuse/core', () => ({
  useStorage: (_key: string, initial: unknown) => ref(initial),
}))

// 不加载真实语言包，t 原样返回键名即可
vi.mock('../i18n', () => ({
  i18n: { global: { t: (key: string) => key } },
}))

import { extractUserCode, isTokenExpiring } from '../useCnbCliAuth'

// ---------------------------------------------------------------------------
// isTokenExpiring：OAuth 令牌临期/过期判定（<10min 临界，与 Rust 侧语义一致）
// ---------------------------------------------------------------------------

describe('isTokenExpiring', () => {
  const margin = 10 * 60 * 1000 // 10 分钟（默认阈值）

  it('正常用例：距过期超过 10 分钟 → 未临期', () => {
    const expiresAtSec = 10_000_000
    const nowMs = (expiresAtSec - 601) * 1000 // 距过期 601s > 600s
    expect(isTokenExpiring(expiresAtSec, nowMs, margin)).toBe(false)
  })

  it('临界点：恰好距过期 10 分钟 → 已算临期（提前刷新优先于压哨使用）', () => {
    const expiresAtSec = 10_000_000
    const nowMs = (expiresAtSec - 600) * 1000 // 恰好 600s
    expect(isTokenExpiring(expiresAtSec, nowMs, margin)).toBe(true)
  })

  it('临界点后 1ms → 临期', () => {
    const expiresAtSec = 10_000_000
    const nowMs = (expiresAtSec - 600) * 1000 + 1
    expect(isTokenExpiring(expiresAtSec, nowMs, margin)).toBe(true)
  })

  it('已过期 → 临期', () => {
    const expiresAtSec = 10_000_000
    expect(isTokenExpiring(expiresAtSec, expiresAtSec * 1000 + 1, margin)).toBe(true)
  })

  it('expiresAt 缺失/非法（0、负数、NaN）→ 恒判临期（宁可多刷新）', () => {
    expect(isTokenExpiring(0, Date.now(), margin)).toBe(true)
    expect(isTokenExpiring(-5, Date.now(), margin)).toBe(true)
    expect(isTokenExpiring(Number.NaN, Date.now(), margin)).toBe(true)
  })

  it('自定义阈值生效（margin=0 时仅过期才临期）', () => {
    const expiresAtSec = 10_000_000
    const nowMs = (expiresAtSec - 60) * 1000
    expect(isTokenExpiring(expiresAtSec, nowMs, 0)).toBe(false)
    expect(isTokenExpiring(expiresAtSec, expiresAtSec * 1000, 0)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// extractUserCode：从验证链接提取设备码（verification_uri_complete 内嵌）
// ---------------------------------------------------------------------------

describe('extractUserCode', () => {
  it('标准链接（实测格式）：提取 user_code 参数', () => {
    expect(
      extractUserCode('https://cnb.cool/oauth2/device/verify?user_code=TESTCODE'),
    ).toBe('TESTCODE')
  })

  it('多参数链接：正确提取 user_code', () => {
    expect(
      extractUserCode('https://cnb.cool/oauth2/device/verify?x=1&user_code=AB12CD'),
    ).toBe('AB12CD')
  })

  it('无 user_code 参数 → 空串（界面隐藏设备码区）', () => {
    expect(extractUserCode('https://cnb.cool/oauth2/device/verify')).toBe('')
  })

  it('非法 URL → 空串（子进程输出按不可信文本处理）', () => {
    expect(extractUserCode('not a url')).toBe('')
    expect(extractUserCode('')).toBe('')
  })
})
