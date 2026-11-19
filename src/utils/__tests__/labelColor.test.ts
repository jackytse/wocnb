/**
 * src/utils/labelColor.ts 单测（纯函数，node 环境无 DOM）。
 *
 * 重点防回归的是"看得见"这件事本身：CNB 的标签色是 #E5F5FF 这类浅粉彩，
 * 旧实现把它当文字色 → 近白字压近白底。这里用对比度阈值 4.5:1 把
 * "可读"写死成断言，避免以后有人又改回 `color: label.color`。
 */
import { describe, expect, it } from 'vitest'
import {
  MIN_TEXT_CONTRAST,
  contrastRatio,
  labelChipStyle,
  normalizeLabelColor,
  readableTextColor,
  relativeLuminance,
} from '../labelColor'

// ---------------------------------------------------------------------------
// normalizeLabelColor：脏值归一
// ---------------------------------------------------------------------------
describe('normalizeLabelColor', () => {
  it('6 位十六进制统一成小写并补 #', () => {
    expect(normalizeLabelColor('#E5F5FF')).toBe('#e5f5ff')
    expect(normalizeLabelColor('E5F5FF')).toBe('#e5f5ff')
  })

  it('3 位缩写展开成 6 位', () => {
    expect(normalizeLabelColor('#fff')).toBe('#ffffff')
    expect(normalizeLabelColor('abc')).toBe('#aabbcc')
  })

  it('8 位带 alpha 时丢弃 alpha（标签底色一律不透明）', () => {
    expect(normalizeLabelColor('#E5F5FF80')).toBe('#e5f5ff')
  })

  it('非法输入返回 null（不能把脏值拼进 style）', () => {
    expect(normalizeLabelColor('red')).toBeNull()
    expect(normalizeLabelColor('')).toBeNull()
    expect(normalizeLabelColor(undefined)).toBeNull()
    expect(normalizeLabelColor(null)).toBeNull()
    expect(normalizeLabelColor('#12345')).toBeNull() // 5 位非法
    expect(normalizeLabelColor('#gggggg')).toBeNull() // 非十六进制
  })
})

// ---------------------------------------------------------------------------
// relativeLuminance / contrastRatio：WCAG 基础量
// ---------------------------------------------------------------------------
describe('relativeLuminance / contrastRatio', () => {
  it('纯黑 0、纯白 1', () => {
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5)
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5)
  })

  it('黑白对比度为 21:1，且与参数顺序无关', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1)
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 1)
  })

  it('同色对比度为 1:1', () => {
    expect(contrastRatio('#e5f5ff', '#e5f5ff')).toBeCloseTo(1, 5)
  })
})

// ---------------------------------------------------------------------------
// readableTextColor：真实标签色的可读性
// ---------------------------------------------------------------------------
describe('readableTextColor', () => {
  it('CNB 真实的浅粉彩标签色：推导出的文字色必须达标（回归用例）', () => {
    // 这两组色值来自线上接口 GET /user/issues 的实际返回
    for (const bg of ['#e5f5ff', '#fceee8']) {
      const text = readableTextColor(bg)
      expect(contrastRatio(text, bg)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST)
    }
  })

  it('浅蓝底推导出同色相的深色字（保留"这是蓝色标签"的信息）', () => {
    const text = readableTextColor('#e5f5ff')
    // 深蓝：蓝色分量应明显大于红色分量
    const r = Number.parseInt(text.slice(1, 3), 16)
    const b = Number.parseInt(text.slice(5, 7), 16)
    expect(b).toBeGreaterThan(r)
    expect(text).not.toBe('#111827') // 走的是同色相压暗，而不是黑色兜底
  })

  it('深色底用白字', () => {
    expect(readableTextColor('#111827')).toBe('#ffffff')
    expect(readableTextColor('#0f172a')).toBe('#ffffff')
  })

  it('正红这类中间色在白字与近黑字之间取对比度更高者', () => {
    const text = readableTextColor('#ff0000')
    expect(contrastRatio(text, '#ff0000')).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST)
  })
})

// ---------------------------------------------------------------------------
// labelChipStyle：组件实际消费的样式对象
// ---------------------------------------------------------------------------
describe('labelChipStyle', () => {
  it('有合法颜色时给出底色 + 前景色 + 内描边', () => {
    const style = labelChipStyle('#E5F5FF')
    expect(style).toBeDefined()
    expect(style!.backgroundColor).toBe('#e5f5ff')
    expect(style!.color).toMatch(/^#[0-9a-f]{6}$/)
    expect(contrastRatio(style!.color, style!.backgroundColor)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST)
    // 内描边用于在白色页面上勾勒粉彩底的轮廓
    expect(style!.boxShadow).toContain('inset')
  })

  it('无颜色 / 非法颜色返回 undefined（回落中性徽标）', () => {
    expect(labelChipStyle('')).toBeUndefined()
    expect(labelChipStyle(null)).toBeUndefined()
    expect(labelChipStyle('red')).toBeUndefined()
  })
})
