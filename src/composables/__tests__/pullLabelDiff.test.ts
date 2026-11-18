/**
 * diffLabelSelection（PR 标签差分纯函数）单元测试。
 *
 * 背景：PR 标签保存走 PUT 整体覆盖（本次勾选列表即最终状态），UI 用差分结果
 * 判断"无变化就不发请求"。本用例锁定差分的边界行为：去空串、去重、保序、
 * 双向差分，防止后续把 PUT 改成增量 POST/DELETE 时悄悄破坏这些前提。
 */
import { describe, expect, it } from 'vitest'
import { diffLabelSelection } from '../useCnbPullReviews'

describe('diffLabelSelection：PR 标签差分（PUT 整体覆盖前的变化判定）', () => {
  it('纯新增：selected 独有的名字进入 added，顺序按 selected 首次出现', () => {
    expect(diffLabelSelection(['bug'], ['bug', 'feat', 'docs'])).toEqual({
      added: ['feat', 'docs'],
      removed: [],
    })
  })

  it('纯移除：original 独有的名字进入 removed，顺序按 original 首次出现', () => {
    expect(diffLabelSelection(['bug', 'feat'], ['bug'])).toEqual({
      added: [],
      removed: ['feat'],
    })
  })

  it('同时增删：两个方向互不污染', () => {
    expect(diffLabelSelection(['a', 'b', 'c'], ['b', 'd'])).toEqual({
      added: ['d'],
      removed: ['a', 'c'],
    })
  })

  it('无变化：added/removed 均为空（UI 据此不发 PUT）', () => {
    expect(diffLabelSelection(['x', 'y'], ['y', 'x'])).toEqual({
      added: [],
      removed: [],
    })
  })

  it('入参含空串/纯空白：归一剔除后不参与差分', () => {
    expect(diffLabelSelection(['', '  ', 'bug'], ['bug', ''])).toEqual({
      added: [],
      removed: [],
    })
  })

  it('入参重复名：去重后按首次出现比较（重复不产生伪差分）', () => {
    expect(diffLabelSelection(['a', 'a', 'b'], ['b', 'a', 'a'])).toEqual({
      added: [],
      removed: [],
    })
  })

  it('两侧全空：返回空差分（清空场景 UI 自行处理确认）', () => {
    expect(diffLabelSelection([], [])).toEqual({ added: [], removed: [] })
  })

  it('从有到无：全部进 removed（整体覆盖语义下等价于清空）', () => {
    expect(diffLabelSelection(['a', 'b'], [])).toEqual({
      added: [],
      removed: ['a', 'b'],
    })
  })

  // —— QA 第 2 轮回归补充的边界用例 ——

  it('trim 归一：仅首尾空白差异视为无变化（不发空写请求）', () => {
    expect(diffLabelSelection(['bug '], ['bug'])).toEqual({
      added: [],
      removed: [],
    })
    expect(diffLabelSelection(['  bug'], ['bug  '])).toEqual({
      added: [],
      removed: [],
    })
  })

  it('新增项仅为空白串：剔除后无差分（UI 不应因此发出 PUT）', () => {
    expect(diffLabelSelection(['a'], ['a', '   ', '\t'])).toEqual({
      added: [],
      removed: [],
    })
  })
})
