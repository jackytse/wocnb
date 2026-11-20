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
 * - 自动检查节流口径（从未检查 → 到期；1h 内 → 跳过）；
 * - 自动检测更新开关：默认开；关闭后自动检查完全静默；重新打开立即补查。
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
  DEFAULT_UPDATE_CHANNEL,
  checkForUpdate,
  compareVersions,
  installUpdate,
  isAutoCheckDue,
  isNewerVersion,
  maybeAutoCheckOnStartup,
  normalizeUpdateChannel,
  parseVersion,
  pickLatestRelease,
  relaunchApp,
  resetUpdateAutoCheckStateForTest,
  resetUpdateInstallStateForTest,
  resetUpdateNotifyStateForTest,
  setAutoCheckEnabled,
  setUpdateChannel,
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
  // 复位自动检测更新开关：开关用例之间互不串扰（默认开）
  resetUpdateAutoCheckStateForTest()
  // 复位热更新安装状态 + window stub（installUpdate 用例会 stub Tauri 环境）
  resetUpdateInstallStateForTest()
  vi.unstubAllGlobals()
  checkMock.mockReset()
  // 复位更新通道：固定为 prerelease 作为本文件多数用例的基线（rc 中心
  // 数据在 release 通道会被过滤光）。注意这不再是"默认通道"—— 默认值
  // 已按用户要求改为 release，其验证归 normalizeUpdateChannel 的专用用例
  setUpdateChannel('prerelease')
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

  it('距上次 < 1h → 未到期；≥ 1h → 到期（每小时自动检测一次）', () => {
    expect(isAutoCheckDue(NOW - 30 * 60_000, NOW)).toBe(false)
    expect(isAutoCheckDue(NOW - 3600_000, NOW)).toBe(true)
    expect(isAutoCheckDue(NOW - 2 * 3600_000, NOW)).toBe(true)
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
// 自动检测更新开关：默认开 / 关闭静默 / 重新打开立即补查
// ---------------------------------------------------------------------------

describe('自动检测更新开关', () => {
  it('默认开（用户要求：不落盘过 → 自动检测处于打开状态）', () => {
    expect(useAppUpdate().autoCheckEnabled.value).toBe(true)
  })

  it('关闭后自动检查直接跳过，不发请求（手动「立即检查」不受影响，此处只锁自动路径）', async () => {
    // stub 出 Tauri 环境标志：让守卫链走到开关判定（node 下 window 不存在会先被拦）
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
    setAutoCheckEnabled(false)
    const result = await maybeAutoCheckOnStartup({ currentVersion: '0.1.0-rc.25' })
    expect(result).toBeNull()
    expect(fetchReleasesMock).not.toHaveBeenCalled()
  })

  it('重新打开开关 → 节流到期时立即静默补查一次', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
    setAutoCheckEnabled(false)
    fetchReleasesMock.mockResolvedValue([])
    // 打开动作内部 fire-and-forget 调 maybeAutoCheckOnStartup（从未检查过 → 到期）
    setAutoCheckEnabled(true)
    await vi.waitFor(() => expect(fetchReleasesMock).toHaveBeenCalledTimes(1))
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
    ], 'prerelease')
    expect(picked?.tagName).toBe('v0.1.0-rc.31')
  })

  it('rc 段按数值比较：rc.25 比 rc.9 新', () => {
    expect(pickLatestRelease([rel('v0.1.0-rc.9'), rel('v0.1.0-rc.25')], 'prerelease')?.tagName).toBe('v0.1.0-rc.25')
  })

  it('正式版 > 同号预发布（0.1.0 排在 0.1.0-rc.31 之后也是最新）', () => {
    expect(pickLatestRelease([rel('v0.1.0-rc.31'), rel('v0.1.0')], 'prerelease')?.tagName).toBe('v0.1.0')
  })

  it('草稿（draft）不参与挑选：用户下载不到，不该提示', () => {
    const picked = pickLatestRelease([
      rel('v0.1.0-rc.32', { isDraft: true }),
      rel('v0.1.0-rc.31'),
    ], 'prerelease')
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
    expect(pickLatestRelease([rel('nightly'), rel('latest-build')], 'prerelease')?.tagName).toBe('nightly')
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

// ---------------------------------------------------------------------------
// 更新通道（release / prerelease）
//
// 口径：prerelease 通道参与比较的是"全部非草稿 Release"（含正式版）；
// release 通道只看 prerelease === false 的正式版，绝不提示 rc。
// ---------------------------------------------------------------------------

describe('normalizeUpdateChannel', () => {
  it('合法值原样返回', () => {
    expect(normalizeUpdateChannel('release')).toBe('release')
    expect(normalizeUpdateChannel('prerelease')).toBe('prerelease')
  })

  it('脏值 / 空值 / undefined → 默认通道（不能让非法值落盘后静默不检查）', () => {
    expect(normalizeUpdateChannel('')).toBe(DEFAULT_UPDATE_CHANNEL)
    expect(normalizeUpdateChannel('beta')).toBe(DEFAULT_UPDATE_CHANNEL)
    expect(normalizeUpdateChannel(undefined)).toBe(DEFAULT_UPDATE_CHANNEL)
    expect(normalizeUpdateChannel(null)).toBe(DEFAULT_UPDATE_CHANNEL)
    expect(normalizeUpdateChannel(123)).toBe(DEFAULT_UPDATE_CHANNEL)
  })

  it('默认通道是 release（用户要求：默认只认正式版；rc 阶段默认检测不到更新是既定语义）', () => {
    expect(DEFAULT_UPDATE_CHANNEL).toBe('release')
  })
})

describe('pickLatestRelease · 通道过滤', () => {
  it('release 通道只挑正式版，跳过更新的 rc', () => {
    const picked = pickLatestRelease([
      rel('v0.1.0-rc.32', { isPrerelease: true }),
      rel('v0.1.0-rc.31', { isPrerelease: true }),
      rel('v0.1.0', { isPrerelease: false }),
    ], 'release')
    expect(picked?.tagName).toBe('v0.1.0')
  })

  it('release 通道下全是 rc → null（不能"降级"把 rc 当成正式版）', () => {
    expect(pickLatestRelease([
      rel('v0.1.0-rc.32', { isPrerelease: true }),
      rel('v0.1.0-rc.31', { isPrerelease: true }),
    ], 'release')).toBeNull()
  })

  it('release 通道下 isPrerelease 缺失 → 视为预发布并排除（保守优先）', () => {
    expect(pickLatestRelease([rel('v0.1.0')], 'release')).toBeNull()
  })

  it('prerelease 通道不过滤：rc 与正式版同场竞争，正式版更大（semver）', () => {
    const picked = pickLatestRelease([
      rel('v0.1.0-rc.32', { isPrerelease: true }),
      rel('v0.1.0', { isPrerelease: false }),
    ], 'prerelease')
    expect(picked?.tagName).toBe('v0.1.0')
  })

  it('release 通道的空结果是"无可用版本"，不会回退到草稿/rc', () => {
    expect(pickLatestRelease([
      rel('v0.2.0', { isDraft: true, isPrerelease: false }),
      rel('v0.1.0-rc.32', { isPrerelease: true }),
    ], 'release')).toBeNull()
  })
})

describe('checkForUpdate · 通道生效', () => {
  it('release 通道：只有 rc 可挑 → 已是最新（不提示 rc），且结果标注通道', async () => {
    setUpdateChannel('release')
    fetchReleasesMock.mockResolvedValue([
      { id: '1', tagName: 'v0.1.0-rc.32', isPrerelease: true, isDraft: false },
    ])
    const result = await checkForUpdate({ currentVersion: '0.1.0-rc.31' })
    expect(result.channel).toBe('release')
    expect(result.available).toBe(false)
    expect(result.latestVersion).toBe('')
    expect(useAppUpdate().status.value).toBe('upToDate')
  })

  it('同一批数据切到 prerelease 通道 → 检出 rc.32', async () => {
    setUpdateChannel('prerelease')
    fetchReleasesMock.mockResolvedValue([
      { id: '1', tagName: 'v0.1.0-rc.32', isPrerelease: true, isDraft: false },
    ])
    const result = await checkForUpdate({ currentVersion: '0.1.0-rc.31' })
    expect(result.channel).toBe('prerelease')
    expect(result.available).toBe(true)
    expect(result.latestVersion).toBe('0.1.0-rc.32')
  })

  it('切通道会重置检查状态与上次结果（旧通道结论不能留在新通道界面）', async () => {
    fetchReleasesMock.mockResolvedValue([{ id: '1', tagName: 'v0.1.0-rc.32', isPrerelease: true }])
    await checkForUpdate({ currentVersion: '0.1.0-rc.31' })
    const state = useAppUpdate()
    expect(state.status.value).toBe('available')
    expect(state.latestRelease.value?.tagName).toBe('v0.1.0-rc.32')

    setUpdateChannel('release')
    expect(state.updateChannel.value).toBe('release')
    expect(state.status.value).toBe('idle')
    expect(state.latestRelease.value).toBeNull()
    expect(state.checkedAt.value).toBe(0)
  })

  it('切到相同通道是 no-op（不清结果，避免无谓的界面闪烁）', async () => {
    fetchReleasesMock.mockResolvedValue([{ id: '1', tagName: 'v0.1.0-rc.32', isPrerelease: true }])
    await checkForUpdate({ currentVersion: '0.1.0-rc.31' })
    // 基线是 prerelease（见 beforeEach），切回同通道才是 no-op 场景
    setUpdateChannel('prerelease')
    expect(useAppUpdate().status.value).toBe('available')
  })
})

describe('通知去重按通道隔离', () => {
  it('同一个正式版在两个通道各通知一次（切通道不因去重而静默）', async () => {
    // 两个通道都能看到 v0.1.0（正式版在 prerelease 通道同样可见）
    fetchReleasesMock.mockResolvedValue([
      { id: '1', tagName: 'v0.1.0', isPrerelease: false, isDraft: false },
    ])
    setUpdateChannel('prerelease')
    await checkForUpdate({ currentVersion: '0.1.0-rc.31' })
    expect(sendAppSystemNotificationMock).toHaveBeenCalledTimes(1)

    setUpdateChannel('release')
    await checkForUpdate({ currentVersion: '0.1.0-rc.31' })
    expect(sendAppSystemNotificationMock).toHaveBeenCalledTimes(2)

    // 同通道重复检查仍然只通知一次
    await checkForUpdate({ currentVersion: '0.1.0-rc.31' })
    expect(sendAppSystemNotificationMock).toHaveBeenCalledTimes(2)
  })
})

// ---------------------------------------------------------------------------
// 应用内热更新（installUpdate / relaunchApp）
//
// mock tauri-plugin-updater：check 返回带 downloadAndInstall 的替身对象，
// 按用例驱动 Started/Progress/Finished 事件序列，验证进度回填与终态。
// node 环境无 window：unsupported 用例直接靠这个事实；Tauri 用例用
// vi.stubGlobal 造一个带 __TAURI_INTERNALS__ 的假 window。
// ---------------------------------------------------------------------------
type DownloadEvent =
  | { event: 'Started', data: { contentLength?: number } }
  | { event: 'Progress', data: { chunkLength: number } }
  | { event: 'Finished', data: Record<string, never> }

const checkMock = vi.fn()
const relaunchMock = vi.fn()

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: (...args: unknown[]) => checkMock(...args),
}))
vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: () => relaunchMock(),
}))

