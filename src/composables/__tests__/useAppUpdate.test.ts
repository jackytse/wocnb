/**
 * useAppUpdate 单测。
 *
 * 依赖全部 mock（与 useCnbReleases.test.ts 同范式）：useCnbAuth 只留
 * isLoggedIn 替身，useCnbReleases 只留 fetchLatestRelease 替身 —— 检查
 * 流程与版本比较逻辑可完全脱离网络与 Tauri 运行。
 *
 * 重点锁定：
 * - 语义化版本比较的三个真实语义坑（正式版 > 同号预发布、rc.9 < rc.25
 *   数值比较、rc.1 < rc.1.1 逐段比较）；
 * - 检查流程：有新版本 → available；无 Release（404 归一 null）→ upToDate；
 *   请求失败 → error 且不抛异常；
 * - 自动检查节流口径（从未检查 → 到期；24h 内 → 跳过）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// mock 认证层：isLoggedIn 按用例注入登录态
const isLoggedInMock = vi.fn(() => true)
vi.mock('../useCnbAuth', () => ({
  isLoggedIn: () => isLoggedInMock(),
}))

// mock Releases 数据层：fetchLatestRelease 按用例注入响应
const fetchLatestReleaseMock = vi.fn()
vi.mock('../useCnbReleases', () => ({
  fetchLatestRelease: (...args: unknown[]) => fetchLatestReleaseMock(...args),
}))

import {
  APP_RELEASES_PAGE_URL,
  APP_SOURCE_REPO,
  checkForUpdate,
  compareVersions,
  isAutoCheckDue,
  isNewerVersion,
  maybeAutoCheckOnStartup,
  parseVersion,
  useAppUpdate,
} from '../useAppUpdate'

beforeEach(() => {
  fetchLatestReleaseMock.mockReset()
  isLoggedInMock.mockReturnValue(true)
  // 复位模块级单例（vi.resetModules 成本高，这里直接驱动状态复位：
  // 跑一次置 error 的检查即可覆盖 checking → error；available/upToDate
  // 由各用例自身的断言顺序保证独立性）
})

// ---------------------------------------------------------------------------
// parseVersion / compareVersions / isNewerVersion：版本比较纯函数
// ---------------------------------------------------------------------------

describe('parseVersion', () => {
  it('解析标准语义化版本与预发布标识', () => {
    expect(parseVersion('0.1.0')).toEqual({ major: 0, minor: 1, patch: 0, prerelease: [] })
    expect(parseVersion('0.1.0-rc.25')).toEqual({ major: 0, minor: 1, patch: 0, prerelease: ['rc', '25'] })
  })

  it('容忍前导 v 与首尾空白（tag 形态 v0.1.0-rc.25）', () => {
    expect(parseVersion(' v0.1.0-rc.25 ')).toEqual({ major: 0, minor: 1, patch: 0, prerelease: ['rc', '25'] })
    expect(parseVersion('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] })
  })

  it('非语义化版本 / 空串 / 两段式 → null（无法比较，不得误报）', () => {
    expect(parseVersion('')).toBeNull()
    expect(parseVersion('0.1')).toBeNull()
    expect(parseVersion('abc')).toBeNull()
    expect(parseVersion('0.1.0-')).toBeNull()
  })
})

describe('compareVersions', () => {
  it('主版本号逐级比较', () => {
    expect(compareVersions('0.2.0', '0.1.0')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0', '0.9.9')).toBeGreaterThan(0)
    expect(compareVersions('0.1.1', '0.1.0')).toBeGreaterThan(0)
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0)
  })

  it('正式版大于同号一切预发布（semver §11.4）', () => {
    expect(compareVersions('0.1.0', '0.1.0-rc.25')).toBeGreaterThan(0)
    expect(compareVersions('0.1.0-rc.25', '0.1.0')).toBeLessThan(0)
    // alpha < rc（字典序）
    expect(compareVersions('0.1.0-alpha.1', '0.1.0-rc.1')).toBeLessThan(0)
  })

  it('预发布数字段按数值比较：rc.9 < rc.25（字典序陷阱）', () => {
    expect(compareVersions('0.1.0-rc.25', '0.1.0-rc.9')).toBeGreaterThan(0)
    expect(compareVersions('0.1.0-rc.9', '0.1.0-rc.25')).toBeLessThan(0)
    expect(compareVersions('0.1.0-rc.25', '0.1.0-rc.25')).toBe(0)
    expect(compareVersions('0.1.0-rc.100', '0.1.0-rc.99')).toBeGreaterThan(0)
  })

  it('标识段逐段比较：先耗尽的一方更小（rc.1 < rc.1.1）', () => {
    expect(compareVersions('0.1.0-rc.1', '0.1.0-rc.1.1')).toBeLessThan(0)
    expect(compareVersions('0.1.0-rc.1.1', '0.1.0-rc.1')).toBeGreaterThan(0)
  })

  it('任一版本无法解析 → null（不是 0！调用方必须按不可比较处理）', () => {
    expect(compareVersions('0.1.0', 'bad')).toBeNull()
    expect(compareVersions('', '0.1.0')).toBeNull()
  })
})

describe('isNewerVersion', () => {
  it('候选 > 当前 → true；相等 / 更旧 → false', () => {
    expect(isNewerVersion('0.1.0-rc.26', '0.1.0-rc.25')).toBe(true)
    expect(isNewerVersion('0.1.0', '0.1.0-rc.25')).toBe(true)
    expect(isNewerVersion('0.1.0-rc.25', '0.1.0-rc.25')).toBe(false)
    expect(isNewerVersion('0.1.0-rc.24', '0.1.0-rc.25')).toBe(false)
  })

  it('本地版本比远端新（开发机跑未发布的 rc）→ false 不提示', () => {
    expect(isNewerVersion('0.1.0-rc.25', '0.1.0-rc.26')).toBe(false)
  })

  it('任一无法解析 → false（保守不提示，绝不误报）', () => {
    expect(isNewerVersion('bad', '0.1.0-rc.25')).toBe(false)
    expect(isNewerVersion('0.1.0-rc.26', '')).toBe(false)
  })

  it('容忍候选带前导 v（tag 直接比较）', () => {
    expect(isNewerVersion('v0.1.0-rc.26', '0.1.0-rc.25')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// checkForUpdate：检查流程（fetchLatestRelease 全 mock）
// ---------------------------------------------------------------------------

describe('checkForUpdate', () => {
  it('发现新版本 → available + latestVersion 去 v 前缀', async () => {
    fetchLatestReleaseMock.mockResolvedValue({ id: '1', tagName: 'v0.1.0-rc.26', name: 'rc.26' })
    const result = await checkForUpdate({ currentVersion: '0.1.0-rc.25' })
    expect(result.available).toBe(true)
    expect(result.latestVersion).toBe('0.1.0-rc.26')
    expect(result.currentVersion).toBe('0.1.0-rc.25')
    expect(result.error).toBe('')
    const { status } = useAppUpdate()
    expect(status.value).toBe('available')
  })

  it('本地已是最新 → upToDate；正式版发布后 rc 也能收到更新提示', async () => {
    fetchLatestReleaseMock.mockResolvedValue({ id: '2', tagName: 'v0.1.0-rc.25', name: 'rc.25' })
    const result = await checkForUpdate({ currentVersion: '0.1.0-rc.25' })
    expect(result.available).toBe(false)
    const { status } = useAppUpdate()
    expect(status.value).toBe('upToDate')

    // 正式版 > 同号 rc：即使本地是 rc.25，latest=v0.1.0 也提示更新
    fetchLatestReleaseMock.mockResolvedValue({ id: '3', tagName: 'v0.1.0', name: '0.1.0' })
    const formal = await checkForUpdate({ currentVersion: '0.1.0-rc.25' })
    expect(formal.available).toBe(true)
  })

  it('服务端无 Release（404 归一 null）→ upToDate，latestVersion 为空', async () => {
    fetchLatestReleaseMock.mockResolvedValue(null)
    const result = await checkForUpdate({ currentVersion: '0.1.0-rc.25' })
    expect(result.available).toBe(false)
    expect(result.latestVersion).toBe('')
    expect(result.release).toBeNull()
    const { status } = useAppUpdate()
    expect(status.value).toBe('upToDate')
  })

  it('请求失败 → error 状态 + lastError 落地，不抛异常', async () => {
    fetchLatestReleaseMock.mockRejectedValue(new Error('403 Missing required scopes: repo-release:r'))
    const result = await checkForUpdate({ currentVersion: '0.1.0-rc.25' })
    expect(result.available).toBe(false)
    expect(result.error).toContain('repo-release:r')
    const { status, lastError } = useAppUpdate()
    expect(status.value).toBe('error')
    expect(lastError.value).toContain('repo-release:r')
  })

  it('本地版本号缺失（浏览器 dev）→ 不误报（available=false）', async () => {
    fetchLatestReleaseMock.mockResolvedValue({ id: '1', tagName: 'v9.9.9', name: 'x' })
    const result = await checkForUpdate({ currentVersion: '' })
    expect(result.available).toBe(false)
    const { status } = useAppUpdate()
    expect(status.value).toBe('upToDate')
  })

  it('并发防抖：检查进行中重复调用复用同一 Promise（只发一次请求）', async () => {
    let releaseFetch: Promise<unknown> | null = null
    fetchLatestReleaseMock.mockImplementation(() => {
      releaseFetch = new Promise(resolve => setTimeout(() => resolve({ id: '1', tagName: 'v0.1.0-rc.99' }), 10))
      return releaseFetch
    })
    const p1 = checkForUpdate({ currentVersion: '0.1.0-rc.25' })
    const p2 = checkForUpdate({ currentVersion: '0.1.0-rc.25' })
    expect(await p1).toBe(await p2)
    expect(fetchLatestReleaseMock).toHaveBeenCalledTimes(1)
  })

  it('请求指向本应用源码仓库（防呆：改仓库地址只改常量一处）', async () => {
    fetchLatestReleaseMock.mockResolvedValue({ id: '1', tagName: 'v0.1.0-rc.25', name: '' })
    await checkForUpdate({ currentVersion: '0.1.0-rc.25' })
    expect(fetchLatestReleaseMock).toHaveBeenCalledWith(APP_SOURCE_REPO)
    expect(APP_SOURCE_REPO).toBe('jackytse/wocnb')
    expect(APP_RELEASES_PAGE_URL).toContain(APP_SOURCE_REPO)
  })
})

// ---------------------------------------------------------------------------
// maybeAutoCheckOnStartup：启动静默检查的前置条件与节流
// ---------------------------------------------------------------------------

describe('isAutoCheckDue', () => {
  const NOW = 1_800_000_000_000
  it('从未检查（0）→ 到期', () => {
    expect(isAutoCheckDue(0, NOW)).toBe(true)
  })

  it('距上次 < 24h → 未到期；≥ 24h → 到期', () => {
    expect(isAutoCheckDue(NOW - 3600_000, NOW)).toBe(false)
    expect(isAutoCheckDue(NOW - 24 * 3600_000, NOW)).toBe(true)
    expect(isAutoCheckDue(NOW - 25 * 3600_000, NOW)).toBe(true)
  })
})

describe('maybeAutoCheckOnStartup', () => {
  it('node 测试环境无 window（非 Tauri）→ 直接返回 null，不发请求', async () => {
    const result = await maybeAutoCheckOnStartup({ currentVersion: '0.1.0-rc.25' })
    expect(result).toBeNull()
    expect(fetchLatestReleaseMock).not.toHaveBeenCalled()
  })

  it('未登录 → 返回 null，不发请求（登录后才具备 repo-release:r）', async () => {
    isLoggedInMock.mockReturnValue(false)
    const result = await maybeAutoCheckOnStartup({ currentVersion: '0.1.0-rc.25' })
    expect(result).toBeNull()
    expect(fetchLatestReleaseMock).not.toHaveBeenCalled()
  })
})
