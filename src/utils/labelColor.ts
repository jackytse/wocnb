/**
 * 标签（Issue / PR label）配色工具 —— 纯函数，无 Vue 依赖。
 *
 * # 为什么需要这个文件
 *
 * CNB 返回的 label.color 不是 GitHub 那种饱和色，而是 `#E5F5FF`、`#FCEEE8`
 * 这类**极浅的粉彩色**（饱和度 100%、亮度 95% 左右）。早期实现直接把该色
 * 当作**文字色**、再用 `${color}1a`（10% 透明度）当底色，于是：
 *
 * - 文字色 #E5F5FF 与背景（白底上叠 10% 的同色 ≈ #FBFDFF）几乎无对比度，
 *   标签实际渲染成一块"空白的浅色方块"，文字看不见；
 * - 该色本身接近白色，在浅色主题下连边界都难以分辨。
 *
 * 因此这里改为「**标签色当实心底色，前景色按对比度自动推导**」：
 * - 浅色底（粉彩）→ 同色相压暗后的文字色（保留色相关联，例如浅蓝底配深蓝字）；
 * - 深浅适中的底 → 白字 / 近黑字里挑对比度更高的那个；
 * - 深色底 → 白字。
 *
 * 底色始终是标签色本身（不做透明度混合），因此**明暗主题下表现一致**：
 * 粉彩底在两种主题里都是浅色块，深色字始终可读，无需按主题切换。
 */

/** 颜色计算结果：直接展开到元素的内联样式上 */
export interface LabelChipStyle {
  /** 标签色（#rrggbb，作为不透明底色） */
  backgroundColor: string
  /** 自动推导的可读前景色 */
  color: string
  /** 内描边：粉彩底与白色/深色页面背景的明度差很小，需要一圈细边勾勒轮廓 */
  boxShadow: string
}

/** 无色/非法色时的回落色（与仓库标签列表里的"未配色"灰块保持一致） */
export const LABEL_FALLBACK_COLOR = '#a1a1aa'

/** WCAG 2.1 正文最小对比度（4.5:1）；标签是 12px 小字，必须满足该阈值 */
export const MIN_TEXT_CONTRAST = 4.5

/** RGB 三元组（0~255 整数） */
interface Rgb {
  r: number
  g: number
  b: number
}

/**
 * 把任意常见十六进制写法归一成 `#rrggbb` 小写形式。
 *
 * 兼容：
 * - 带/不带 `#`（`#E5F5FF` / `E5F5FF`）；
 * - 3 位缩写（`#fff` → `#ffffff`）；
 * - 8 位带 alpha（`#E5F5FF80`）—— 标签底色一律按不透明处理，丢弃 alpha；
 * - 4 位缩写（`#fff8`）。
 *
 * 非法输入（`red`、空串、非十六进制字符、位数不对）返回 null，由调用方
 * 回落到中性徽标，绝不把脏值拼进 style（拼进去会导致整条样式失效）。
 */
export function normalizeLabelColor(input?: string | null): string | null {
  if (typeof input !== 'string') {
    return null
  }
  // 统一去掉首尾空白与可选的 '#'，后续只处理十六进制字符
  let hex = input.trim().replace(/^#/, '')
  if (!/^[0-9a-f]+$/i.test(hex)) {
    return null
  }
  // 3/4 位缩写：每个字符重复一次（#abc → aabbcc，alpha 位随后被丢弃）
  if (hex.length === 3 || hex.length === 4) {
    hex = hex
      .slice(0, 3)
      .split('')
      .map(ch => ch + ch)
      .join('')
  }
  else if (hex.length === 8) {
    hex = hex.slice(0, 6)
  }
  else if (hex.length !== 6) {
    // 5 位、7 位这类非法长度：交给调用方走中性回退
    return null
  }
  return `#${hex.toLowerCase()}`
}

/** `#rrggbb` → RGB（调用前须先用 normalizeLabelColor 归一） */
function hexToRgb(hex: string): Rgb {
  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
  }
}

/** RGB → `#rrggbb` */
function rgbToHex({ r, g, b }: Rgb): string {
  const toHex = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

/**
 * sRGB 分量转线性值（WCAG 相对亮度公式的第一步）。
 * 注意这里必须做 gamma 反变换，直接用 0~1 的原始分量算出来的亮度会偏亮，
 * 导致"看起来还行、实际对比度不达标"。
 */
function channelToLinear(value: number): number {
  const c = value / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** 相对亮度（0 = 纯黑，1 = 纯白） */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex)
  return 0.2126 * channelToLinear(r) + 0.7152 * channelToLinear(g) + 0.0722 * channelToLinear(b)
}

/** 两色对比度（1~21），参数顺序无关 */
export function contrastRatio(hexA: string, hexB: string): number {
  const la = relativeLuminance(hexA)
  const lb = relativeLuminance(hexB)
  const lighter = Math.max(la, lb)
  const darker = Math.min(la, lb)
  return (lighter + 0.05) / (darker + 0.05)
}