/** 构造一个按给定事件序列回调的更新对象 */
function makeUpdate(version: string, events: DownloadEvent[]) {
  return {
    version,
    downloadAndInstall: (onEvent: (e: DownloadEvent) => void) => {
      for (const e of events) {
        onEvent(e)
      }
      return Promise.resolve()
    },
  }
}

/** 造 Tauri 环境 + 让通道检测出 available 的最新版本 */
async function setupTauriWithAvailableUpdate() {
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
  fetchReleasesMock.mockResolvedValue([
    { id: '1', tagName: 'v0.1.0-rc.35', isDraft: false, isPrerelease: true },
  ])
  await checkForUpdate({ currentVersion: '0.1.0-rc.34' })
}

describe('installUpdate · 前置守卫', () => {
  it('非 Tauri 环境（node 无 window）→ unsupported，不触发任何导入', async () => {
    checkMock.mockClear()
    expect(await installUpdate()).toBe('unsupported')
    expect(checkMock).not.toHaveBeenCalled()
  })

  it('尚未做过通道检测（无期望版本）→ no-update', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
    expect(await installUpdate()).toBe('no-update')
    expect(checkMock).not.toHaveBeenCalled()
  })
})

describe('installUpdate · 主流程', () => {
  it('下载安装成功 → ready，进度事件回填百分比', async () => {
    await setupTauriWithAvailableUpdate()
    checkMock.mockResolvedValue(makeUpdate('0.1.0-rc.35', [
      { event: 'Started', data: { contentLength: 1000 } },
      { event: 'Progress', data: { chunkLength: 400 } },
      { event: 'Progress', data: { chunkLength: 600 } },
      { event: 'Finished', data: {} },
    ]))
    const outcome = await installUpdate()
    expect(outcome).toBe('ready')
    const { installStatus, installProgress, installError } = useAppUpdate()
    expect(installStatus.value).toBe('ready')
    expect(installProgress.value).toBe(100)
    expect(installError.value).toBe('')
    expect(checkMock).toHaveBeenCalledTimes(1)
  })

  it('清单版本与通道检测结果不一致（release 通道 vs 清单里的 rc）→ mismatch 拒装', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
    // 通道检测出 rc.35（期望版本），但清单给的是 rc.36 —— 模拟
    // "release 通道用户 + 清单只维护最新 rc" 的通道冲突场景
    fetchReleasesMock.mockResolvedValue([
      { id: '1', tagName: 'v0.1.0-rc.35', isDraft: false, isPrerelease: true },
    ])
    await checkForUpdate({ currentVersion: '0.1.0-rc.34' })
    checkMock.mockResolvedValue(makeUpdate('0.1.0-rc.36', []))
    expect(await installUpdate()).toBe('mismatch')
    // 拒装不算失败：回到 idle，不落安装态
    expect(useAppUpdate().installStatus.value).toBe('idle')
  })

  it('updater check 失败（Windows 缺平台条目 / 网络）→ failed 并落错误原文', async () => {
    await setupTauriWithAvailableUpdate()
    checkMock.mockRejectedValue(new Error('no entry for platform'))
    expect(await installUpdate()).toBe('failed')
    const { installStatus, installError } = useAppUpdate()
    expect(installStatus.value).toBe('failed')
    expect(installError.value).toContain('no entry for platform')
  })

  it('清单无可用更新 → no-update 且状态回 idle', async () => {
    await setupTauriWithAvailableUpdate()
    checkMock.mockResolvedValue(null)
    expect(await installUpdate()).toBe('no-update')
    expect(useAppUpdate().installStatus.value).toBe('idle')
  })

  it('连点保护：下载途中再次调用返回 in-progress，不复用旧调用', async () => {
    await setupTauriWithAvailableUpdate()
    // 让 downloadAndInstall 挂起（不 resolve），模拟下载进行中；
    // installCalled 标记"已真正进入下载"（downloadAndInstall 已被调用），
    // 不能用 installStatus === 'downloading' 当信号 —— 那个状态在 check()
    // 之前就置位了，等不到它就 release() 会拿到未赋值的 resolve
    let resolveInstall!: () => void
    let installCalled = false
    checkMock.mockResolvedValue({
      version: '0.1.0-rc.35',
      downloadAndInstall: () => new Promise<void>((resolve) => {
        installCalled = true
        resolveInstall = resolve
      }),
    })
    const first = installUpdate()
    await vi.waitFor(() => expect(installCalled).toBe(true))
    expect(await installUpdate()).toBe('in-progress')
    resolveInstall()
    expect(await first).toBe('ready')
  })
})

describe('relaunchApp', () => {
  it('Tauri 环境调用插件 relaunch；失败不抛出', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
    relaunchMock.mockClear()
    relaunchMock.mockResolvedValueOnce(undefined)
    await relaunchApp()
    expect(relaunchMock).toHaveBeenCalledTimes(1)

    relaunchMock.mockRejectedValueOnce(new Error('boom'))
    await expect(relaunchApp()).resolves.toBeUndefined()
  })

  it('非 Tauri 环境为 no-op', async () => {
    vi.unstubAllGlobals()
    relaunchMock.mockClear()
    await relaunchApp()
    expect(relaunchMock).not.toHaveBeenCalled()
  })
})
