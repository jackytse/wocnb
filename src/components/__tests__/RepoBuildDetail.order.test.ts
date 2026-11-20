/**
 * RepoBuildDetail 声明顺序回归守卫（2026-11-20）。
 *
 * 背景：自动轮询的 pollTimer / stopAutoPoll 等声明若位于
 * `watch(..., { immediate: true })` 之后，setup 阶段同步执行的
 * watch 回调访问 pollTimer 会触发 TDZ ReferenceError，整个构建
 * 详情组件挂载失败（表现为「流水线流程没有正常显示」）。
 *
 * 该错误是运行时 TDZ，vue-tsc / vitest 既有用例均无法捕获，
 * 项目也无组件挂载测试基建 —— 故用源码顺序断言做轻量守卫：
 * 轮询状态声明必须在 immediate watch 之前。
 *
 * 注意匹配 `{ immediate: true }`（带花括号的实际 watch 选项），
 * 而非裸文本 —— 组件内注释里也提到了该短语，裸匹配会误判。
 */
import { describe, expect, it } from 'vitest'
import source from '../repo/RepoBuildDetail.vue?raw'

describe('RepoBuildDetail 声明顺序（TDZ 回归守卫）', () => {
  it('自动轮询状态声明必须先于 immediate watch', () => {
    // 轮询定时器声明位置
    const timerIdx = source.indexOf('let pollTimer')
    // immediate watch 选项的位置（sn 切换监听，setup 时同步执行回调）
    const watchIdx = source.indexOf('{ immediate: true }')
    expect(timerIdx, 'let pollTimer 必须存在于 RepoBuildDetail.vue').toBeGreaterThan(-1)
    expect(watchIdx, '{ immediate: true } watch 必须存在于 RepoBuildDetail.vue').toBeGreaterThan(-1)
    expect(
      timerIdx < watchIdx,
      'let pollTimer 必须声明在 { immediate: true } watch 之前，'
      + '否则 setup 同步回调访问 pollTimer 触发 TDZ，详情组件挂载失败',
    ).toBe(true)
  })
})
