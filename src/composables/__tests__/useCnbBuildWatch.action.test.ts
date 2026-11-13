/**
 * 系统通知点击直达链路的单测（通知 id 分配 / payload 组装 / 路由意图 /
 * 事件监听幂等）。
 *
 * ## 测试边界（为什么这样切）
 *
 * - **纯函数直测**：nextNotificationId / buildSystemNotificationOptions /
 *   resolveBuildNotificationIntent 都是无副作用纯函数，直接断言输入输出；
 * - **不测 IPC**：真实的事件监听（@tauri-apps/api/event）与窗口前置
 *   （@tauri-apps/api/window）在 node 环境不存在，也不该被测——注入假
 *   listen 后只验证"注册次数"与"handler 收到 payload 后的意图执行"；
 * - **环境模拟**：node 测试环境没有 window，initBuildNotificationActionHandler
 *   需要 vi.stubGlobal 一个带 __TAURI_INTERNALS__ 的 window 才会走到注册
 *   分支（这也顺带验证了"浏览器环境直接跳过"的降级行为）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BUILD_NOTIFY_ACTION_TYPE_ID,
  buildSystemNotificationOptions,
  MAX_NOTIFICATION_ID,
  nextNotificationId,
} from '../useCnbBuildWatch'
import {
  initBuildNotificationActionHandler,
  resolveBuildNotificationIntent,
  resetBuildNotificationActionHandlerForTest,
  type BuildNotificationActionDeps,
} from '../useBuildNotificationAction'

// ---------------------------------------------------------------------------
// 通知 id 分配（32 位安全）
// ---------------------------------------------------------------------------

describe('nextNotificationId（通知 id 分配）', () => {
  it('连续分配：从 1 开始递增且不重复', () => {
    // 模块级计数器的递增语义封装在纯函数里：从"上一次的值"推出"下一次的值"
    let id = 0 // 未分配状态
    const seen = new Set<number>()
    for (let i = 0; i < 100; i++) {
      id = nextNotificationId(id)
      expect(id).toBeGreaterThanOrEqual(1)
      expect(seen.has(id)).toBe(false)
      seen.add(id)
    }
    expect(id).toBe(100)
  })

  it('逼近 2^31 时回绕到 1，不产生 0 / 负数 / 越界值', () => {
    // 上限本身是回绕点：2^31-1 再分配必须回到 1（i32 越界会让插件报错）
    expect(nextNotificationId(MAX_NOTIFICATION_ID)).toBe(1)
    expect(nextNotificationId(MAX_NOTIFICATION_ID - 1)).toBe(MAX_NOTIFICATION_ID)
  })

  it('非法输入（0 / 负数 / 非整数 / NaN）归一到 1，不产生 0 或负数', () => {
    expect(nextNotificationId(0)).toBe(1)
    expect(nextNotificationId(-5)).toBe(1)
    expect(nextNotificationId(1.5)).toBe(1)
    expect(nextNotificationId(Number.NaN)).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// payload 组装（sendNotification 选项）
// ---------------------------------------------------------------------------

describe('buildSystemNotificationOptions（payload 组装）', () => {
  it('single：带 kind + repoPath + sn', () => {
    const options = buildSystemNotificationOptions(7, '构建成功 · repo', 'main · fix bug', {
      kind: 'single',
      repoPath: 'cnb.cool/org/repo',
      sn: '42',
    })
    expect(options.id).toBe(7)
    expect(options.extra).toEqual({ kind: 'single', repoPath: 'cnb.cool/org/repo', sn: '42' })
  })

  it('digest / leftover：只带 kind，不带 repoPath / sn', () => {
    const digest = buildSystemNotificationOptions(1, 't', 'b', { kind: 'digest' })
    expect(digest.extra).toEqual({ kind: 'digest' })
    const leftover = buildSystemNotificationOptions(2, 't', 'b', { kind: 'leftover' })
    expect(leftover.extra).toEqual({ kind: 'leftover' })
  })

  it('test：只带 kind（测试通知点击后打开通知面板，不带定位字段）', () => {
    const test = buildSystemNotificationOptions(3, 't', 'b', { kind: 'test' })
    expect(test.extra).toEqual({ kind: 'test' })
  })

  it('无 payload 时不写 extra（保持旧口径），但仍带 actionTypeId', () => {
    const options = buildSystemNotificationOptions(1, 't', 'b')
    expect(options.extra).toBeUndefined()
    expect(options.actionTypeId).toBe(BUILD_NOTIFY_ACTION_TYPE_ID)
  })

  it('四种 kind 都必须携带 actionTypeId（否则 macOS 点击静默失效）', () => {
    // 机制：无 action 按钮 → mac-notification-sys needs_response()=false →
    // 发送立即返回并清掉 pending map → 之后的点击上报被丢弃
    const kinds = ['single', 'digest', 'leftover', 'test'] as const
    for (const kind of kinds) {
      const options = buildSystemNotificationOptions(1, 't', 'b', { kind })
      expect(options.actionTypeId).toBe(BUILD_NOTIFY_ACTION_TYPE_ID)
    }
  })

  it('actionTypeId 与 Rust 侧常量取值一致（cnbBuildOpen，跨语言契约）', () => {
    // 该字面量必须与 src-tauri/src/lib.rs 的 BUILD_NOTIFY_ACTION_TYPE_ID 相同；
    // Rust 侧无法在前端测试断言，这里锁定字面量防止被"顺手改名"
    expect(BUILD_NOTIFY_ACTION_TYPE_ID).toBe('cnbBuildOpen')
  })

  it('sn / repoPath 非字符串时 String 收敛（number sn 也能进 extra）', () => {
    // 模拟上游映射漏写 String（如服务端返回数字 sn）：extra 里必须是字符串，
    // 否则 JSON 序列化后是 number，Rust extra_str 只认 Value::String → 直达失效
    const options = buildSystemNotificationOptions(1, 't', 'b', {
      kind: 'single',
      repoPath: 'cnb.cool/a/b',
      sn: 20250101 as unknown as string,
    })
    expect(options.extra).toEqual({ kind: 'single', repoPath: 'cnb.cool/a/b', sn: '20250101' })
    expect(typeof options.extra!.sn).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// payload -> 路由意图（纯函数）
// ---------------------------------------------------------------------------

describe('resolveBuildNotificationIntent（路由意图）', () => {
  it('repoPath+sn 齐全 → 构建详情意图，路径逐段编码（空格/中文/#）', () => {
    // 含空格、'#'、中文的路径：'#' 必须被编码（否则被 vue-router 当 hash）、
    // 空格与中文同理；'/' 作为分隔符保留
    const intent = resolveBuildNotificationIntent({
      actionId: 'tap',
      notificationId: 9,
      repoPath: 'cnb.cool/我的 组/工#程 repo',
      sn: '12',
      kind: 'single',
    })
    expect(intent).toEqual({
      type: 'build-detail',
      path: `/repos/cnb.cool/${encodeURIComponent('我的 组')}/${encodeURIComponent('工#程 repo')}`,
      query: { tab: 'builds', sn: '12' },
    })
  })

  it('缺 sn（digest/leftover/test 等摘要类）→ 打开通知面板兜底', () => {
    expect(resolveBuildNotificationIntent({ repoPath: 'cnb.cool/a/b', kind: 'digest' })).toEqual({
      type: 'open-panel',
    })
    expect(resolveBuildNotificationIntent({ kind: 'leftover' })).toEqual({ type: 'open-panel' })
  })

  it('payload 为 null / undefined / 非对象 → 不抛异常，返回面板兜底', () => {
    expect(resolveBuildNotificationIntent(null)).toEqual({ type: 'open-panel' })
    expect(resolveBuildNotificationIntent(undefined)).toEqual({ type: 'open-panel' })
    expect(resolveBuildNotificationIntent('garbage')).toEqual({ type: 'open-panel' })
    expect(resolveBuildNotificationIntent(42)).toEqual({ type: 'open-panel' })
  })

  it('字段类型错误（数字/空串）→ 不抛异常，返回面板兜底', () => {
    expect(resolveBuildNotificationIntent({ repoPath: 123, sn: '1' })).toEqual({ type: 'open-panel' })
    expect(resolveBuildNotificationIntent({ repoPath: '  ', sn: '1' })).toEqual({ type: 'open-panel' })
    expect(resolveBuildNotificationIntent({ repoPath: 'a/b', sn: '' })).toEqual({ type: 'open-panel' })
    // sn 非字符串同样不直达（绝不在意图层隐式转型，避免静默错误定位）
    expect(resolveBuildNotificationIntent({ repoPath: 'a/b', sn: 7 })).toEqual({ type: 'open-panel' })
  })
})

// ---------------------------------------------------------------------------
// 事件监听注册（幂等 / 环境降级 / handler 执行）
// ---------------------------------------------------------------------------

/** 构造注入依赖：假 listen 计数 + navigate/openPanel 记录 */
function makeDeps() {
  const listeners: Array<(event: { payload?: unknown }) => void> = []
  const listen = vi.fn(async (_event: string, handler: (event: { payload?: unknown }) => void) => {
    listeners.push(handler)
    return () => {}
  })
  const navigate = vi.fn()
  const openPanel = vi.fn()
  const deps: BuildNotificationActionDeps = { navigate, openPanel, listen }
  return { deps, listeners, navigate, openPanel, listen }
}

