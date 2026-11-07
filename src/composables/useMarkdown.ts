/**
 * Markdown 渲染管线（marked + DOMPurify + 图片本地化）。
 *
 * 安全红线（PRD 7.2.7 / 设计文档 §9.11）：
 * - README / Issue 正文 / 评论 / PR 描述均为**不可信内容**，一律经本模块
 *   渲染，禁止组件 v-html 直渲染接口原始字段；
 * - marked 解析后必须经 DOMPurify 消毒：去 script/iframe/style、去 on*
 *   事件属性、javascript: 等危险协议链接丢弃；
 * - <a> 强制 rel="noopener"，非 http(s) 协议 href 丢弃；
 * - 外链由 main.ts 全局拦截器转交系统浏览器打开。
 *
 * 图片本地化（PRD 7.2.8）：
 * - Markdown 中的相对路径图片（如 ./docs/img.png）按
 *   https://cnb.cool/{repo}/-/raw/{ref}/{dir}/{img} 拼为绝对地址，
 *   经既有 cnb_fetch_image 通道转 data URL 渲染（Tauri Webview 无法
 *   直接加载 cnb.cool 图片：无 CORS 头 + 网关风控，详见 useCnbImages）；
 * - renderMarkdown 同步返回 HTML（相对路径图片以占位符 + data-cnb-src
 *   属性输出），异步替换由 MarkdownView 的 hydrateMarkdownImages 完成；
 * - 转换失败（非 Tauri 环境/下载失败）时显示灰块占位，绝不弹系统浏览器。
 */
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { cachedImageSrc, ensureCnbImage } from './useCnbImages'

/** 图片相对路径解析基准（仓库 + ref + 当前目录） */
export interface MarkdownContext {
  repoPath: string
  ref: string
  /** 正文所在目录（如 'docs/guide'），相对图片以该目录为基准；缺省为根目录 */
  dir?: string
}

/** 相对路径图片的占位 src（1x1 透明 GIF，防 <img> 破图图标闪烁） */
const IMG_PLACEHOLDER
  = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

/**
 * 将 Markdown 中的相对路径图片 src 解析为 cnb.cool raw 绝对地址。
 * 规则：./x、x 相对当前目录；/x 相对仓库根；../x 逐级回退（简单栈式
 * 解析，不做完整 URL 语义 —— README 场景足够）。
 */
function resolveImageUrl(src: string, ctx: MarkdownContext): string | null {
  if (/^(https?:)?\/\//i.test(src) || src.startsWith('data:')) {
    // 绝对地址/协议相对/data URL：不经本地化管线，原样交给消毒器判断
    return null
  }
  const segments = (ctx.dir || '').split('/').filter(Boolean)
  let rest = src.replace(/^\.?\//, '')
  // 逐段消费 ../
  while (rest.startsWith('../')) {
    rest = rest.slice(3)
    if (segments.length > 0) {
      segments.pop()
    }
  }
  const dirPart = segments.length ? `/${segments.join('/')}` : ''
  return `https://cnb.cool/${ctx.repoPath}/-/raw/${ctx.ref}${dirPart}/${rest}`
}

/**
 * 渲染 Markdown 为安全的 HTML（同步返回）。
 *
 * 流程：marked 解析（GFM 表格/任务列表）→ DOMPurify 消毒（白名单策略 +
 * hook 加固链接/图片）→ 相对路径图片改写为占位符 + data-cnb-src。
 *
 * @param markdown 原始 Markdown 文本
 * @param ctx 图片相对路径解析基准（null 时图片保持原样交由消毒器处理）
 */
export function renderMarkdown(markdown: string, ctx: MarkdownContext | null): string {
  if (!markdown) {
    return ''
  }
  // 1. marked 解析：GFM 开启（表格/删除线/任务列表）；breaks 关闭（与
  //    GitHub 渲染语义一致，单换行不断行）
  const parsed = marked.parse(markdown, { gfm: true, breaks: false, async: false })
  const html = typeof parsed === 'string' ? parsed : ''

  // 2. DOMPurify 消毒：默认策略已去 script/iframe/event handler，
  //    再通过 hook 加固链接协议与图片本地化
  //    （直接使用默认实例；hook 用完即摘，避免污染其他调用方）
  const purifier = DOMPurify
  purifier.addHook('afterSanitizeAttributes', (node) => {
    if (node instanceof Element) {
      // —— <a> 加固：非 http(s) 协议（含 javascript:/vbscript:/相对协议）丢弃 href；
      //    保留站内相对路径（/#/./）与锚点 —— 并强制 rel=noopener
      if (node.tagName === 'A') {
        const href = node.getAttribute('href') || ''
        const safe = /^(https?:\/\/|\/|#|\.\/)/i.test(href)
        if (!safe) {
          node.removeAttribute('href')
        }
        node.setAttribute('rel', 'noopener')
      }
      // —— <img> 本地化：相对路径改写为 cnb raw 绝对地址并输出占位符，
      //    data-cnb-src 保留原始解析结果供异步转 data URL；
      //    消毒默认会移除 data-* 属性，故用 hook 在消毒后重新写入
      if (node.tagName === 'IMG' && ctx) {
        const src = node.getAttribute('src') || ''
        const absolute = resolveImageUrl(src, ctx)
        if (absolute) {
          node.setAttribute('src', IMG_PLACEHOLDER)
          node.setAttribute('data-cnb-src', absolute)
        }
      }
    }
  })
  const clean = purifier.sanitize(html, {
    // 禁用 data-* 白名单外属性放行，data-cnb-src 在 hook 中手动写入
    ADD_ATTR: ['data-cnb-src', 'target'],
    FORBID_TAGS: ['style', 'form', 'input'],
    // 保留 class（代码高亮 shiki 的 hljs 类、任务列表样式依赖）
  })
  purifier.removeHook('afterSanitizeAttributes')
  return clean
}

/**
 * 对已渲染的 Markdown DOM 做图片本地化（异步步骤）。
 *
 * 为什么不放进 renderMarkdown：转 data URL 需要网络往返（cnb_fetch_image），
 * 而渲染必须同步返回；本函数在 MarkdownView 挂载后调用 —— 查询容器内
 * 带 data-cnb-src 的 <img>，逐个预热内存缓存并回填 data URL；
 * 失败时保持占位符并加灰块样式（不弹浏览器、不留破图）。
 *
 * @param rootEl 渲染容器（含 v-html 注入的 DOM）
 * @returns 清理函数（组件卸载时调用，防竞态回填已卸载的 DOM —— 虽然回填
 *   已卸载节点无副作用，仍显式取消以释放引用）
 */
export function hydrateMarkdownImages(rootEl: HTMLElement): () => void {
  const imgs = Array.from(rootEl.querySelectorAll<HTMLImageElement>('img[data-cnb-src]'))
  let cancelled = false
  for (const img of imgs) {
    const url = img.getAttribute('data-cnb-src')
    if (!url) {
      continue
    }
    // 非缓存命中场景：置灰块占位（下载完成/失败后由回填逻辑切换）
    void ensureCnbImage(url).then(() => {
      if (cancelled) {
        return
      }
      const dataUrl = cachedImageSrc(url)
      if (dataUrl && dataUrl !== url) {
        img.src = dataUrl
        img.removeAttribute('data-cnb-src')
      }
      else {
        // 下载失败（或非 Tauri 环境无通道）：灰块占位，绝不弹系统浏览器
        img.classList.add('md-img-fallback')
        img.removeAttribute('src')
      }
    })
  }
  return () => {
    cancelled = true
  }
}
