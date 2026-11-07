/**
 * 遮罩层副作用自愈守卫的纯函数单测。
 *
 * 只覆盖判定逻辑（node 环境无 DOM）：真正的 DOM 修复走人工 + 端到端验证，
 * 因为这里不引入 jsdom（见 vitest.config.ts 的说明）。
 */
import { describe, expect, it } from 'vitest'
import { isBodyLockLeaked, isScrollLockLeaked } from '../useOverlayUnlockGuard'

describe('isBodyLockLeaked', () => {
  it('body 未被锁时永远不算泄漏', () => {
    expect(isBodyLockLeaked({ bodyPointerEvents: '', hasLayer: false, hasOpenDialog: false })).toBe(false)
    expect(isBodyLockLeaked({ bodyPointerEvents: 'auto', hasLayer: false, hasOpenDialog: false })).toBe(false)
  })

  it('锁还在但页面已无任何弹层 -> 判定为泄漏（用户侧表现为整窗点不动）', () => {
    expect(isBodyLockLeaked({ bodyPointerEvents: 'none', hasLayer: false, hasOpenDialog: false })).toBe(true)
  })

  it('仍有可关闭层时不能清理（弹层可能正在播放关闭动画）', () => {
    expect(isBodyLockLeaked({ bodyPointerEvents: 'none', hasLayer: true, hasOpenDialog: false })).toBe(false)
  })

  it('仍有 open 的对话框时不能清理', () => {
    expect(isBodyLockLeaked({ bodyPointerEvents: 'none', hasLayer: false, hasOpenDialog: true })).toBe(false)
  })
})

describe('isScrollLockLeaked', () => {
  it('body 未锁滚动时不算泄漏', () => {
    expect(isScrollLockLeaked({ bodyOverflow: '', hasLayer: false, hasOpenDialog: false })).toBe(false)
    expect(isScrollLockLeaked({ bodyOverflow: 'auto', hasLayer: false, hasOpenDialog: false })).toBe(false)
  })

  it('滚动锁残留（页面再也滚不动）应被识别', () => {
    expect(isScrollLockLeaked({ bodyOverflow: 'hidden', hasLayer: false, hasOpenDialog: false })).toBe(true)
  })

  it('弹层在场时滚动锁属于正常工作状态', () => {
    expect(isScrollLockLeaked({ bodyOverflow: 'hidden', hasLayer: true, hasOpenDialog: false })).toBe(false)
    expect(isScrollLockLeaked({ bodyOverflow: 'hidden', hasLayer: false, hasOpenDialog: true })).toBe(false)
  })
})
