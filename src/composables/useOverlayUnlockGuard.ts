/**
 * 遮罩层全局副作用「自愈守卫」。
 *
 * ## 背景（为什么需要这个文件）
 *
 * 本项目所有弹层（全局搜索 ⌘K、通知抽屉、合并 PR 弹窗、Issue 关闭确认…）
 * 都建立在 Nuxt UI v4 → reka-ui 的 DismissableLayer / Dialog 之上。它们打开时
 * 会往**全局**写三类副作用（本机 reka-ui 2.11.0 实测写入栈）：
 *
 * 1. `document.body.style.pointerEvents = 'none'`
 *    —— `DismissableLayer` 与 `useBodyScrollLock` 各持一个 owner 引用计数；
 * 2. `document.body.style.overflow = 'hidden'`（+ paddingRight / marginRight /
 *    `--scrollbar-width`）—— `useBodyScrollLock`；
 * 3. `#app` 上打 `aria-hidden` / `data-aria-hidden`（aria-hidden 包的 hideOthers，
 *    遍历整棵 DOM 给「非当前弹层」的兄弟节点打标记）。
 *
 * 这三件事**只在组件卸载（或 present 变 false）的清理回调里还原**。只要这条
 * 卸载/清理链路被打断一次，副作用就会永久残留，而界面上看不出任何异常：
 * - `pointer-events: none` 会沿继承链传给 body 的所有后代 —— 整个应用「还在，
 *   但鼠标点什么都没反应」，这正是用户反馈的「UI 卡死」；
 * - `overflow: hidden` 残留 —— 页面再也滚不动；
 * - `aria-hidden` 残留 —— 读屏器认为整页不可见。
 *
 * 已知会打断链路的场景（上游 reka-ui 自己也在修，参见其 2.11 之后分支上
 * “restore body pointer-events when toggled off while mounted … leaving the page
 * frozen” 的提交）：
 * - 关闭动画进行中再次打开/关闭（Presence 的 present 与物理挂载错位）；
 * - 同时存在多个弹层（模态 + 抽屉 + 页面内 Modal），层栈顺序错乱时
 *   最高层判定失效，锁无人释放；
 * - 指针事件在 WebView（WKWebView）里被系统吞掉，dismiss 分支不执行；
 * - 关闭瞬间路由切换，触发卸载的那次 flush 被后续更新打断。
 *
 * ## 这个守卫做什么
 *
 * 不试图去改库的行为（改不动），而是**在应用侧兜底**：
 * 每次「弹层关闭」之后、以及低频轮询时，检查「body 锁还在，但已经完全没有任何
 * 遮罩层/对话框」，就地把残留的全局样式与 aria 标记清掉，并打一条 warn 便于
 * 排查真正的触发链路。用户侧的效果是：即使上游偶发漏解锁，也只会丢一帧交互，
 * 不会整窗卡死。
 *
 * 之所以必须「主动检查」而不是「用户点一下再检查」：`pointer-events: none`
 * 生效时页面收不到任何 pointer 事件，被动兜底根本等不到触发机会。
 */
import { nextTick, onScopeDispose, watch, type Ref } from 'vue'

/** 判定「仍有弹层在场」的选择器集合（三者取并集，宁可漏修也不能误修） */
const LAYER_SELECTOR = [
  // reka-ui 所有可关闭层（Dialog / Popover / Dropdown / Select / Tooltip…）的根节点标记
  '[data-dismissable-layer]',
  // 兜底：部分弹层（如 DialogContent）会带 role=dialog
  '[role="dialog"]',
  // 兜底：浮层内容容器
  '[data-reka-popper-content-wrapper]',
].join(',')

/**
 * 判断 body 的 `pointer-events: none` 是否属于「泄漏」。
 *
 * 拆成纯函数是为了能在 node 环境单测（本项目 vitest 不加载 DOM）。
 *
 * @param input.bodyPointerEvents 当前 body 行内 pointer-events 值（空串表示未设置）
 * @param input.hasLayer 页面里是否还有任何可关闭层节点
 * @param input.hasOpenDialog 页面里是否还有标记为 open 的对话框
 * @returns true 表示「锁还在但没人持有」——需要清理
 */
export function isBodyLockLeaked(input: {
  bodyPointerEvents: string
  hasLayer: boolean
  hasOpenDialog: boolean
}): boolean {
  // 只有真的被锁成 none 才需要考虑；其余情况（auto / 空）本来就是健康状态
  if (input.bodyPointerEvents !== 'none') {
    return false
  }
  // 还有层在场说明锁是被正常持有的（弹层可能正在关闭动画里），不能动
  return !input.hasLayer && !input.hasOpenDialog
}

