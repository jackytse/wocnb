/**
 * useAppUpdate 单测。
 *
 * 依赖全部 mock（与 useCnbReleases.test.ts 同范式）：useCnbAuth 只留
 * isLoggedIn 替身，useCnbReleases 只留 fetchReleases 替身 —— 检查
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

// mock Releases 数据层：fetchReleases（列表）按用例注入响应 ——
// 检查更新走列表接口而非 latest 端点（latest 只认正式版，rc 恒 404）
const fetchReleasesMock = vi.fn()
vi.mock('../useCnbReleases', () => ({
  fetchReleases: (...args: unknown[]) => fetchReleasesMock(...args),
}))

// mock 系统通知发送（useCnbBuildWatch 内部依赖 Tauri 运行时，node 下不存在）。
// 用类型化数组记录入参：比 mock.calls 更易断言，也规避 vi.fn 空签名
// 导致的展开参数 / 元组转型类型问题
const sentNotifications: Array<{ title: string, body: string, payload: { kind: string } }> = []
const sendAppSystemNotificationMock = vi.fn((title: string, body: string, payload: { kind: string }) => {
  sentNotifications.push({ title, body, payload })
  return Promise.resolve(true)
})
vi.mock('../useCnbBuildWatch', () => ({
  sendAppSystemNotification: (title: string, body: string, payload: { kind: string }) =>
    sendAppSystemNotificationMock(title, body, payload),
}))

// mock 应用通知记录（记录本身的行为由 useAppNotices.test.ts 单独锁定）
const pushAppNoticeMock = vi.fn()
vi.mock('../useAppNotices', () => ({
  pushAppNotice: (...args: unknown[]) => pushAppNoticeMock(...args),
}))

import type { ReleaseItem } from '../useCnbReleases'
import {
  APP_RELEASES_PAGE_URL,
  APP_SOURCE_REPO,
  checkForUpdate,
  compareVersions,
  isAutoCheckDue,
  isNewerVersion,
  maybeAutoCheckOnStartup,
  parseVersion,
  pickLatestRelease,
  resetUpdateNotifyStateForTest,
  useAppUpdate,
} from '../useAppUpdate'

beforeEach(() => {
  fetchReleasesMock.mockReset()
  isLoggedInMock.mockReturnValue(true)
  sendAppSystemNotificationMock.mockClear()
  sentNotifications.length = 0
  pushAppNoticeMock.mockClear()
  // 复位「已通知版本」去重状态：通知编排用例之间互不串扰
  resetUpdateNotifyStateForTest()
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
// checkForUpdate：检查流程（fetchReleases 列表全 mock）
// ---------------------------------------------------------------------------

describe('checkForUpdate', () => {
  it('发现新版本 → available + latestVersion 去 v 前缀', async () => {
    fetchReleasesMock.mockResolvedValue([{ id: '1', tagName: 'v0.1.0-rc.26', name: 'rc.26' }])
    const result = await checkForUpdate({ currentVersion: '0.1.0-rc.25' })
    expect(result.available).toBe(true)
    expect(result.latestVersion).toBe('0.1.0-rc.26')
    expect(result.currentVersion).toBe('0.1.0-rc.25')
    expect(result.error).toBe('')
    const { status } = useAppUpdate()
    expect(status.value).toBe('available')
  })

  it('本地已是最新 → upToDate；正式版发布后 rc 也能收到更新提示', async () => {
    fetchReleasesMock.mockResolvedValue([{ id: '2', tagName: 'v0.1.0-rc.25', name: 'rc.25' }])
    const result = await checkForUpdate({ currentVersion: '0.1.0-rc.25' })
    expect(result.available).toBe(false)
    const { status } = useAppUpdate()
    expect(status.value).toBe('upToDate')

    // 正式版 > 同号 rc：即使本地是 rc.25，latest=v0.1.0 也提示更新
    fetchReleasesMock.mockResolvedValue([{ id: '3', tagName: 'v0.1.0', name: '0.1.0' }])
    const formal = await checkForUpdate({ currentVersion: '0.1.0-rc.25' })
    expect(formal.available).toBe(true)
  })

  it('服务端无 Release（404 归一 null）→ upToDate，latestVersion 为空', async () => {
    fetchReleasesMock.mockResolvedValue([])
    const result = await checkForUpdate({ currentVersion: '0.1.0-rc.25' })
    expect(result.available).toBe(false)
    expect(result.latestVersion).toBe('')
    expect(result.release).toBeNull()
    const { status } = useAppUpdate()
    expect(status.value).toBe('upToDate')
  })

  it('请求失败 → error 状态 + lastError 落地，不抛异常', async () => {
    fetchReleasesMock.mockRejectedValue(new Error('403 Missing required scopes: repo-release:r'))
    const result = await checkForUpdate({ currentVersion: '0.1.0-rc.25' })
    expect(result.available).toBe(false)
    expect(result.error).toContain('repo-release:r')
    const { status, lastError } = useAppUpdate()
    expect(status.value).toBe('error')
    expect(lastError.value).toContain('repo-release:r')
  })

  it('本地版本号缺失（浏览器 dev）→ 不误报（available=false）', async () => {
    fetchReleasesMock.mockResolvedValue([{ id: '1', tagName: 'v9.9.9', name: 'x' }])
    const result = await checkForUpdate({ currentVersion: '' })
    expect(result.available).toBe(false)
    const { status } = useAppUpdate()
    expect(status.value).toBe('upToDate')
  })

  it('并发防抖：检查进行中重复调用复用同一 Promise（只发一次请求）', async () => {
    let releaseFetch: Promise<unknown> | null = null
    fetchReleasesMock.mockImplementation(() => {
      releaseFetch = new Promise(resolve => setTimeout(() => resolve([{ id: '1', tagName: 'v0.1.0-rc.99' }]), 10))
      return releaseFetch
    })
    const p1 = checkForUpdate({ currentVersion: '0.1.0-rc.25' })
    const p2 = checkForUpdate({ currentVersion: '0.1.0-rc.25' })
    expect(await p1).toBe(await p2)
    expect(fetchReleasesMock).toHaveBeenCalledTimes(1)
  })

  it('请求指向本应用源码仓库（防呆：改仓库地址只改常量一处）', async () => {
    fetchReleasesMock.mockResolvedValue([{ id: '1', tagName: 'v0.1.0-rc.25', name: '' }])
    await checkForUpdate({ currentVersion: '0.1.0-rc.25' })
    expect(fetchReleasesMock).toHaveBeenCalledWith(APP_SOURCE_REPO, { page: 1, pageSize: 30 })
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
    expect(fetchReleasesMock).not.toHaveBeenCalled()
  })

  it('未登录 → 返回 null，不发请求（登录后才具备 repo-release:r）', async () => {
    isLoggedInMock.mockReturnValue(false)
    const result = await maybeAutoCheckOnStartup({ currentVersion: '0.1.0-rc.25' })
    expect(result).toBeNull()
    expect(fetchReleasesMock).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 发现新版本 → 系统通知 + 应用通知记录（按版本去重）
// ---------------------------------------------------------------------------

describe('发现新版本的通知编排', () => {
  it('首次发现新版本：推系统通知（kind=update）+ 落一条应用通知记录', async () => {
    fetchReleasesMock.mockResolvedValue([{ id: '1', tagName: 'v0.1.0-rc.30', name: 'rc.30' }])
    const result = await checkForUpdate({ currentVersion: '0.1.0-rc.25' })
    expect(result.available).toBe(true)

    expect(sendAppSystemNotificationMock).toHaveBeenCalledTimes(1)
    const { title, body, payload } = sentNotifications[0]    // 标题带新版本号、正文带当前版本（通知中心一眼可辨）
    expect(title).toContain('0.1.0-rc.30')
    expect(body).toContain('0.1.0-rc.25')
    expect(payload.kind).toBe('update')

    expect(pushAppNoticeMock).toHaveBeenCalledTimes(1)
    const record = pushAppNoticeMock.mock.calls[0][0] as { kind: string, title: string, version: string }
    expect(record.kind).toBe('update')
    expect(record.version).toBe('0.1.0-rc.30')
    expect(record.title).toBe(title)
  })

  it('同一版本重复检查（手动/启动节流到期）→ 不重复通知（按版本去重）', async () => {
    fetchReleasesMock.mockResolvedValue([{ id: '1', tagName: 'v0.1.0-rc.30', name: 'rc.30' }])
    await checkForUpdate({ currentVersion: '0.1.0-rc.25' })
    await checkForUpdate({ currentVersion: '0.1.0-rc.25' })
    await checkForUpdate({ currentVersion: '0.1.0-rc.25' })
    expect(sendAppSystemNotificationMock).toHaveBeenCalledTimes(1)
    expect(pushAppNoticeMock).toHaveBeenCalledTimes(1)
  })

  it('出新版本（rc.30 → rc.31）→ 再次通知', async () => {
    fetchReleasesMock.mockResolvedValue([{ id: '1', tagName: 'v0.1.0-rc.30', name: '' }])
    await checkForUpdate({ currentVersion: '0.1.0-rc.25' })
    fetchReleasesMock.mockResolvedValue([{ id: '2', tagName: 'v0.1.0-rc.31', name: '' }])
    await checkForUpdate({ currentVersion: '0.1.0-rc.25' })
    expect(sendAppSystemNotificationMock).toHaveBeenCalledTimes(2)
    expect(pushAppNoticeMock).toHaveBeenCalledTimes(2)
  })

  it('已是最新 / 无 Release / 检查失败 → 不产生任何通知与记录', async () => {
    // 已是最新
    fetchReleasesMock.mockResolvedValue([{ id: '1', tagName: 'v0.1.0-rc.25', name: '' }])
    await checkForUpdate({ currentVersion: '0.1.0-rc.25' })
    // 无 Release（404 归一 null）
    fetchReleasesMock.mockResolvedValue([])
    await checkForUpdate({ currentVersion: '0.1.0-rc.25' })
    // 检查失败
    fetchReleasesMock.mockRejectedValue(new Error('network down'))
    await checkForUpdate({ currentVersion: '0.1.0-rc.25' })

    expect(sendAppSystemNotificationMock).not.toHaveBeenCalled()
    expect(pushAppNoticeMock).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// pickLatestRelease：从 Release 列表挑最新
//
// 背景缺陷（rc.30 实测）：检查更新原本调 GET /releases/latest，而 swagger 明确
// 该端点「仅返回标记为 latest 的正式版本」，本项目 rc 阶段全是 prerelease、
// is_latest=false → 恒 404 → 客户端永远显示"已是最新"。改走列表 + 版本比较。
// ---------------------------------------------------------------------------

/** 构造最小 ReleaseItem（pickLatestRelease 只读 tagName / isDraft） */
function rel(tagName: string, extra: Partial<ReleaseItem> = {}): ReleaseItem {
  return { tagName, ...extra } as ReleaseItem
}