describe('initBuildNotificationActionHandler（事件监听）', () => {
  beforeEach(() => {
    resetBuildNotificationActionHandlerForTest()
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('重复初始化只注册一个 listener（幂等）', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
    const { deps, listen } = makeDeps()
    await initBuildNotificationActionHandler(deps)
    await initBuildNotificationActionHandler(deps)
    await initBuildNotificationActionHandler(deps)
    expect(listen).toHaveBeenCalledTimes(1)
  })

  it('浏览器环境（无 __TAURI_INTERNALS__）直接跳过，不注册也不报错', async () => {
    // 不 stub window（node 环境下 window 为 undefined）→ 走非 Tauri 分支
    const { deps, listen } = makeDeps()
    await expect(initBuildNotificationActionHandler(deps)).resolves.toBeUndefined()
    expect(listen).not.toHaveBeenCalled()
  })

  it('build-detail 意图：先窗口前置，再执行 navigate（携带编码后的 path）', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
    const { deps, listeners, navigate, openPanel } = makeDeps()
    await initBuildNotificationActionHandler(deps)

    // 模拟 Rust emit：payload 带完整定位字段
    await listeners[0]({
      payload: { actionId: 'tap', notificationId: 1, repoPath: 'cnb.cool/a b', sn: '3', kind: 'single' },
    })
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledWith({
      path: `/repos/cnb.cool/${encodeURIComponent('a b')}`,
      query: { tab: 'builds', sn: '3' },
    })
    expect(openPanel).not.toHaveBeenCalled()
  })

  it('open-panel 意图（无定位字段）：打开面板，不调用 navigate', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
    const { deps, listeners, navigate, openPanel } = makeDeps()
    await initBuildNotificationActionHandler(deps)

    // digest 类通知 / 畸形 payload 都走面板兜底
    await listeners[0]({ payload: { kind: 'digest' } })
    await listeners[0]({ payload: null })
    expect(navigate).not.toHaveBeenCalled()
    expect(openPanel).toHaveBeenCalledTimes(2)
  })

  it('navigate 抛异常时兜底打开面板（不向上抛）', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
    const { deps, listeners, navigate, openPanel } = makeDeps()
    navigate.mockRejectedValueOnce(new Error('router blocked'))
    await initBuildNotificationActionHandler(deps)

    await listeners[0]({
      payload: { actionId: 'tap', repoPath: 'cnb.cool/a/b', sn: '1', kind: 'single' },
    })
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(openPanel).toHaveBeenCalledTimes(1)
  })
})
