/**
 * 系统通知点击事件处理（通知点击直达构建详情 / 兜底打开通知面板）。
 *
 * # 为什么需要这个模块
 *
 * 构建结果系统通知由 useCnbBuildWatch 发送（extra 里带 repoPath/sn/kind）。
 * 点击通知的"上报"只能在 Rust 侧注册（tauri-plugin-notification 2.7.0 的
 * JS API 没有导出 onAction / registerActionTypes），Rust handler 把点击
 * 以事件 `cnb://build-notification-action` emit 给前端，本模块负责：
 * 1. 监听该事件；
 * 2. 把窗口前置（用户很可能在托盘/后台状态点击通知）；
 * 3. 按 payload 决定路由意图：有 repoPath+sn → 构建详情；否则 → 应用内
 *    通知面板（digest/leftover/解析失败都走兜底，面板里有全部条目）。
 *
 * # 为什么独立成模块而不是塞进 useCnbBuildWatch
 *
 * 点击处理需要打开通知面板（useDashboard 的开关 ref）——若塞进
 * useCnbBuildWatch，会让"发通知"的模块背上"面板开关"的依赖，且该模块
 * 已有大量轮询私有状态，混入点击处理会让单测更难隔离。独立模块 +
 * 依赖注入让两件事各归各位：本模块不读写任何轮询状态。
 *
 * # 为什么路由用注入而不是直接 useRouter / import router
 *
 * 1. main.ts 里的 router 是局部常量、未导出（本项目不让模块互相抓
 *    router 实例）；composable 里也不能调用 useRouter()（无组件上下文）。
 * 2. 单测不 import 任何 vue-router：注入假 navigate 即可断言"路由意图"，
 *    不测 IPC、不测真实跳转。
 */
import { encodeRepoPathForRoute } from '../utils'

/** Rust 侧 emit 的 payload 结构（字段与 src-tauri/src/lib.rs 的
 * BuildNotificationActionPayload 一一对应，两端改动必须同步）。 */
export interface BuildNotificationActionPayload {
  /**
   * 点击动作 id：点通知本体为 'tap'，点 action 按钮（Rust 侧注册的
   * "打开"按钮）为 'open'。两者产生的路由意图相同（意图只看 repoPath/sn，
   * 不看 actionId），因此这里不做分支处理。
   */
  actionId: string
  /** 系统通知的数字 id（sendNotification 传入的 id），读不到时为 null */
  notificationId: number | null
  /** 通知 extra 里带的仓库完整路径（未编码），无则 null */
  repoPath: string | null
  /** 构建序号，无则 null */
  sn: string | null
  /** 通知类型：single / digest / leftover / test，无则 null */
  kind: string | null
}

/**
 * 点击后的路由意图（纯数据，不执行跳转）。
 *
 * 把"决定去哪"与"执行跳转"拆开：意图由纯函数 resolveBuildNotificationIntent
 * 产出（可单测），执行由注入的 navigate/openPanel 完成（main.ts 接线）。
 */
export type BuildNotificationIntent =
  | {
      /** 跳到仓库构建页签并展开对应构建 */
      type: 'build-detail'
      path: string
      query: { tab: 'builds', sn: string }
    }
  | {
      /** 兜底：打开应用内通知面板（面板里有全部构建通知条目） */
      type: 'open-panel'
    }

/**
 * payload -> 路由意图（**纯函数**，不碰任何副作用，单测直接驱动）。
 *
 * # 防御性口径（为什么一切输入都不抛异常）
 *
 * payload 来自 Rust → 前端的 IPC 事件，可能出现的畸形情况：
 * - Rust 侧拿不到 notification（ActiveNotification 是 lenient 反序列化，
 *   读不到时为 None）→ 字段全为 null；
 * - extra 字段类型被污染（repoPath 为数字/对象等）；
 * - 事件 payload 本身缺失（event 为 undefined）。
 * 以上任何一种都归一为"打开通知面板"的兜底意图，绝不能让一次点击
 * 把前端打进未捕获异常。
 *
 * # 为什么 repoPath+sn 必须同时存在才直达详情
 *
 * 只有两者齐全才能定位到"某仓库的某次构建"（sn 仅在仓库内唯一）；
 * digest/leftover/测试通知本就不带定位字段，直达无意义，面板兜底反而
 * 让用户能看到全部条目。
 *
 * @param payload 事件载荷（unknown，内部做完整类型校验）
 */
export function resolveBuildNotificationIntent(payload: unknown): BuildNotificationIntent {
  // 逐字段类型收窄：任何非 string / 空串都视为"字段不存在"
  const data = (typeof payload === 'object' && payload !== null ? payload : {}) as Partial<BuildNotificationActionPayload>
  const repoPath = typeof data.repoPath === 'string' ? data.repoPath.trim() : ''
  const sn = typeof data.sn === 'string' ? data.sn.trim() : ''

  // 两者齐全才产出直达详情的意图；repoPath 必须逐段 encodeURIComponent
  // （仓库路径可能含空格/#/中文，'/' 是分隔符保留——与 NotificationsSlideover
  // 同一口径，共享实现在 src/utils 的 encodeRepoPathForRoute）
  if (repoPath && sn) {
    return {
      type: 'build-detail',
      path: `/repos/${encodeRepoPathForRoute(repoPath)}`,
      query: { tab: 'builds', sn },
    }
  }
  return { type: 'open-panel' }
}

