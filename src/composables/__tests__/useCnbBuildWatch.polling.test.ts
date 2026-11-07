/**
 * 构建通知轮询的**行为级**单测（QA 补充）。
 *
 * 与工程师的 useCnbBuildWatch.test.ts（只测纯函数）互补：本文件驱动真实的
 * initBuildWatcher() / runTick() / 定时器，覆盖纯函数测不到的验收要点：
 *   a) 首轮基线绝不产生通知；
 *   c) 回查失败（状态未知）不发系统通知；一次结束 >5 个合并成摘要；
 *   d) 403 只跳过仓库 + 计数，绝不登出；
 *   e) 慢请求下 tick 不堆叠（重入保护覆盖所有退出路径）；
 *   f) 启动阶段不弹系统通知权限框。
 *
 * ## 测试环境构造（为什么这么绕）
 *
 * 1. `environment: 'node'` 没有 window/localStorage，而 @vueuse 的 useStorage 在
 *    `defaultWindow` 为空时会**退化成普通 ref**（不落盘）。为了让「持久化快照」
 *    这类场景可控，本文件按 Storage 契约实现了内存版 localStorage，并在 import
 *    被测模块**之前**挂到 globalThis 上，让 @vueuse 在模块求值时捕获到它。
 * 2. 模块私有状态（baselineReady / tickRunning / repoCache / scopeMissing…）无法
 *    从外部重置，而 `vi.resetModules()` 会留下仍然订阅着共享 ref 的**旧 watcher**
 *    （旧模块实例继续抢 tick，导致请求数翻倍）。因此本文件**只 import 一次**，
 *    用「先切到垫片组织、再切到目标组织」的方式借用 restartWatcher 的组织切换
 *    分支完成每个用例的状态重置（重置快照 / 缓存 / 缺权限记录 / 基线标记）。
 * 3. 定时器全部用假时钟推进，sleep / 请求错峰都不会真正等待。
 */
import type { Mock } from 'vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

// ---------------------------------------------------------------------------
// 依赖替身（网络层与系统通知插件全部 mock，只留真实的轮询逻辑）
// ---------------------------------------------------------------------------
vi.mock('../useCnbAuth', async () => {
  const { ref } = await import('vue')
  class FakeCnbApiError extends Error {
    kind: string
    status?: number
    constructor(message?: string, status?: number, kind = 'network') {
      super(message)
      this.status = status
      this.kind = kind
    }
  }
  return {
    cnbToken: ref(''),
    selectedGroup: ref<{ path: string } | null>(null),
    fetchCnbGroupRepos: vi.fn(async () => []),
    logout: vi.fn(),
    CnbApiError: FakeCnbApiError,
  }
})

vi.mock('../useCnbRepo', () => ({
  fetchBuildLogs: vi.fn(async () => ({ total: 0, items: [] })),
}))

vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: vi.fn(async () => true),
  requestPermission: vi.fn(async () => 'granted'),
  sendNotification: vi.fn(),
}))

// ---------------------------------------------------------------------------
// 内存版 localStorage（只实现 useStorage 用到的 Storage 契约）
// ---------------------------------------------------------------------------
class FakeStorage {
  private map = new Map<string, string>()

  get length(): number {
    return this.map.size
  }

  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null
  }

  setItem(key: string, value: string): void {
    this.map.set(key, String(value))
  }

  removeItem(key: string): void {
    this.map.delete(key)
  }

  clear(): void {
    this.map.clear()
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null
  }
}

const FIRST_TICK_DELAY = 3000
const DEFAULT_INTERVAL = 60000
/**
 * 单轮 tick 的额外时间余量。
 *
 * runWithLimit 的请求错峰会在 tick **内部**再排 sleep(150) 等定时器，
 * 只推进"恰好一个间隔"会让本轮停在半空中（tickRunning 卡住 → 后续用例全被
 * 重入保护挡掉）。因此每次推进都多给一点时间，让本轮彻底跑完再断言。
 */
const TICK_PAD = 5000
/** 垫片组织：先切到它再切到目标组织，强制走 restartWatcher 的组织切换分支 */
const SCAFFOLD_GROUP = '__qa_scaffold__'

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------
/** fetchBuildLogs 返回的构建条目 */
interface FakeLog {
  sn: string
  status: string
  commitTitle: string
  sourceRef: string
  nickName: string
  createTime: string
}

/** 一条 pending 构建 */
function pendingLog(sn: string): FakeLog {
  return {
    sn,
    status: 'pending',
    commitTitle: `commit-${sn}`,
    sourceRef: 'main',
    nickName: 'tester',
    createTime: '2026-01-01T00:00:00Z',
  }
}

/** 终态构建 */
function doneLog(sn: string, status: string): FakeLog {
  return { ...pendingLog(sn), status }
}

/** 组织仓库条目（只填 watch 用到的字段） */
function repo(path: string) {
  return { path, name: path.split('/').pop() || path, updatedAt: '2026-01-01T00:00:00Z' }
}

interface Scenario {
  /** 当前选中组织；null 表示启动早期组织未就绪 */
  group: string | null
  token?: string
  /** 是否伪造 Tauri 运行时（系统通知链路） */
  tauri?: boolean
  repos?: ReturnType<typeof repo>[]
  /** 仓库列表接口是否失败 */
  listFails?: boolean
  /** pending 查询：返回该仓库当前 pending 列表；抛错即请求失败 */
  pendingOf?: (repoPath: string) => FakeLog[]
  /** sn 回查：返回终态条目 / 抛错 */
  resolveOf?: (repoPath: string, sn: string) => FakeLog[] | Error
  /** 预置快照（模拟上一会话持久化的 pending 快照） */
  seedSnapshot?: Record<string, Record<string, unknown>>
}