/**
 * 判断 body 的 `overflow: hidden` 是否属于「泄漏」。
 *
 * 与 pointer-events 同理：弹层的滚动锁属于「有层才有锁」，
 * 没有层还锁着就是残留（表现为整页滚不动）。
 */
export function isScrollLockLeaked(input: {
  bodyOverflow: string
  hasLayer: boolean
  hasOpenDialog: boolean
}): boolean {
  if (input.bodyOverflow !== 'hidden') {
    return false
  }
  return !input.hasLayer && !input.hasOpenDialog
}

/** 读取当前页面的弹层在场情况（集中一处，便于单测与排查时复用） */
function readLayerState(): { hasLayer: boolean; hasOpenDialog: boolean; bodyPointerEvents: string; bodyOverflow: string } {
  return {
    hasLayer: !!document.querySelector(LAYER_SELECTOR),
    hasOpenDialog: !!document.querySelector('[role="dialog"][data-state="open"]'),
    bodyPointerEvents: document.body.style.pointerEvents,
    bodyOverflow: document.body.style.overflow,
  }
}

/** 记录已经 warn 过的原因，避免轮询时刷屏 */
const warned = new Set<string>()

/**
 * 就地清理残留的全局副作用。
 *
 * @param reason 触发来源（写进日志，方便反查是哪条链路漏了解锁）
 * @returns 是否发生了修复（便于调用方/测试断言）
 */
export function repairOverlayLocks(reason: string): boolean {
  // 非浏览器环境（SSR / 单测）直接跳过
  if (typeof document === 'undefined' || !document.body) {
    return false
  }

  const state = readLayerState()
  const pointerLeaked = isBodyLockLeaked(state)
  const scrollLeaked = isScrollLockLeaked(state)
  // aria 标记只在「没有层」时才可能是残留；有层时它正是弹层的正常工作状态
  const ariaLeaked = !state.hasLayer && !state.hasOpenDialog

  if (!pointerLeaked && !scrollLeaked && !ariaLeaked) {
    return false
  }

  if (pointerLeaked) {
    document.body.style.pointerEvents = ''
  }
  if (scrollLeaked) {
    // 与 reka-ui 的 resetBodyStyle 保持同样的还原范围，避免留下滚动条错位
    document.body.style.overflow = ''
    document.body.style.paddingRight = ''
    document.body.style.marginRight = ''
    document.documentElement.style.removeProperty('--scrollbar-width')
  }
  if (ariaLeaked) {
    // aria-hidden 包会给被隐藏的节点同时打 aria-hidden 与 data-aria-hidden
    document.querySelectorAll('[data-aria-hidden="true"]').forEach((el) => {
      el.removeAttribute('data-aria-hidden')
      el.removeAttribute('aria-hidden')
      el.removeAttribute('inert')
    })
  }

  // 同一原因只告警一次：这条 warn 是排查上游触发链路的唯一线索
  if (import.meta.env.DEV && !warned.has(reason)) {
    warned.add(reason)
    console.warn('[wocnb] 检测到遮罩层全局状态残留，已自动修复：', reason, state)
  }
  return true
}

/** 每轮兜底检查的间隔（毫秒）；桌面端常驻应用，5s 一次的开销可以忽略 */
const GUARD_INTERVAL_MS = 5000

/**
 * 给某个弹层的 open 状态挂上自愈守卫。
 *
 * 触发时机：
 * 1. `open` 由 true 变 false —— 正常关闭路径，nextTick + 宏任务之后检查
 *    （此时组件卸载与清理回调都已执行完，剩下的就是真残留）；
 * 2. 低频轮询 —— 覆盖「关闭瞬间路由切换 / 组件树被整体重建」等漏掉 watch 的情况。
 *
 * @param isOpen 弹层的 open 状态（如 v-model:open 绑定的 ref）
 */
export function useOverlayUnlockGuard(isOpen: Ref<boolean>): void {
  watch(isOpen, async (open) => {
    if (open) {
      return
    }
    // nextTick 等 DOM 更新（卸载）完成；setTimeout 再等一个宏任务，
    // 因为 reka 的清理回调里有 await nextTick 的异步分支（DismissableLayer 的 dismiss）
    await nextTick()
    setTimeout(() => repairOverlayLocks('弹层关闭后'), 0)
  })

  // 兜底轮询：用户即使一次都没再触发关闭回调，也能在 5s 内恢复可交互
  const timer = setInterval(() => repairOverlayLocks('定时巡检'), GUARD_INTERVAL_MS)
  // 调用方（布局）卸载时清掉定时器，避免热更新/退出后残留的定时器继续跑
  onScopeDispose(() => clearInterval(timer))
}
