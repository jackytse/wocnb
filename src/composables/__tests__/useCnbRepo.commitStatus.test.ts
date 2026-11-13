/**
 * commitStatusMeta 映射单测（T10 验收 4）。
 *
 * 重点锁定：
 * - 六态独立映射（success/failed/running/pending/canceled/skipped）；
 * - **未知值一律中性色**（服务端新增枚举时前端不误报错误色）；
 * - 与流水线构建状态映射（buildStatusBadge）隔离 —— 本文件不 import
 *   构建状态函数，映射语义由各自测试独立锁定。
 */
import { describe, expect, it } from 'vitest'
import { commitStatusMeta } from '../useCnbRepo'

describe('commitStatusMeta', () => {
  it('六态映射：success 绿 / failed 红 / running 蓝 / pending·canceled·skipped 中性', () => {
    expect(commitStatusMeta('success').color).toBe('success')
    expect(commitStatusMeta('failed').color).toBe('error')
    expect(commitStatusMeta('running').color).toBe('info')
    expect(commitStatusMeta('pending').color).toBe('neutral')
    expect(commitStatusMeta('canceled').color).toBe('neutral')
    expect(commitStatusMeta('skipped').color).toBe('neutral')
  })

  it('未知值与空串一律中性色（绝不显示错误色）', () => {
    expect(commitStatusMeta('future-state').color).toBe('neutral')
    expect(commitStatusMeta('').color).toBe('neutral')
    expect(commitStatusMeta('SUCCESS!').color).toBe('neutral')
  })

  it('大小写不敏感（服务端枚举漂移防御）', () => {
    expect(commitStatusMeta('Success').color).toBe('success')
    expect(commitStatusMeta('FAILED').color).toBe('error')
  })

  it('i18nKey 与图标齐备且不重复', () => {
    const keys = ['success', 'failed', 'running', 'pending', 'canceled', 'skipped']
      .map(state => commitStatusMeta(state).i18nKey)
    expect(new Set(keys).size).toBe(keys.length)
    keys.forEach((key) => {
      expect(key).toMatch(/^repo\.commitStatus\./)
    })
  })

  it('未知值有专属 i18nKey（unknown）', () => {
    expect(commitStatusMeta('future-state').i18nKey).toBe('repo.commitStatus.unknown')
  })
})