/** 依赖注入接口（全部可替换，便于单测与 main.ts 接线） */
export interface BuildNotificationActionDeps {
  /**
   * 路由跳转执行器：main.ts 传 `(target) => router.push(target)`。
   * 意图为 build-detail 时调用；返回值可能是 Promise（await 兼容）。
   * 返回类型用 unknown 以兼容 router.push 的 NavigationFailure | undefined
   * 联合返回（这里只关心"是否抛异常"，失败结果无消费场景）。
   */
  navigate: (target: { path: string, query: Record<string, string> }) => unknown
  /** 打开应用内通知面板：main.ts 传"置位面板开关 ref"的回调 */
  openPanel: () => void
  /**
   * 事件监听器（仅单测注入假实现）；生产走 @tauri-apps/api/event 的 listen。
   * 返回 unlisten 函数（本模块不持有——监听存活到进程结束）。
   */
  listen?: (
    event: string,
    handler: (event: { payload?: unknown }) => void,
  ) => Promise<unknown>
}

/** initBuildNotificationActionHandler 幂等标记（重复调用不重复注册监听） */
let actionHandlerReady = false

/**
 * 供单测重置幂等标记（生产代码不应调用）。
 * 为什么需要：幂等标记是模块私有状态，测试之间需要显式复位才能重复初始化。
 */
export function resetBuildNotificationActionHandlerForTest(): void {
  actionHandlerReady = false
}

/**
 * 初始化系统通知点击处理（main.ts 调用一次）。
 *
 * - 仅 Tauri 环境执行：浏览器 dev（pnpm dev 直开网页）没有运行时，
 *   listen 都不存在，直接 return、不报错——这是"浏览器下功能整体缺席"的
 *   正常降级，不是异常路径。
 * - 幂等：HMR 或未来的重复调用不会注册多个 listener（重复 listener 会让
 *   一次点击触发多次跳转，用户表现为"页面乱跳"）。
 * - 不阻塞启动：返回的 Promise 只等 listen 注册完成（本地 IPC，微秒级）。
 */
export async function initBuildNotificationActionHandler(deps: BuildNotificationActionDeps): Promise<void> {
  if (actionHandlerReady) {
    return
  }
  // 环境判定与 useCnbBuildWatch.isTauriEnv 同口径：__TAURI_INTERNALS__ 仅在
  // Tauri Webview 中由运行时注入；node 单测下 window 不存在，先做存在性防御
  const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  if (!isTauri) {
    return
  }
  actionHandlerReady = true

  // 生产路径：动态 import @tauri-apps/api/event（与其他插件调用一致的按需
  // 加载风格，也避免 node 环境在模块加载期就解析到 Tauri API）
  const listenFn = deps.listen
    ?? (async (event: string, handler: (event: { payload?: unknown }) => void) => {
      const { listen } = await import('@tauri-apps/api/event')
      return listen(event, handler)
    })

  await listenFn('cnb://build-notification-action', async (event) => {
    // payload 可能缺失/畸形：resolveBuildNotificationIntent 对一切输入兜底
    // 且不抛异常，因此解析环节无需再包 try/catch
    const intent = resolveBuildNotificationIntent(event?.payload)

    // —— 第一步：窗口前置 ——
    // 点击系统通知时应用多半处于"窗口隐藏（关窗驻留托盘）"状态；
    // 不前置窗口的话，跳转/面板打开都发生在不可见的 WebView 里，
    // 用户只会觉得"点了没反应"。show 与 setFocus 各自 try/catch：
    // 任何一步失败（如窗口已销毁）都不该挡住后续路由动作。
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      const win = getCurrentWindow()
      try {
        await win.show()
      }
      catch (err) {
        console.warn('[build-notify-action] 窗口 show 失败：', err)
      }
      try {
        await win.setFocus()
      }
      catch (err) {
        console.warn('[build-notify-action] 窗口 setFocus 失败：', err)
      }
    }
    catch (err) {
      console.warn('[build-notify-action] 获取当前窗口失败：', err)
    }

    // —— 第二步：按意图执行 ——
    if (intent.type === 'build-detail') {
      try {
        await deps.navigate({ path: intent.path, query: intent.query })
      }
      catch (err) {
        // 路由跳转失败（如守卫拦截、目标记录不存在）时兜底打开通知面板：
        // 面板里有该条构建通知，用户手动点击也能到同一位置，体验闭环
        console.warn('[build-notify-action] 路由跳转失败，回退打开通知面板：', err)
        deps.openPanel()
      }
    }
    else {
      deps.openPanel()
    }
  })
}
