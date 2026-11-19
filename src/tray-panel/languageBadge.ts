/**
 * 仓库条目的语言徽标元数据（面板左侧彩色方块）。
 *
 * 参考设计里的条目左侧是各语言/工具的彩色 Logo；离线环境拿不到远程
 * 图标集（@iconify-json/logos 未安装、远程 API 在 Tauri 里也不可靠），
 * 因此用「语言主色 + 语言缩写」的方块等效表达：视觉上同样是彩色图标、
 * 一眼可辨技术栈，且完全离线、零额外依赖。
 *
 * 数据优先级（见 resolveRepoBadge）：
 * 1. 仓库详情接口返回的 languageColor（真实主色）；
 * 2. 本表按语言名的兜底色（CNB 未给色值时的常见取值）；
 * 3. 都没有 → 中性底色 + 仓库名首字母。
 */

/** 单个语言的徽标配置：缩写 + 底色 + 可选前景色（亮底需要深字） */
export interface LanguageBadge {
  /** 方块内显示的缩写（1~3 个字符，超出会挤压） */
  label: string
  /** 底色（#RRGGBB） */
  color: string
  /** 前景色，缺省白色；黄色/橙色等亮底用深色保证对比度 */
  fg?: string
}

/**
 * 语言名（小写匹配）→ 徽标配置。
 *
 * 键统一小写，查询前对数据源做 trim + toLowerCase，避免 "TypeScript"
 * 与 "typescript" 两种写法查不到。
 */
const LANGUAGE_BADGES: Record<string, LanguageBadge> = {
  typescript: { label: 'TS', color: '#3178C6' },
  javascript: { label: 'JS', color: '#F7DF1E', fg: '#1f2328' },
  vue: { label: 'VUE', color: '#41B883' },
  rust: { label: 'RS', color: '#CE422B' },
  go: { label: 'GO', color: '#00ADD8' },
  python: { label: 'PY', color: '#3776AB' },
  java: { label: 'JV', color: '#E76F00' },
  kotlin: { label: 'KT', color: '#7F52FF' },
  swift: { label: 'SW', color: '#F05138' },
  dart: { label: 'DART', color: '#0175C2' },
  'c++': { label: 'C++', color: '#00599C' },
  c: { label: 'C', color: '#5C6BC0' },
  'c#': { label: 'C#', color: '#68217A' },
  html: { label: '<>', color: '#E34F26' },
  css: { label: 'CSS', color: '#1572B6' },
  scss: { label: 'SC', color: '#C6538C' },
  shell: { label: 'SH', color: '#4EAA25' },
  ruby: { label: 'RB', color: '#CC342D' },
  php: { label: 'PHP', color: '#777BB4' },
  elixir: { label: 'EX', color: '#6E4A7E' },
  haskell: { label: 'HS', color: '#5D4F85' },
  lua: { label: 'LUA', color: '#2C2D72' },
  zig: { label: 'ZIG', color: '#F7A41D', fg: '#1f2328' },
  markdown: { label: 'MD', color: '#083FA1' },
  'objective-c': { label: 'OC', color: '#438EFF' },
  dockerfile: { label: 'DK', color: '#2496ED' },
  solidity: { label: 'SOL', color: '#363636' },
  scala: { label: 'SCA', color: '#C22D40' },
}

/**
 * 解析一条仓库记录应展示的徽标。
 *
 * @param name          仓库名（无语言信息时取首字母）
 * @param language      仓库主语言（可选，来自最近访问记录）
 * @param languageColor 仓库主语言色（可选，来自最近访问记录）
 */
export function resolveRepoBadge(
  name: string,
  language?: string,
  languageColor?: string,
): LanguageBadge & { fallback: boolean } {
  const key = (language || '').trim().toLowerCase()
  const preset = key ? LANGUAGE_BADGES[key] : undefined

  if (preset) {
    // 以接口返回的真实语言色为准（覆盖表内兜底色），缩写/前景色沿用预设
    return {
      ...preset,
      color: normalizeColor(languageColor) || preset.color,
      fallback: false,
    }
  }

  const solid = normalizeColor(languageColor)
  if (solid) {
    // 有颜色但语言名不在表内（如小众语言）：用仓库名首字母 + 真实主色
    return { label: initialOf(name), color: solid, fg: '#fff', fallback: false }
  }

  // 完全没有语言信息：中性方块（fallback=true 由调用方决定用文本色）
  return { label: initialOf(name), color: '', fallback: true }
}

/** 仓库名首字母（大写）；空名回退 '?'，保证方块不空白 */
function initialOf(name: string): string {
  return (name.trim()[0] || '?').toUpperCase()
}

/**
 * 校验并归一颜色值。
 *
 * 数据来自 localStorage（可能被手改成任意字符串），只有 #RGB / #RRGGBB
 * 形态才接受——否则内联到 style 里可能破坏样式或注入非法值。
 */
function normalizeColor(value?: string): string {
  if (!value) {
    return ''
  }
  const v = value.trim()
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(v) ? v : ''
}