describe('pickLatestRelease', () => {
  it('取版本号最大者，而非列表第一条（补发旧版本不会误判成最新）', () => {
    const picked = pickLatestRelease([
      rel('v0.1.0-rc.29'), // 最新创建（重发/补发场景）
      rel('v0.1.0-rc.31'),
      rel('v0.1.0-rc.30'),
    ])
    expect(picked?.tagName).toBe('v0.1.0-rc.31')
  })

  it('rc 段按数值比较：rc.25 比 rc.9 新', () => {
    expect(pickLatestRelease([rel('v0.1.0-rc.9'), rel('v0.1.0-rc.25')])?.tagName).toBe('v0.1.0-rc.25')
  })

  it('正式版 > 同号预发布（0.1.0 排在 0.1.0-rc.31 之后也是最新）', () => {
    expect(pickLatestRelease([rel('v0.1.0-rc.31'), rel('v0.1.0')])?.tagName).toBe('v0.1.0')
  })

  it('草稿（draft）不参与挑选：用户下载不到，不该提示', () => {
    const picked = pickLatestRelease([
      rel('v0.1.0-rc.32', { isDraft: true }),
      rel('v0.1.0-rc.31'),
    ])
    expect(picked?.tagName).toBe('v0.1.0-rc.31')
  })

  it('空列表 / null / undefined → null', () => {
    expect(pickLatestRelease([])).toBeNull()
    expect(pickLatestRelease(null)).toBeNull()
    expect(pickLatestRelease(undefined)).toBeNull()
  })

  it('全是草稿 → null', () => {
    expect(pickLatestRelease([rel('v1.0.0', { isDraft: true })])).toBeNull()
  })

  it('整列表版本号不可解析 → 退回第一条非草稿（由 isNewerVersion 决定不误报）', () => {
    expect(pickLatestRelease([rel('nightly'), rel('latest-build')])?.tagName).toBe('nightly')
  })

  it('回归：prerelease 也能被发现（latest 端点恒 404 的真实场景）', async () => {
    fetchReleasesMock.mockResolvedValue([
      { id: '2', tagName: 'v0.1.0-rc.31', name: 'rc.31', isDraft: false },
      { id: '1', tagName: 'v0.1.0-rc.30', name: 'rc.30', isDraft: false },
    ])
    const result = await checkForUpdate({ currentVersion: '0.1.0-rc.30' })
    expect(result.available).toBe(true)
    expect(result.latestVersion).toBe('0.1.0-rc.31')
  })
})
