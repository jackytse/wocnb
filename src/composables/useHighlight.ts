/**
 * 代码语法高亮（shiki 懒加载单例）。
 *
 * 体积策略（设计文档 §1.2 / §8）：
 * - 使用 shiki/core + JavaScript 正则引擎（不拉 oniguruma wasm）；
 * - 主题/语言全部按需动态 import()，Vite 自动按语言分包，首屏零开销；
 * - 仅注册 PRD 指定的常用语言（SHIKI_LANGS），未知语言降级为转义纯文本；
 * - 双主题（github-light / github-dark），defaultColor=false 输出 CSS 变量，
 *   明暗主题切换由全局 CSS（.dark 前缀）接管，与 Nuxt UI 深色模式一致。
 */
import type { HighlighterCore } from 'shiki/core'

/** 注册的语言清单（未知扩展名一律降级纯文本，不做猜测） */
export const SHIKI_LANGS = [
  'typescript',
  'javascript',
  'vue',
  'json',
  'css',
  'html',
  'markdown',
  'python',
  'go',
  'rust',
  'java',
  'sql',
  'yaml',
  'shell',
  'dockerfile',
] as const

export type ShikiLang = typeof SHIKI_LANGS[number]

/** 语言子路径显式 import 映射（静态可分析的动态 import，保证 Vite 正确分包） */
const langLoaders: Record<ShikiLang, () => Promise<{ default: unknown }>> = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  vue: () => import('shiki/langs/vue.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  shell: () => import('shiki/langs/shell.mjs'),
  dockerfile: () => import('shiki/langs/dockerfile.mjs'),
}

/** 高亮器单例（首次调用才创建；并发调用共享同一个 Promise 防重复初始化） */
let highlighterPromise: Promise<HighlighterCore> | null = null

/** 已加载的语言集合（避免重复 loadLanguage） */
const loadedLangs = new Set<string>()

/** 创建高亮器：core + JS 引擎 + 双主题，语言延迟按需加载 */
async function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, light, dark]
        = await Promise.all([
          import('shiki/core'),
          import('shiki/engine/javascript'),
          import('shiki/themes/github-light.mjs'),
          import('shiki/themes/github-dark.mjs'),
        ])
      return createHighlighterCore({
        themes: [light.default, dark.default],
        langs: [],
        engine: createJavaScriptRegexEngine(),
      })
    })()
  }
  return highlighterPromise
}

/** HTML 转义（未注册语言的降级渲染，防 XSS —— 文件内容是不可信输入） */
export function escapeHtml(text: string): string {
  // 注：不用 replaceAll（tsconfig lib 目标较旧），统一用正则全局替换
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * 按文件名推断 shiki 语言（resolveLang）。
 * 命中 SHIKI_LANGS 返回语言标识，否则返回 null（调用方降级纯文本）。
 */
export function resolveLang(filename: string): ShikiLang | null {
  const name = filename.toLowerCase()
  // 特例：Dockerfile 无扩展名（含变体如 Dockerfile.dev）
  if (/(^|\/)dockerfile(\..*)?$/.test(name)) {
    return 'dockerfile'
  }
  if (/(^|\/)makefile$/.test(name)) {
    return null
  }
  const ext = name.includes('.') ? name.split('.').pop()! : ''
  const map: Record<string, ShikiLang> = {
    ts: 'typescript',
    mts: 'typescript',
    cts: 'typescript',
    js: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    jsx: 'javascript',
    vue: 'vue',
    json: 'json',
    jsonc: 'json',
    css: 'css',
    scss: 'css',
    less: 'css',
    html: 'html',
    htm: 'html',
    md: 'markdown',
    markdown: 'markdown',
    py: 'python',
    go: 'go',
    rs: 'rust',
    java: 'java',
    sql: 'sql',
    yml: 'yaml',
    yaml: 'yaml',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
  }
  return map[ext] ?? null
}

/**
 * 高亮代码为 HTML（shiki 单例懒加载；未注册语言返回转义纯文本）。
 *
 * @param code 源码文本（不可信输入，未命中语言时必须经 escapeHtml）
 * @param lang 语言标识（resolveLang 的返回值或调用方显式指定）
 * @returns 带 shiki 双主题 CSS 变量的 <pre class="shiki"> HTML
 */
export async function highlightCode(code: string, lang: string): Promise<string> {
  // 未注册语言：降级转义纯文本（包一层同样式容器，行高与正常渲染一致）
  if (!(SHIKI_LANGS as readonly string[]).includes(lang)) {
    return `<pre class="shiki shiki-plain"><code>${escapeHtml(code)}</code></pre>`
  }
  try {
    const highlighter = await getHighlighter()
    if (!loadedLangs.has(lang)) {
      const loader = langLoaders[lang as ShikiLang]
      await highlighter.loadLanguage(await loader() as never)
      loadedLangs.add(lang)
    }
    // defaultColor=false：颜色输出为 --shiki-light/--shiki-dark CSS 变量，
    // 明暗切换由全局 CSS 完成（见 assets/css/main.css 的 .shiki 规则）
    return highlighter.codeToHtml(code, {
      lang,
      themes: { light: 'github-light', dark: 'github-dark' },
      defaultColor: false,
    })
  }
  catch (err) {
    // 高亮失败（如语法规则异常）：降级纯文本，不影响内容可读性
    console.error(`[shiki] highlight failed for lang=${lang}:`, err)
    return `<pre class="shiki shiki-plain"><code>${escapeHtml(code)}</code></pre>`
  }
}
