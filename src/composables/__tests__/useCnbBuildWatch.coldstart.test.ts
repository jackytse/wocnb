/**
 * 构建通知轮询的**冷启动**单测（QA 补充）：离线补推与组织归属。
 *
 * 这些场景依赖「上一会话已落盘的快照 + 快照所属组织」，只能在模块**首次求值**
 * 时才有意义（模块内的 buildSnapshotGroup 一旦被 resetSnapshot 覆盖就再也回不到
 * "来自上一会话"的状态）。因此本文件单独成文件：先在内存版 localStorage 里预置
 * 持久化数据，再 import 被测模块，全程只用一个模块实例，靠组织切换推进场景。
 *
 * 覆盖的设计要点：
 * - 首次启动若快照为空，绝不产生 finished（由 useCnbBuildWatch.adversarial.test.ts
 *   与 useCnbBuildWatch.polling.test.ts 覆盖，本文件覆盖**快照非空**的补推路径）；
 * - 离线补推：未运行期间结束的构建合并成一条摘要，且只做一次；
 * - 快照归属组织：换了组织不得把上一组织的 pending 误判为"已结束"；
 * - 启动早期 selectedGroup 为 null 时不得清空持久化快照（否则补推永久失效）。
 */
import type { Mock } from 'vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

vi.mock('../useCnbAuth', async () => {
  const { ref } = await import('vue')
  return {
    cnbToken: ref(''),
    selectedGroup: ref<{ path: string } | null>(null),
    fetchCnbGroupRepos: vi.fn(async () => []),
    logout: vi.fn(),
    CnbApiError: class extends Error {},
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
// 内存版 localStorage
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
/** 见 useCnbBuildWatch.polling.test.ts 的同名常量：让本轮 tick 内部错峰跑完 */
const TICK_PAD = 5000

/** 上一会话持久化的快照（只含 pending），结构需通过 buildSnapshotSerializer 校验 */
function persistedSnapshotOf(map: Record<string, string[]>): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const [repoPath, sns] of Object.entries(map)) {
    out[repoPath] = {}
    for (const sn of sns) {
      out[repoPath]![sn] = {
        sn,
        status: 'pending',
        commitTitle: `commit-${sn}`,
        sourceRef: 'main',
        nickName: 'tester',
        createTime: '2026-01-01T00:00:00Z',
      }
    }
  }
  return out
}

/** fetchBuildLogs 返回的构建条目 */
function log(sn: string, status: string) {
  return {
    sn,
    status,
    commitTitle: `commit-${sn}`,
    sourceRef: 'main',
    nickName: 'tester',
    createTime: '2026-01-01T00:00:00Z',
    sha: '',
    event: '',
    durationMs: 0,
    buildLogUrl: '',
    eventUrl: '',
    pipelineTotalCount: 0,
    pipelineSuccessCount: 0,
    pipelineFailCount: 0,
  }
}

/** 组织仓库条目 */
function repo(path: string) {
  return { path, name: path.split('/').pop() || path, updatedAt: '2026-01-01T00:00:00Z' }
}

interface Ctx {
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

/**
 * 冷启动夹具：预置持久化数据 → import 一次 → initBuildWatcher。
 * 之后所有场景共用这一个模块实例（见文件头说明）。
 */
let bootPromise: Promise<Ctx> | null = null

async function coldStart(): Promise<Ctx> {
  if (bootPromise) {
    return bootPromise
  }
  const storage = new FakeStorage()
  // 上一会话：在 orgA 关注 orgA/repo1，当时 sn=1、sn=2 都还在跑
  storage.setItem('cnb-build-snapshot', JSON.stringify(persistedSnapshotOf({ 'orgA/repo1': ['1', '2'] })))
  storage.setItem('cnb-build-snapshot-group', 'orgA')

  ;(globalThis as unknown as { Storage: unknown }).Storage = FakeStorage
  ;(globalThis as unknown as { window: unknown }).window = {
    localStorage: storage,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    // 系统通知链路走 Tauri 分支（插件已 mock）
    __TAURI_INTERNALS__: {},
  }
  // @vueuse 的 isClient 判据是 window && document 同时存在，缺 document 会让
  // defaultWindow 为 undefined，useStorage 直接退化成普通 ref（不读持久化数据）
  ;(globalThis as unknown as { document: unknown }).document = {
    visibilityState: 'visible',
    addEventListener() {},
    removeEventListener() {},
  }
  ;(globalThis as unknown as { Event: unknown }).Event ??= class {}
  // useStorage 落盘后会 `new StorageEvent('storage', …)` 广播（node 环境没有该类），
  // 补一个最小实现，避免每次写入都往 stderr 打 ReferenceError
  ;(globalThis as unknown as { StorageEvent: unknown }).StorageEvent ??= class {
    constructor(public type: string, init?: Record<string, unknown>) {
      Object.assign(this, init ?? {})
    }
  }

  const auth = await import('../useCnbAuth')
  const repoModule = await import('../useCnbRepo')
  const notify = await import('@tauri-apps/plugin-notification')
  const watch = await import('../useCnbBuildWatch')

  const ctx: Ctx = {
    auth: auth as unknown as Ctx['auth'],
    repo: repoModule as unknown as Ctx['repo'],
    notify: notify as unknown as Ctx['notify'],
    watch,
  }

  // 登录态先就绪（真实环境里 initBuildWatcher 在 restoreSession 之后调用），
  // 但组织列表尚未拉回 —— 正是"启动早期 selectedGroup 为 null"的现场
  ctx.auth.cnbToken.value = 'test-token'
  ctx.auth.selectedGroup.value = null
  ctx.repo.fetchBuildLogs.mockReset()
  ctx.repo.fetchBuildLogs.mockImplementation(async (_repoPath: string, opts: { sn?: string } = {}) => {
    if (opts.sn) {
      return { total: 1, items: [log(opts.sn, 'success')] }
    }
    return { total: 0, items: [] }
  })
  ctx.notify.sendNotification.mockReset()
  ctx.notify.isPermissionGranted.mockImplementation(async () => true)
  ctx.notify.requestPermission.mockImplementation(async () => 'granted')

  watch.initBuildWatcher()
  bootPromise = Promise.resolve(ctx)
  return ctx
}

/** 设定当前组织的仓库列表与 pending 集合 */
function arrange(ctx: Ctx, repos: ReturnType<typeof repo>[], pending: Record<string, string[]>): void {
  ctx.auth.fetchCnbGroupRepos.mockReset()
  ctx.auth.fetchCnbGroupRepos.mockImplementation(async () => repos)
  ctx.repo.fetchBuildLogs.mockImplementation(async (repoPath: string, opts: { sn?: string } = {}) => {
    if (opts.sn) {
      return { total: 1, items: [log(opts.sn, 'success')] }
    }
    const sns = pending[repoPath] ?? []
    return { total: sns.length, items: sns.map(sn => log(sn, 'pending')) }
  })
}

/** 切换组织（触发 restartWatcher 的组织切换分支） */
async function selectGroup(ctx: Ctx, path: string): Promise<void> {
  ctx.auth.selectedGroup.value = { path }
  await nextTick()
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await nextTick()
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  // 注意：**不要** clearAllTimers，否则会掐断轮询链，后续用例再也等不到 tick
  vi.useRealTimers()
  vi.useFakeTimers()
})

// ---------------------------------------------------------------------------
// 启动早期组织未就绪
// ---------------------------------------------------------------------------
describe('冷启动：组织列表尚未就绪', () => {
  it('selectedGroup 为 null 时不清空持久化快照（否则离线补推永久失效）', async () => {
    const ctx = await coldStart()

    // initBuildWatcher 已经跑过 immediate 的 watcher 回调
    expect(Object.keys(ctx.watch.buildSnapshot.value)).toEqual(['orgA/repo1'])

    // 组织没就绪 → 不 tick、不动快照
    await advance(FIRST_TICK_DELAY + TICK_PAD)
    expect(Object.keys(ctx.watch.buildSnapshot.value)).toEqual(['orgA/repo1'])
    expect(ctx.repo.fetchBuildLogs).not.toHaveBeenCalled()
    expect(ctx.watch.buildNoticeFeed.value).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 归属组织不一致
// ---------------------------------------------------------------------------
describe('冷启动：快照归属组织与当前组织不一致', () => {
  it('启动后落到另一个组织 → 丢弃上一组织的快照，绝不把它的 pending 报成"已结束"', async () => {
    const ctx = await coldStart()
    arrange(ctx, [repo('orgB/repo9')], { 'orgB/repo9': ['9'] })

    await selectGroup(ctx, 'orgB')
    await advance(FIRST_TICK_DELAY + TICK_PAD)

    // 快照属于 orgA，当前是 orgB → 不补推、不误报，直接重建基线
    expect(ctx.watch.buildNoticeFeed.value).toHaveLength(0)
    expect(ctx.notify.sendNotification).not.toHaveBeenCalled()
    expect(Object.keys(ctx.watch.buildSnapshot.value)).toEqual(['orgB/repo9'])
  })
})

// ---------------------------------------------------------------------------
// 离线补推
// ---------------------------------------------------------------------------
describe('离线补推：未运行期间结束的构建', () => {
  it('合并成一条摘要通知 + 逐条进面板，且只补推一次', async () => {
    const ctx = await coldStart()
    ctx.watch.buildNoticeFeed.value = []
    ctx.notify.sendNotification.mockReset()

    arrange(ctx, [repo('orgA/repo1')], {})
    // 切到 orgA：组织变了 → 快照被重置为「空基线」，随后把上一会话的快照放回去，
    // 等价于「冷启动时快照属于 orgA 且当时有 2 条 pending」
    await selectGroup(ctx, 'orgA')
    ctx.watch.buildSnapshot.value = persistedSnapshotOf({ 'orgA/repo1': ['1', '2'] }) as never

    await advance(FIRST_TICK_DELAY + TICK_PAD)

    const feed = ctx.watch.buildNoticeFeed.value
    expect(feed).toHaveLength(2)
    expect(feed.every(item => item.leftover)).toBe(true)
    // 补推不回查终态 → 状态未知，面板按"状态未知"展示
    expect(feed.every(item => item.status === '')).toBe(true)
    expect(ctx.notify.sendNotification).toHaveBeenCalledTimes(1)
    const payload = ctx.notify.sendNotification.mock.calls[0]?.[0] as { title: string }
    expect(payload.title).toContain('not running')

    // 第二轮不得重复补推
    await advance(DEFAULT_INTERVAL + TICK_PAD)
    expect(ctx.watch.buildNoticeFeed.value).toHaveLength(2)
    expect(ctx.notify.sendNotification).toHaveBeenCalledTimes(1)
    // 补推之后快照已换成"当前 pending 为空"
    expect(ctx.watch.buildSnapshot.value['orgA/repo1']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 组织来回切换
// ---------------------------------------------------------------------------
describe('组织 A → B → A 来回切换', () => {
  it('切回原组织只重建基线（不误报），后续真正结束仍会通知（不漏报）', async () => {
    const ctx = await coldStart()
    ctx.watch.buildNoticeFeed.value = []
    ctx.notify.sendNotification.mockReset()

    // 阶段 1：orgA 有 1 条 pending，建立基线
    arrange(ctx, [repo('orgA/repo1')], { 'orgA/repo1': ['77'] })
    await selectGroup(ctx, 'orgA')
    await advance(FIRST_TICK_DELAY + TICK_PAD)
    expect(Object.keys(ctx.watch.buildSnapshot.value['orgA/repo1'] ?? {})).toEqual(['77'])
    expect(ctx.watch.buildNoticeFeed.value).toHaveLength(0)

    // 阶段 2：切到 orgB，B 里也有 pending
    arrange(ctx, [repo('orgB/repo9')], { 'orgB/repo9': ['9'] })
    await selectGroup(ctx, 'orgB')
    await advance(FIRST_TICK_DELAY + TICK_PAD)
    expect(Object.keys(ctx.watch.buildSnapshot.value)).toEqual(['orgB/repo9'])

    // 阶段 3：切回 orgA，77 号仍在 pending → 只能重建基线，不得报"已结束"
    arrange(ctx, [repo('orgA/repo1')], { 'orgA/repo1': ['77'] })
    await selectGroup(ctx, 'orgA')
    await advance(FIRST_TICK_DELAY + TICK_PAD)
    expect(ctx.watch.buildNoticeFeed.value).toHaveLength(0)
    expect(ctx.notify.sendNotification).not.toHaveBeenCalled()
    expect(Object.keys(ctx.watch.buildSnapshot.value['orgA/repo1'] ?? {})).toEqual(['77'])

    // 阶段 4：77 号之后真的结束了 → 必须通知
    arrange(ctx, [repo('orgA/repo1')], {})
    await advance(DEFAULT_INTERVAL + TICK_PAD)

    const feed = ctx.watch.buildNoticeFeed.value
    expect(feed).toHaveLength(1)
    expect(feed[0]?.sn).toBe('77')
    expect(feed[0]?.repoPath).toBe('orgA/repo1')
    expect(feed[0]?.status).toBe('success')
    expect(ctx.notify.sendNotification).toHaveBeenCalledTimes(1)
  })
})