interface Harness {
  auth: {
    cnbToken: { value: string }
    selectedGroup: { value: { path: string } | null }
    fetchCnbGroupRepos: Mock
    logout: Mock
  }
  repo: { fetchBuildLogs: Mock }
  notify: { isPermissionGranted: Mock, requestPermission: Mock, sendNotification: Mock }
  watch: typeof import('../useCnbBuildWatch')
}

/** 全局唯一的模块实例（见文件头说明 2） */
let harness: Harness | null = null

/** 构造内存存储 + 伪 window，并只 import 一次被测模块 */
async function ensureHarness(): Promise<Harness> {
  if (harness) {
    return harness
  }
  const storage = new FakeStorage()
  const fakeWindow: Record<string, unknown> = {
    localStorage: storage,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  }
  ;(globalThis as unknown as { Storage: unknown }).Storage = FakeStorage
  ;(globalThis as unknown as { window: unknown }).window = fakeWindow

  const auth = await import('../useCnbAuth')
  const repoModule = await import('../useCnbRepo')
  const notify = await import('@tauri-apps/plugin-notification')
  const watch = await import('../useCnbBuildWatch')

  harness = {
    auth: auth as unknown as Harness['auth'],
    repo: repoModule as unknown as Harness['repo'],
    notify: notify as unknown as Harness['notify'],
    watch,
  }
  // watch 只注册一次；后续用例靠组织切换重置状态
  watch.initBuildWatcher()
  return harness
}

/** 切换 Tauri 运行时标记（isTauriEnv 每次调用都实时读 window） */
function setTauriRuntime(on: boolean): void {
  const win = (globalThis as unknown as { window?: Record<string, unknown> }).window
  if (!win) {
    return
  }
  if (on) {
    win.__TAURI_INTERNALS__ = {}
  }
  else {
    delete win.__TAURI_INTERNALS__
  }
}

/**
 * 准备一个干净的场景：重置 mock → 重置开关/间隔 → 借组织切换清空模块私有状态。
 * 返回后，首轮 tick 已排在 FIRST_TICK_DELAY 之后。
 */
async function begin(scenario: Scenario): Promise<Harness> {
  const h = await ensureHarness()

  // —— mock 逐用例重置 ——
  h.notify.isPermissionGranted.mockReset()
  h.notify.isPermissionGranted.mockImplementation(async () => true)
  h.notify.requestPermission.mockReset()
  h.notify.requestPermission.mockImplementation(async () => 'granted')
  h.notify.sendNotification.mockReset()
  h.auth.logout.mockReset()

  const repos = scenario.repos ?? []
  h.auth.fetchCnbGroupRepos.mockReset()
  h.auth.fetchCnbGroupRepos.mockImplementation(async () => {
    if (scenario.listFails) {
      throw new Error('repo list down')
    }
    return repos
  })

  h.repo.fetchBuildLogs.mockReset()
  h.repo.fetchBuildLogs.mockImplementation(async (
    repoPath: string,
    opts: { status?: string, sn?: string } = {},
  ) => {
    if (opts.sn) {
      const result = scenario.resolveOf?.(repoPath, opts.sn)
      if (result instanceof Error) {
        throw result
      }
      return { total: result?.length ?? 0, items: result ?? [] }
    }
    const items = scenario.pendingOf?.(repoPath) ?? []
    return { total: items.length, items }
  })

  // —— 面板与配置归位 ——
  h.watch.buildNoticeFeed.value = []
  h.watch.markBuildNoticesRead()
  h.watch.buildNotifyEnabled.value = true
  h.watch.buildNotifyIntervalSec.value = 60
  h.watch.buildSnapshot.value = {}

  // —— 借组织切换重置模块私有状态（快照 / 缓存 / 缺权限 / 基线标记）——
  h.auth.cnbToken.value = scenario.token ?? 'test-token'
  h.auth.selectedGroup.value = { path: SCAFFOLD_GROUP }
  await nextTick()
  h.auth.selectedGroup.value = scenario.group ? { path: scenario.group } : null
  await nextTick()

  // 组织切换会把快照清空；需要预置快照的用例在重置之后落盘
  if (scenario.seedSnapshot) {
    h.watch.buildSnapshot.value = scenario.seedSnapshot as unknown as typeof h.watch.buildSnapshot.value
  }

  setTauriRuntime(scenario.tauri === true)
  return h
}

/** 推进假时钟并让 Vue 调度队列落地 */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await nextTick()
}

/** 统计某类请求的调用次数（不带 query 只统计 pending 列表查询） */
function countCalls(h: Harness, kind: 'pending' | 'sn'): number {
  return h.repo.fetchBuildLogs.mock.calls.filter(([, opts]) => {
    const hasSn = !!(opts as { sn?: string } | undefined)?.sn
    return kind === 'sn' ? hasSn : !hasSn
  }).length
}

