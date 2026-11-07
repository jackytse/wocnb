/**
 * useCnbAuth 纯逻辑单测：403 missingScope 正则 + CnbApiError kind 归一。
 *
 * 只测不依赖网络的纯函数/类构造；cnbFetch/cnbFetchText 的网络链路属通道层，
 * 由 Rust 侧单测（lib.rs build_header_map 等）与人工验收覆盖。
 * 环境依赖 mock：useStorage（node 无 localStorage）、i18n（无需真实翻译）。
 */
import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

// node 环境无 localStorage：把 useStorage 换成普通 ref（仅取其签名）
vi.mock('@vueuse/core', () => ({
  useStorage: (_key: string, initial: unknown) => ref(initial),
}))

// 不加载真实语言包，t 原样返回键名即可
vi.mock('../../i18n', () => ({
  i18n: { global: { t: (key: string) => key } },
}))

import { CnbApiError, parseMissingScope } from '../useCnbAuth'

// ---------------------------------------------------------------------------
// parseMissingScope：从 403 errmsg 抽取缺失权限 scope（风险区 #1 配套）
// ---------------------------------------------------------------------------

describe('parseMissingScope', () => {
  it('标准文案：抽取首个 scope（含 :rw 后缀）', () => {
    expect(parseMissingScope('Missing required scopes: repo-issue:rw')).toBe('repo-issue:rw')
  })

  it('只读 scope（:r）同样可抽取', () => {
    expect(parseMissingScope('Access denied: missing repo-code:r permission')).toBe('repo-code:r')
  })

  it('组织级 scope（group-manage:rw）可抽取', () => {
    expect(parseMissingScope('Missing required scopes: group-manage:rw')).toBe('group-manage:rw')
  })

  it('多 scope 文案取第一个', () => {
    expect(parseMissingScope('Missing required scopes: repo-issue:rw repo-notes:rw')).toBe('repo-issue:rw')
  })

  it('无 scope 特征的 403 文案返回 undefined（风控等场景退化通用提示）', () => {
    expect(parseMissingScope('Forbidden')).toBeUndefined()
    expect(parseMissingScope('rate limited')).toBeUndefined()
    expect(parseMissingScope('')).toBeUndefined()
  })

  it('scope 名可含数字与连字符，不含大写（避免误吞普通单词）', () => {
    expect(parseMissingScope('missing repo-cnb-history:r')).toBe('repo-cnb-history:r')
  })

  // —— QA 回归口径（2026-10-27 修复项 #2）：正则去 /i 后的大写边界 ——
  it('大写形态（Forbidden:Restricted）不得匹配（避免误抽出 Forbidden:R）', () => {
    expect(parseMissingScope('Forbidden:Restricted')).toBeUndefined()
  })

  it('group-resource:r 从标准缺失文案中正确抽取', () => {
    expect(parseMissingScope('Missing required scopes: group-resource:r')).toBe('group-resource:r')
  })

  it('更长 token 的前缀不得误匹配（:rwx 不抽出 :r / :rw）', () => {
    expect(parseMissingScope('missing scope repo-issue:rwx')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// CnbApiError：kind 由状态码归一（403/404/其余）
// ---------------------------------------------------------------------------

describe('CnbApiError', () => {
  it('403 归一为 forbidden，404 归一为 notFound', () => {
    expect(new CnbApiError('x', 403).kind).toBe('forbidden')
    expect(new CnbApiError('x', 404).kind).toBe('notFound')
  })

  it('其余状态码 / 无状态码归一为 network', () => {
    expect(new CnbApiError('x', 500).kind).toBe('network')
    expect(new CnbApiError('x').kind).toBe('network')
  })

  it('显式传入 kind 时不做状态码归一（401 → unauthorized 由调用方控制）', () => {
    expect(new CnbApiError('x', 401, 'unauthorized').kind).toBe('unauthorized')
  })

  it('missingScope 与 status 原样承载', () => {
    const err = new CnbApiError('x', 403, 'forbidden', 'repo-issue:rw')
    expect(err.missingScope).toBe('repo-issue:rw')
    expect(err.status).toBe(403)
    expect(err).toBeInstanceOf(Error)
  })
})