/** RGB → HSL（h: 0~360，s/l: 0~1），仅用于"同色相压暗" */
function rgbToHsl({ r, g, b }: Rgb): { h: number, s: number, l: number } {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) {
    // 灰阶：色相无意义，饱和度 0
    return { h: 0, s: 0, l }
  }
  const d = max - min
  // 亮度高的一半用 (2 - max - min) 做分母，保证饱和度不溢出
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === rn) {
    h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60
  }
  else if (max === gn) {
    h = ((bn - rn) / d + 2) * 60
  }
  else {
    h = ((rn - gn) / d + 4) * 60
  }
  return { h, s, l }
}

/** HSL → RGB */
function hslToRgb(h: number, s: number, l: number): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const hp = (((h % 360) + 360) % 360) / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  let rgb: [number, number, number]
  if (hp < 1) {
    rgb = [c, x, 0]
  }
  else if (hp < 2) {
    rgb = [x, c, 0]
  }
  else if (hp < 3) {
    rgb = [0, c, x]
  }
  else if (hp < 4) {
    rgb = [0, x, c]
  }
  else if (hp < 5) {
    rgb = [x, 0, c]
  }
  else {
    rgb = [c, 0, x]
  }
  const m = l - c / 2
  return {
    r: Math.round((rgb[0] + m) * 255),
    g: Math.round((rgb[1] + m) * 255),
    b: Math.round((rgb[2] + m) * 255),
  }
}

/** 浅色底的判定阈值：相对亮度高于此值即视为"粉彩/浅色"，走同色相压暗 */
const LIGHT_BACKGROUND_LUMINANCE = 0.5

/**
 * 为给定底色推导可读的文字色。
 *
 * 三种策略：
 * 1. 浅色底（粉彩为主）：保持色相，逐步压低亮度并提高饱和度，取第一个
 *    达到 4.5:1 的候选 —— 例如 #E5F5FF → #007ac2，浅蓝底配深蓝字，
 *    既看得清又能看出"这是蓝色标签"；
 * 2. 非浅色底：在白字与近黑字之间选对比度更高的那个（正红 #ff0000 这类
 *    中间色，白字只有 ~4:1，近黑字 ~5.2:1，会选近黑）；
 * 3. 极端情况（同色相压暗始终不达标）：回落到近黑，保证可读性优先于美观。
 *
 * @param background 已归一的 `#rrggbb` 底色
 * @returns 可读的前景色（`#rrggbb` 或 `#ffffff`）
 */
export function readableTextColor(background: string): string {
  const bgLum = relativeLuminance(background)
  if (bgLum >= LIGHT_BACKGROUND_LUMINANCE) {
    const { h, s } = rgbToHsl(hexToRgb(background))
    // 0.38 起步（深色但不发黑），每次压 4% 亮度，最多走到 0.14
    for (let l = 0.38; l >= 0.14; l -= 0.04) {
      // 粉彩本身饱和度很低（混了大量白），成倍提升后才看得出色相
      const candidate = rgbToHex(hslToRgb(h, Math.min(1, s * 2.2), l))
      if (contrastRatio(candidate, background) >= MIN_TEXT_CONTRAST) {
        return candidate
      }
    }
    return '#111827'
  }
  // 中深色底：白字 → 近黑 → 纯黑，取第一个达标者。
  // 为什么要三级：正红 #ff0000 白字只有 3.96:1、近黑 #111827 是 4.44:1，
  // 都不达 4.5，只有纯黑（5.25:1）能过 —— 可读性优先，不为"柔和"牺牲达标。
  for (const candidate of ['#ffffff', '#111827', '#000000']) {
    if (contrastRatio(candidate, background) >= MIN_TEXT_CONTRAST) {
      return candidate
    }
  }
  // 理论上走不到（黑白必有一方 ≥ 4.5），兜底仍给白字
  return '#ffffff'
}

/**
 * 标签 chip 的内联样式。
 *
 * 返回 undefined 表示"该标签没有可用颜色"（`color` 缺失或不是合法十六进制），
 * 调用方应回落到 Nuxt UI 的中性徽标样式（`variant="subtle"` 的默认底色），
 * 而不是强行填入一个假色。
 *
 * @param color CNB 返回的 label.color（`#E5F5FF` 这类浅色）
 */
export function labelChipStyle(color?: string | null): LabelChipStyle | undefined {
  const normalized = normalizeLabelColor(color)
  if (!normalized) {
    return undefined
  }
  return {
    backgroundColor: normalized,
    color: readableTextColor(normalized),
    // 内描边而非 border：border 会改变盒子尺寸导致同行徽标高度不一致
    boxShadow: 'inset 0 0 0 1px rgba(0, 0, 0, 0.08)',
  }
}