/** 取第 n 次系统通知的入参（插件 API 是 sendNotification({ title, body }) 单对象） */
function notificationPayload(h: Harness, index: number): { title: string, body: string } {
  return h.notify.sendNotification.mock.calls[index]?.[0] as { title: string, body: string }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// f) 权限：启动不弹窗（放在最前：permissionRequested / notificationGranted 是
//    模块级一次性状态，只能在模块生命周期的早期断言）
// ---------------------------------------------------------------------------
describe('f) 系统通知权限：启动不弹窗', () => {
  it('启动 + 建立基线期间既不查权限也不申请', async () => {
    const h = await begin({
      group: 'orgA',
      tauri: true,
      repos: [repo('orgA/repo1')],
      pendingOf: () => [pendingLog('1')],
    })
    h.notify.isPermissionGranted.mockImplementation(async () => false)

    await advance(FIRST_TICK_DELAY + TICK_PAD)

    expect(h.notify.isPermissionGranted).not.toHaveBeenCalled()
    expect(h.notify.requestPermission).not.toHaveBeenCalled()
    expect(h.notify.sendNotification).not.toHaveBeenCalled()
  })

  it('首次真的要发通知时才申请一次；同一会话不重复申请', async () => {
    let hasPending = true
    const h = await begin({
      group: 'orgA',
      tauri: true,
      repos: [repo('orgA/repo1')],
      pendingOf: () => (hasPending ? [pendingLog('1')] : []),
      resolveOf: (_repoPath, sn) => [doneLog(sn, 'error')],
    })
    // 用户尚未授权：第一次要发通知时才申请
    let grantedYet = false
    h.notify.isPermissionGranted.mockImplementation(async () => grantedYet)
    h.notify.requestPermission.mockImplementation(async () => {
      grantedYet = true
      return 'granted'
    })

    await advance(FIRST_TICK_DELAY + TICK_PAD)
    expect(h.notify.requestPermission).not.toHaveBeenCalled()

    hasPending = false
    await advance(DEFAULT_INTERVAL + TICK_PAD)

    expect(h.notify.requestPermission).toHaveBeenCalledTimes(1)
    expect(h.notify.sendNotification).toHaveBeenCalledTimes(1)

    // 再结束一个构建：权限已缓存，不再申请
    hasPending = true
    await advance(DEFAULT_INTERVAL + TICK_PAD)
    hasPending = false
    await advance(DEFAULT_INTERVAL + TICK_PAD)
    expect(h.notify.requestPermission).toHaveBeenCalledTimes(1)
    expect(h.notify.sendNotification).toHaveBeenCalledTimes(2)
  })

  it('非 Tauri 环境静默降级：不加载通知插件、只写应用内通知', async () => {
    let hasPending = true
    const h = await begin({
      group: 'orgA',
      tauri: false,
      repos: [repo('orgA/repo1')],
      pendingOf: () => (hasPending ? [pendingLog('1')] : []),
      resolveOf: (_repoPath, sn) => [doneLog(sn, 'success')],
    })

    await advance(FIRST_TICK_DELAY + TICK_PAD)
    hasPending = false
    await advance(DEFAULT_INTERVAL + TICK_PAD)

    expect(h.watch.buildNoticeFeed.value).toHaveLength(1)
    expect(h.watch.buildNoticeFeed.value[0]?.status).toBe('success')
    expect(h.notify.isPermissionGranted).not.toHaveBeenCalled()
    expect(h.notify.sendNotification).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// a) 首轮基线
// ---------------------------------------------------------------------------
describe('a) 首轮基线：绝不产生通知', () => {
  it('快照为空 + 组织已有历史 pending → 只建基线，无应用内通知也无系统通知', async () => {
    const h = await begin({
      group: 'orgA',
      tauri: true,
      repos: [repo('orgA/repo1')],
      pendingOf: () => [pendingLog('1'), pendingLog('2'), pendingLog('3')],
    })

    await advance(FIRST_TICK_DELAY + TICK_PAD)

    expect(h.watch.buildNoticeFeed.value).toHaveLength(0)
    expect(h.notify.sendNotification).not.toHaveBeenCalled()
    expect(Object.keys(h.watch.buildSnapshot.value['orgA/repo1']!).sort()).toEqual(['1', '2', '3'])
  })

  it('基线轮不发起 sn 回查（没有"结束"就没有回查）', async () => {
    const h = await begin({
      group: 'orgA',
      repos: [repo('orgA/repo1')],
      pendingOf: () => [pendingLog('1')],
    })

    await advance(FIRST_TICK_DELAY + TICK_PAD)

    expect(countCalls(h, 'sn')).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// c) 回查失败 != 成功
// ---------------------------------------------------------------------------
describe('c) 回查失败/非终态：只进面板，不弹系统通知', () => {
  it('sn 回查抛错 → 面板状态未知，系统通知不发送', async () => {
    let hasPending = true
    const h = await begin({
      group: 'orgA',
      tauri: true,
      repos: [repo('orgA/repo1')],
      pendingOf: () => (hasPending ? [pendingLog('1')] : []),
      resolveOf: () => new Error('boom'),
    })

    await advance(FIRST_TICK_DELAY + TICK_PAD)
    hasPending = false
    await advance(DEFAULT_INTERVAL + TICK_PAD)

    const feed = h.watch.buildNoticeFeed.value
    expect(feed).toHaveLength(1)
    expect(feed[0]?.status).toBe('')
    expect(feed[0]?.leftover).toBe(false)
    expect(h.notify.sendNotification).not.toHaveBeenCalled()
  })

  it('sn 回查返回 pending（重跑竞态）→ 判为状态未知，系统通知不发送', async () => {
    let hasPending = true
    const h = await begin({
      group: 'orgA',
      tauri: true,
      repos: [repo('orgA/repo1')],
      pendingOf: () => (hasPending ? [pendingLog('1')] : []),
      resolveOf: () => [pendingLog('1')],
    })

    await advance(FIRST_TICK_DELAY + TICK_PAD)
    hasPending = false
    await advance(DEFAULT_INTERVAL + TICK_PAD)

    expect(h.watch.buildNoticeFeed.value[0]?.status).toBe('')
    expect(h.notify.sendNotification).not.toHaveBeenCalled()
  })

  it('sn 回查查不到条目（分页挤出）→ 判为状态未知，系统通知不发送', async () => {
    let hasPending = true
    const h = await begin({
      group: 'orgA',
      tauri: true,
      repos: [repo('orgA/repo1')],
      pendingOf: () => (hasPending ? [pendingLog('1')] : []),
      resolveOf: () => [],
    })

    await advance(FIRST_TICK_DELAY + TICK_PAD)
    hasPending = false
    await advance(DEFAULT_INTERVAL + TICK_PAD)

    expect(h.watch.buildNoticeFeed.value[0]?.status).toBe('')
    expect(h.notify.sendNotification).not.toHaveBeenCalled()
  })

  it('回查到 success 才发系统通知（对照组）', async () => {
    let hasPending = true
    const h = await begin({
      group: 'orgA',
      tauri: true,
      repos: [repo('orgA/repo1')],
      pendingOf: () => (hasPending ? [pendingLog('1')] : []),
      resolveOf: (_repoPath, sn) => [doneLog(sn, 'success')],
    })

    await advance(FIRST_TICK_DELAY + TICK_PAD)
    hasPending = false
    await advance(DEFAULT_INTERVAL + TICK_PAD)

    expect(h.watch.buildNoticeFeed.value[0]?.status).toBe('success')
    expect(h.notify.sendNotification).toHaveBeenCalledTimes(1)
    // 注意：插件 API 是 sendNotification({ title, body }) 单对象入参
    expect(notificationPayload(h, 0).title).toContain('succeeded')
  })
})

// ---------------------------------------------------------------------------
// 合并通知
// ---------------------------------------------------------------------------
describe('一次结束多个构建：逐条 vs 摘要', () => {
  it('一次结束 5 个 → 5 条系统通知（未越过合并阈值）', async () => {
    let hasPending = true
    const sns = ['1', '2', '3', '4', '5']
    const h = await begin({
      group: 'orgA',
      tauri: true,
      repos: [repo('orgA/repo1')],
      pendingOf: () => (hasPending ? sns.map(sn => pendingLog(sn)) : []),
      resolveOf: (_repoPath, sn) => [doneLog(sn, 'success')],
    })

    await advance(FIRST_TICK_DELAY + TICK_PAD)
    hasPending = false
    await advance(DEFAULT_INTERVAL + TICK_PAD)

    expect(h.watch.buildNoticeFeed.value).toHaveLength(5)
    expect(h.notify.sendNotification).toHaveBeenCalledTimes(5)
  })

  it('一次结束 6 个 → 1 条摘要系统通知 + 6 条面板记录', async () => {
    let hasPending = true
    const sns = ['1', '2', '3', '4', '5', '6']
    const h = await begin({
      group: 'orgA',
      tauri: true,
      repos: [repo('orgA/repo1')],
      pendingOf: () => (hasPending ? sns.map(sn => pendingLog(sn)) : []),
      resolveOf: (_repoPath, sn) => [doneLog(sn, sn === '6' ? 'error' : 'success')],
    })

    await advance(FIRST_TICK_DELAY + TICK_PAD)
    hasPending = false
    await advance(DEFAULT_INTERVAL + TICK_PAD)

    expect(h.watch.buildNoticeFeed.value).toHaveLength(6)
    expect(h.notify.sendNotification).toHaveBeenCalledTimes(1)
    const { title, body } = notificationPayload(h, 0)
    expect(title).toContain('6 builds finished')
    expect(body).toContain('Succeeded 5')
    expect(body).toContain('Failed 1')
  })

  it('6 个构建全部回查失败（全 unknown）→ 只写面板，不发系统通知', async () => {
    // 回归守护（原缺陷 #1）：digest 分支曾无条件 sendSystemNotification，
    // 导致"6 个构建结束且 sn 回查全失败"时弹「6 builds finished」，
    // 违反"状态未知不发系统通知"的设计。修复后 digest 分支要求
    // success+error+cancel > 0 才发通知，全 unknown 只进面板。
    let hasPending = true
    const sns = ['1', '2', '3', '4', '5', '6']
    const h = await begin({
      group: 'orgA',
      tauri: true,
      repos: [repo('orgA/repo1')],
      pendingOf: () => (hasPending ? sns.map(sn => pendingLog(sn)) : []),
      resolveOf: () => new Error('boom'),
    })

    await advance(FIRST_TICK_DELAY + TICK_PAD)
    hasPending = false
    await advance(DEFAULT_INTERVAL + TICK_PAD)

    const feed = h.watch.buildNoticeFeed.value
    // 面板记录照旧保留（用户可在应用内看到"有 6 个构建结束，状态未知"）
    expect(feed).toHaveLength(6)
    expect(feed.every(item => item.status === '')).toBe(true)
    // 但绝不能用"状态未知"打扰系统通知中心
    expect(h.notify.sendNotification).not.toHaveBeenCalled()
  })

  it('摘要里混有未知状态 → 发通知，正文追加"另有 N 个状态未知"', async () => {
    // 与上一条互补：有确定终态就发（摘要仍有信息量），未知数另附一句，
    // 避免"成功 3 / 失败 0 / 取消 0"看起来像丢了 3 条构建。
    let hasPending = true
    const sns = ['1', '2', '3', '4', '5', '6']
    const h = await begin({
      group: 'orgA',
      tauri: true,
      repos: [repo('orgA/repo1')],
      pendingOf: () => (hasPending ? sns.map(sn => pendingLog(sn)) : []),
      // 前 3 条回查成功，后 3 条回查抛错（状态未知）
      resolveOf: (_repoPath, sn) => (Number(sn) <= 3 ? [doneLog(sn, 'success')] : new Error('boom')),
    })

    await advance(FIRST_TICK_DELAY + TICK_PAD)
    hasPending = false
    await advance(DEFAULT_INTERVAL + TICK_PAD)

    expect(h.watch.buildNoticeFeed.value).toHaveLength(6)
    expect(h.notify.sendNotification).toHaveBeenCalledTimes(1)
    const { title, body } = notificationPayload(h, 0)
    // 计数自洽：标题用总数 6，正文 = 确定终态 3 + 未知后缀 3，四项相加恰好等于总数
    expect(title).toContain('6 builds finished')
    expect(body).toContain('Succeeded 3')
    // 未知数必须带上**具体数字**（只断言 "unknown status" 会漏掉计数错误的可能）
    expect(body).toContain('3 with unknown status')
  })
})

// ---------------------------------------------------------------------------
// d) 403 不登出 / 跨仓库不串味
// ---------------------------------------------------------------------------
describe('d) 权限错误：403 跳过 + 计数，绝不登出', () => {
  it('某仓库 pending 查询 403 → 计入缺权限数、跳过该仓库、不登出、不误报已结束', async () => {
    let forbidden = false
    const h = await begin({
      group: 'orgA',
      repos: [repo('orgA/repo1'), repo('orgA/repo2')],
      pendingOf: (repoPath) => {
        if (repoPath === 'orgA/repo1') {
          if (forbidden) {
            // 真缺权限：errmsg 可解析出具体 scope（parseMissingScope 的产出）
          throw { kind: 'forbidden', status: 403, missingScope: 'repo-cnb-history:r' }
          }
          return [pendingLog('1')]
        }
        return [pendingLog('2')]
      },
    })

    await advance(FIRST_TICK_DELAY + TICK_PAD)
    expect(h.watch.buildScopeMissingCount.value).toBe(0)

    forbidden = true
    await advance(DEFAULT_INTERVAL + TICK_PAD)

    expect(h.watch.buildScopeMissingCount.value).toBe(1)
    // 绝不登出：令牌未被清除、轮询层从未调用 logout
    expect(h.auth.logout).not.toHaveBeenCalled()
    expect(h.auth.cnbToken.value).toBe('test-token')
    // 失败仓库的上一轮快照被原样并入 → 不会把"请求失败"误判成"构建已结束"
    expect(h.watch.buildNoticeFeed.value).toHaveLength(0)
    expect(Object.keys(h.watch.buildSnapshot.value['orgA/repo1'] ?? {})).toEqual(['1'])
    // 关注数量口径（缺陷 #6）：2 个仓库中 1 个缺权限 → "当前关注"应为 1，
    // 不能把根本没在轮询的仓库也算进去
    expect(h.watch.buildWatchRepoCount.value).toBe(1)
  })

  it('sn 回查 403 → 同样只记缺权限，不影响登出状态', async () => {
    let hasPending = true
    // 真实链路抛的是 CnbApiError（kind=forbidden）；这里用带 kind 的 Error 等价模拟
    // 真缺权限：kind=forbidden + 能解析出 scope → 才允许永久跳过该仓库
    const forbidden = Object.assign(new Error('403 Forbidden'), {
      kind: 'forbidden',
      status: 403,
      missingScope: 'repo-cnb-history:r',
    })
    const h = await begin({
      group: 'orgA',
      tauri: true,
      repos: [repo('orgA/repo1')],
      pendingOf: () => (hasPending ? [pendingLog('1')] : []),
      resolveOf: () => forbidden,
    })

    await advance(FIRST_TICK_DELAY + TICK_PAD)
    hasPending = false
    await advance(DEFAULT_INTERVAL + TICK_PAD)

    expect(h.watch.buildScopeMissingCount.value).toBe(1)
    expect(h.auth.logout).not.toHaveBeenCalled()
    expect(h.watch.buildNoticeFeed.value[0]?.status).toBe('')
    expect(h.notify.sendNotification).not.toHaveBeenCalled()
  })

  it('缺权限仓库在本次会话内不再重复请求', async () => {
    const h = await begin({
      group: 'orgA',
      repos: [repo('orgA/repo1')],
      pendingOf: () => {
        // 真缺权限：errmsg 可解析出具体 scope（parseMissingScope 的产出）
          throw { kind: 'forbidden', status: 403, missingScope: 'repo-cnb-history:r' }
      },
    })

    await advance(FIRST_TICK_DELAY + TICK_PAD)
    const afterFirst = countCalls(h, 'pending')
    await advance(DEFAULT_INTERVAL + TICK_PAD)

    // 第二轮不再对该仓库发起请求（scopeMissing 过滤）
    expect(countCalls(h, 'pending')).toBe(afterFirst)
    expect(h.watch.buildScopeMissingCount.value).toBe(1)
  })

  it('缺权限仓库被跳过后的下一轮，不会凭空冒出"已结束"（回归 #2 假警报）', async () => {
    // 复现路径（原缺陷 #2）：
    //   轮 1：pending 查询成功 → 基线里有 sn=1
    //   轮 2：403 → 计入 scopeMissing，同时把上一轮快照并回 next（正确，不误报）
    //   轮 3（修复前）：该仓库已被 scopeMissing 过滤 → 不再进入 tasks → 也不在
    //         failedRepos 里 → 它的上一轮快照没被并回 next → diff 判定"sn=1 已结束"
    //         → 面板冒出状态未知的假"已结束"条目。
    // 修复：被跳过的仓库与"请求失败"同等对待，一起把上一轮快照并回 next。
    // 断言 feed 始终为空 —— 宁可漏报，绝不能误报。
    let mode: 'ok' | 'forbidden' = 'ok'
    const h = await begin({
      group: 'orgA',
      tauri: true,
      repos: [repo('orgA/repo1')],
      pendingOf: () => {
        if (mode === 'forbidden') {
          // 真缺权限：errmsg 可解析出具体 scope（parseMissingScope 的产出）
          throw { kind: 'forbidden', status: 403, missingScope: 'repo-cnb-history:r' }
        }
        return [pendingLog('1')]
      },
    })

    await advance(FIRST_TICK_DELAY + TICK_PAD)
    expect(Object.keys(h.watch.buildSnapshot.value['orgA/repo1'] ?? {})).toEqual(['1'])

    // 轮 2：403，快照被保住，不误报
    mode = 'forbidden'
    await advance(DEFAULT_INTERVAL + TICK_PAD)
    expect(h.watch.buildScopeMissingCount.value).toBe(1)
    expect(h.watch.buildNoticeFeed.value).toHaveLength(0)

    // 轮 3：仓库已被跳过，快照仍必须保住，依旧零通知
    await advance(DEFAULT_INTERVAL + TICK_PAD)
    expect(h.watch.buildNoticeFeed.value).toHaveLength(0)
    expect(Object.keys(h.watch.buildSnapshot.value['orgA/repo1'] ?? {})).toEqual(['1'])
    expect(h.notify.sendNotification).not.toHaveBeenCalled()
  })

  it('401（unauthorized）不被当成缺权限：不计入 scope，登出交给 cnbFetch', async () => {
    const h = await begin({
      group: 'orgA',
      repos: [repo('orgA/repo1')],
      pendingOf: () => {
        throw { kind: 'unauthorized', status: 401 }
      },
    })

    await advance(FIRST_TICK_DELAY + TICK_PAD)

    expect(h.watch.buildScopeMissingCount.value).toBe(0)
    // 轮询层不做登出（登出是 cnbFetch 的职责，见 useCnbAuth.handleUnauthorized）
    expect(h.auth.logout).not.toHaveBeenCalled()
  })
})

describe('跨仓库：同一 sn 互不串味', () => {
  it('A 仓库的 sn=7 结束、B 仓库的 sn=7 仍在跑 → 只报 A 那条', async () => {
    let aHasPending = true
    const h = await begin({
      group: 'orgA',
      tauri: true,
      repos: [repo('orgA/repoA'), repo('orgA/repoB')],
      pendingOf: (repoPath) => {
        if (repoPath === 'orgA/repoA') {
          return aHasPending ? [pendingLog('7')] : []
        }
        return [pendingLog('7')]
      },
      resolveOf: () => [doneLog('7', 'success')],
    })

    await advance(FIRST_TICK_DELAY + TICK_PAD)
    expect(h.watch.buildNoticeFeed.value).toHaveLength(0)

    aHasPending = false
    await advance(DEFAULT_INTERVAL + TICK_PAD)

    const feed = h.watch.buildNoticeFeed.value
    expect(feed).toHaveLength(1)
    expect(feed[0]?.repoPath).toBe('orgA/repoA')
    // B 仓库的 7 号仍在快照里（没有被 A 的结束"带走"）
    expect(Object.keys(h.watch.buildSnapshot.value['orgA/repoB'] ?? {})).toEqual(['7'])
  })
})

// ---------------------------------------------------------------------------
// e) 定时器不堆叠
// ---------------------------------------------------------------------------
describe('e) 慢请求下的重入保护', () => {
  it('上一轮未跑完时，新排的 tick 直接跳过（请求数不增长）', async () => {
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const h = await begin({
      group: 'orgA',
      repos: [repo('orgA/repo1')],
      pendingOf: () => [],
    })
    h.repo.fetchBuildLogs.mockImplementation(async () => {
      await gate
      return { total: 0, items: [] }
    })

    await advance(FIRST_TICK_DELAY + TICK_PAD)
    expect(countCalls(h, 'pending')).toBe(1)

    // 期间用户改间隔 → restartWatcher 重新排 tick；多个 tick 到期都应被重入保护挡掉
    h.watch.buildNotifyIntervalSec.value = 30
    await nextTick()
    await advance(FIRST_TICK_DELAY + TICK_PAD)
    await advance(5 * DEFAULT_INTERVAL)
    expect(countCalls(h, 'pending')).toBe(1)

    // 放行后 finally 把 tickRunning 复位，轮询链继续（下一轮按 30s 间隔排）
    release!()
    await advance(DEFAULT_INTERVAL + TICK_PAD)
    expect(countCalls(h, 'pending')).toBeGreaterThan(1)
    h.watch.buildNotifyIntervalSec.value = 60
  })

  it('单轮内出现异常（sn 回查抛错）也不会中断后续调度', async () => {
    let round = 0
    const h = await begin({
      group: 'orgA',
      repos: [repo('orgA/repo1')],
      pendingOf: () => {
        round += 1
        // 第一轮基线有 pending，之后结束；回查永远抛错
        return round <= 1 ? [pendingLog('1')] : []
      },
      resolveOf: () => new Error('boom'),
    })

    await advance(FIRST_TICK_DELAY + TICK_PAD)
    await advance(DEFAULT_INTERVAL + TICK_PAD)
    const afterSecond = countCalls(h, 'pending')
    expect(afterSecond).toBeGreaterThan(1)
    await advance(DEFAULT_INTERVAL + TICK_PAD)

    expect(countCalls(h, 'pending')).toBeGreaterThan(afterSecond)
  })
})

// ---------------------------------------------------------------------------
// 仓库列表失败：不得动快照
// ---------------------------------------------------------------------------
describe('仓库列表拉取失败：本轮跳过，绝不清空快照', () => {
  it('列表接口异常时保留上一轮快照，不产生任何通知', async () => {
    let listOk = true
    const h = await begin({
      group: 'orgA',
      tauri: true,
      repos: [repo('orgA/repo1')],
      pendingOf: () => [pendingLog('1')],
    })
    const baseImpl = h.auth.fetchCnbGroupRepos.getMockImplementation()!
    h.auth.fetchCnbGroupRepos.mockImplementation(async (...args: unknown[]) => {
      if (!listOk) {
        throw new Error('list down')
      }
      return baseImpl(...args)
    })

    await advance(FIRST_TICK_DELAY + TICK_PAD)
    expect(Object.keys(h.watch.buildSnapshot.value)).toEqual(['orgA/repo1'])

    listOk = false
    // 仓库列表缓存 5 分钟：先推进过期时间，再触发一轮
    await advance(5 * 60 * 1000 + DEFAULT_INTERVAL)

    expect(h.watch.buildNoticeFeed.value).toHaveLength(0)
    expect(h.notify.sendNotification).not.toHaveBeenCalled()
    expect(Object.keys(h.watch.buildSnapshot.value)).toEqual(['orgA/repo1'])
  })
})

// ---------------------------------------------------------------------------
// 仓库数 >100 的截断标记（缺陷 #5：恰好 100 个时不得误标"超过 100"）
// ---------------------------------------------------------------------------
describe('关注范围截断：用第 2 页探测确认，不靠"拉满一页"猜', () => {
  /** 造 n 个仓库（路径唯一，updatedAt 各不相同以便排序稳定） */
  function manyRepos(n: number) {
    return Array.from({ length: n }, (_, i) => {
      const path = `orgA/repo${String(i).padStart(3, '0')}`
      return { path, name: `repo${i}`, updatedAt: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z` }
    })
  }

  it('恰好 100 个仓库 → 不标记截断（第 2 页探测为空）', async () => {
    const repos = manyRepos(100)
    const h = await begin({ group: 'orgA', repos: [] })
    // 覆盖 begin 的 mock：page 1 返回 100 条，page 2 返回空（说明没有第 101 个）
    h.auth.fetchCnbGroupRepos.mockImplementation(async (_group: string, page = 1) =>
      page === 1 ? repos : [])

    // 100 个仓库的 tick 需要跑 100 次错峰请求（每 worker 相邻请求 150ms），
    // 单轮远超 TICK_PAD，这里给足假时间预算
    await advance(FIRST_TICK_DELAY + 60_000)

    expect(h.watch.buildWatchTruncated.value).toBe(false)
    // 关注数量 = 实际拿到的 100 个（全部可轮询）
    expect(h.watch.buildWatchRepoCount.value).toBe(100)
  })

  it('超过 100 个仓库（第 2 页有数据）→ 标记截断', async () => {
    const repos = manyRepos(100)
    const h = await begin({ group: 'orgA', repos: [] })
    h.auth.fetchCnbGroupRepos.mockImplementation(async (_group: string, page = 1) =>
      page === 1 ? repos : [{ path: 'orgA/repo999', name: 'repo999', updatedAt: '2025-01-01T00:00:00Z' }])

    await advance(FIRST_TICK_DELAY + 60_000)

    expect(h.watch.buildWatchTruncated.value).toBe(true)
  })

  it('第 2 页探测失败不影响列表加载，且缓存期内不重复探测', async () => {
    // 探测是"锦上添花"的请求：它失败时必须按"未截断"降级，
    // 绝不能让整个仓库列表加载失败（会让本轮直接跳过、等于停摆），
    // 也不能每轮重试（100 仓库的组织每轮多打一次接口没有意义）。
    const repos = manyRepos(100)
    const h = await begin({ group: 'orgA', repos: [] })
    h.auth.fetchCnbGroupRepos.mockImplementation(async (_group: string, page = 1) => {
      if (page === 1) {
        return repos
      }
      throw new Error('probe down')
    })
    const listCalls = (page: number) =>
      h.auth.fetchCnbGroupRepos.mock.calls.filter(call => call[1] === page).length

    await advance(FIRST_TICK_DELAY + 60_000)

    // 列表照常加载成功、降级为"未截断"
    expect(h.watch.buildWatchRepoCount.value).toBe(100)
    expect(h.watch.buildWatchTruncated.value).toBe(false)
    expect(listCalls(2)).toBe(1)

    // 下一轮命中 5 分钟缓存：既不重拉列表也不重复探测
    await advance(DEFAULT_INTERVAL + 60_000)
    expect(listCalls(1)).toBe(1)
    expect(listCalls(2)).toBe(1)
    // 本轮仍在正常轮询（探测失败没有把轮询链打断）
    expect(h.watch.buildWatchRepoCount.value).toBe(100)
  })
})

// ---------------------------------------------------------------------------
// e) 风控 403：无法归因的 403 绝不能永久跳过仓库
//
// 背景（P2 缺陷修复）：CNB 网关对突发请求有风控，会直接返回 403（本项目
// 正是因为 rustls 指纹被风控才自建了 Rust native-tls 通道）。若把"任何 403"
// 都当成"缺 repo-cnb-history:r"，一次风控抖动就会让该仓库整个会话被永久
// 跳过且无恢复途径。因此只有 errmsg 能解析出具体 scope 的 403 才跳过。
// ---------------------------------------------------------------------------
describe('e) 风控 403：不永久跳过，按普通失败重试', () => {
  /** 风控 403：kind=forbidden 但解析不出 missingScope（与真缺权限的关键差别） */
  function windControl403() {
    return { kind: 'forbidden', status: 403 }
  }

  it('403 但解析不出 scope → 不进 scopeMissing，下一轮仍请求该仓库，且不误报已结束', async () => {
    let mode: 'ok' | 'blocked' = 'ok'
    const h = await begin({
      group: 'orgA',
      tauri: true,
      repos: [repo('orgA/repo1')],
      pendingOf: () => {
        if (mode === 'blocked') {
          throw windControl403()
        }
        return [pendingLog('1')]
      },
    })

    // 轮 1：正常建立基线
    await advance(FIRST_TICK_DELAY + TICK_PAD)
    expect(Object.keys(h.watch.buildSnapshot.value['orgA/repo1'] ?? {})).toEqual(['1'])
    const afterBaseline = countCalls(h, 'pending')

    // 轮 2：风控 403 —— 不跳过、不误报
    mode = 'blocked'
    await advance(DEFAULT_INTERVAL + TICK_PAD)
    expect(h.watch.buildScopeMissingCount.value).toBe(0)
    expect(h.watch.buildNoticeFeed.value).toHaveLength(0)
    expect(Object.keys(h.watch.buildSnapshot.value['orgA/repo1'] ?? {})).toEqual(['1'])

    // 轮 3：仍然会请求该仓库（关键断言：没有被永久静音）
    await advance(DEFAULT_INTERVAL + TICK_PAD)
    expect(countCalls(h, 'pending')).toBeGreaterThan(afterBaseline + 1)
    expect(h.watch.buildScopeMissingCount.value).toBe(0)
    expect(h.watch.buildNoticeFeed.value).toHaveLength(0)
    expect(h.notify.sendNotification).not.toHaveBeenCalled()
  })

  it('风控 403 连续 3 轮 → 触发退避（下一轮间隔翻倍到 120s，不做永久跳过）', async () => {
    const h = await begin({
      group: 'orgA',
      repos: [repo('orgA/repo1')],
      pendingOf: () => {
        throw windControl403()
      },
    })

    // 轮 1 / 2 / 3：每轮都失败（failedRounds 累加到 3）
    await advance(FIRST_TICK_DELAY + TICK_PAD)
    await advance(DEFAULT_INTERVAL + TICK_PAD)
    await advance(DEFAULT_INTERVAL + TICK_PAD)
    const afterThreeRounds = countCalls(h, 'pending')
    expect(afterThreeRounds).toBe(3)
    // 风控不是缺权限：绝不计入 scopeMissing
    expect(h.watch.buildScopeMissingCount.value).toBe(0)

    // 退避生效：再等一个基础间隔（60s）不应触发新一轮
    await advance(DEFAULT_INTERVAL)
    expect(countCalls(h, 'pending')).toBe(afterThreeRounds)

    // 再等到翻倍后的 120s 才触发
    await advance(DEFAULT_INTERVAL)
    expect(countCalls(h, 'pending')).toBeGreaterThan(afterThreeRounds)
  })

  it('sn 回查遇风控 403（无 scope）→ 不永久跳过该仓库，后续轮次仍请求', async () => {
    // 守护第二处 catch（resolveFinishedStatuses:813）：若这里被改回"任何 403 都跳过"，
    // 一次回查时的风控抖动就会把整仓静音，而下面这条用例会立刻失败。
    let phase: 'baseline' | 'resolve-blocked' | 'normal' = 'baseline'
    const h = await begin({
      group: 'orgA',
      tauri: true,
      repos: [repo('orgA/repo1')],
      pendingOf: () => (phase === 'baseline' ? [pendingLog('1')] : []),
      resolveOf: () => {
        if (phase === 'resolve-blocked') {
          throw windControl403()
        }
        return [doneLog('1', 'success')]
      },
    })

    // 轮 1：基线（sn=1 pending）
    await advance(FIRST_TICK_DELAY + TICK_PAD)
    expect(countCalls(h, 'pending')).toBe(1)

    // 轮 2：pending 消失 → 回查时被风控 403 → 该条按状态未知进面板，但仓库不跳过
    phase = 'resolve-blocked'
    await advance(DEFAULT_INTERVAL + TICK_PAD)
    expect(h.watch.buildScopeMissingCount.value).toBe(0)
    expect(h.watch.buildNoticeFeed.value).toHaveLength(1)
    expect(h.watch.buildNoticeFeed.value[0]?.status).toBe('')
    expect(h.notify.sendNotification).not.toHaveBeenCalled()

    // 轮 3：仍会请求该仓库（未被永久静音）—— 这是本用例的核心断言
    phase = 'normal'
    await advance(DEFAULT_INTERVAL + TICK_PAD)
    expect(countCalls(h, 'pending')).toBe(3)
    expect(h.watch.buildScopeMissingCount.value).toBe(0)
  })
})
