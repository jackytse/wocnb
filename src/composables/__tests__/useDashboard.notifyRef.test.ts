/**
 * QA 补充测试（QA 工程师 Edward，任务 #2 验证通知点击直达）：
 *
 * 1. useDashboard 面板开关 ref 的「单例」回归锁定：
 *    isNotificationsSlideoverOpen 提升到模块顶层后，必须保证
 *    「组件内 useDashboard() 拿到的 ref」与「main.ts 直接 import 的 ref」
 *    是同一份引用——否则点系统通知置位 main.ts 的 ref，面板毫无反应。
 *    顺带回归锁定 defineShortcuts 与 route watch 未被本次改动破坏。
 *
 * 2. resolveBuildNotificationIntent 的畸形输入补充用例：
 *    工程师测试未覆盖的 {} / sn 数组 / repoPath 对象等污染形态。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, reactive } from 'vue'

// —— vue-router mock：useRoute/useRouter 需要组件实例，测试注入假实现 ——
// 必须是 reactive：useDashboard 里 watch(() => route.fullPath) 依赖响应式触发
const fakeRoute = reactive({ fullPath: '/' })
const fakeRouter = { push: vi.fn() }
vi.mock('vue-router', () => ({
  useRoute: () => fakeRoute,
  useRouter: () => fakeRouter,
}))

// defineShortcuts 是 Nuxt UI 全局自动导入（auto-imports.d.ts），node 测试环境
// 不存在，必须 stub（useDashboard._useDashboard 里直接调用）
vi.stubGlobal('defineShortcuts', vi.fn())

import { isNotificationsSlideoverOpen, useDashboard } from '../useDashboard'
import { resolveBuildNotificationIntent } from '../useBuildNotificationAction'

describe('useDashboard 面板开关 ref 单例（通知点击直达的接线前提）', () => {
  beforeEach(() => {
    isNotificationsSlideoverOpen.value = false
    fakeRoute.fullPath = '/'
    fakeRouter.push.mockClear()
    ;(defineShortcuts as ReturnType<typeof vi.fn>).mockClear()
    vi.stubGlobal('defineShortcuts', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.stubGlobal('defineShortcuts', vi.fn())
  })

  it('组件调用点与模块导出 ref 是同一份引用（两个消费方不产生双份真相）', () => {
    const { isNotificationsSlideoverOpen: fromComposable } = useDashboard()
    // 模拟 main.ts：置位模块顶层 ref
    isNotificationsSlideoverOpen.value = true
    // 组件侧必须立刻看到同一份状态
    expect(fromComposable.value).toBe(true)
    // 严谨断言：连引用都相同（不是值碰巧相等的两个 ref）
    expect(fromComposable).toBe(isNotificationsSlideoverOpen)
  })

  it('defineShortcuts 仍被注册（快捷键 n 切换面板的逻辑未被破坏）', () => {
    useDashboard()
    const shortcuts = defineShortcuts as ReturnType<typeof vi.fn>
    expect(shortcuts).toHaveBeenCalledTimes(1)
    const bindings = shortcuts.mock.calls[0]?.[0] as Record<string, () => void>
    // n 快捷键应切换面板开关
    bindings.n()
    expect(isNotificationsSlideoverOpen.value).toBe(true)
    bindings.n()
    expect(isNotificationsSlideoverOpen.value).toBe(false)
  })

  it('route 变化仍会关闭面板（watch 逻辑未被破坏）', async () => {
    useDashboard()
    isNotificationsSlideoverOpen.value = true
    fakeRoute.fullPath = '/repos/other'
    await nextTick()
    expect(isNotificationsSlideoverOpen.value).toBe(false)
  })
})

describe('resolveBuildNotificationIntent 畸形输入补充（QA 手写用例）', () => {
  it('空对象 / 未知字段 → 面板兜底', () => {
    expect(resolveBuildNotificationIntent({})).toEqual({ type: 'open-panel' })
    expect(resolveBuildNotificationIntent({ foo: 'bar' })).toEqual({ type: 'open-panel' })
  })

  it('sn 为数组 / repoPath 为对象 → 不抛异常，面板兜底', () => {
    expect(resolveBuildNotificationIntent({ repoPath: 'a/b', sn: [1, 2] })).toEqual({
      type: 'open-panel',
    })
    expect(resolveBuildNotificationIntent({ repoPath: { org: 'a' }, sn: '1' })).toEqual({
      type: 'open-panel',
    })
  })

  it('数值 sn 为 0 / repoPath 为数字 0 → 不抛异常，面板兜底', () => {
    expect(resolveBuildNotificationIntent({ repoPath: 0, sn: 0 })).toEqual({ type: 'open-panel' })
  })
})
