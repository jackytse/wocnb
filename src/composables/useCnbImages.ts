/**
 * CNB 图片内存缓存（修复下拉菜单打开时头像闪动）。
 *
 * 问题根因（两层叠加）：
 * 1. CNB 头像/组织图标接口返回 `cache-control: no-cache` —— Webview 的
 *    HTTP 缓存每次都要重新协商（ETag 条件请求），图片从发起到绘制有
 *    一个网络往返的空窗期；
 * 2. 下拉菜单（UDropdownMenu/reka-ui）内容每次打开都会卸载重建，
 *    菜单条目里的 UAvatar <img> 元素随之全部重建，重新加载期间
 *    头像区域闪现占位符（首字母/空白）。
 *
 * 解决思路：把图片字节拉到 JS 内存，转成 data URL 作为 <img> 的 src ——
 * data URL 解码无网络参与，菜单重新挂载时 <img> 瞬时绘制，不再闪动。
 * 拉取通道：Webview fetch 不可用（图片接口无 CORS 头，且实测带
 * `Origin: tauri://localhost` 的请求会被 CNB 网关 403），故走
 * Rust 侧 cnb_fetch_image 命令（native-tls 直连，白名单仅 cnb.cool）。
 *
 * 使用方式：
 * - 写侧：`ensureCnbImage(url)` 预热缓存（组件挂载/数据加载后调用，
 *   内部带去重，重复调用不会重复拉取）；
 * - 读侧：`cachedImageSrc(url)` 返回缓存命中时的 data URL，未命中
 *   返回原 URL（首次打开仍走网络显示，预热完成后后续打开零闪动）。
 */
import { reactive } from 'vue'
import { invoke } from '@tauri-apps/api/core'

/** cnb_fetch_image 命令的返回结构（见 lib.rs 中 CnbImageResponse） */
interface CnbImageResponse {
  /** HTTP 状态码（200 才有有效图片字节） */
  status: number
  /** 服务器返回的 Content-Type（可能是不精确的 image/*） */
  content_type: string
  /** 图片原始字节的标准 base64 编码 */
  body_base64: string
}

/**
 * 响应式缓存表：原始 URL -> data URL。
 * reactive 包装使缓存的写入/读取可被 Vue 追踪 —— 组件模板中通过
 * cachedImageSrc(url) 读取，缓存就绪后界面自动切换为 data URL。
 * 会话级缓存（不持久化）：头像变更场景少，重启后重新预热即可。
 */
const imageCache = reactive(new Map<string, string>())

/** 去重表：进行中的拉取 Promise（防止并发触发多次网络请求） */
const pending = new Map<string, Promise<void>>()

/**
 * 从图片字节嗅探 MIME 类型。
 * 背景：CNB 图片接口返回的 Content-Type 是不精确的 "image/*" 字面量，
 * 而 data URL 的解码依赖 mime 声明，需要根据文件魔数自行判断。
 * @param bytes 图片原始字节
 * @returns 精确的 image mime；无法识别时返回通用 image/png（浏览器
 *   的 <img> 加载流程对不匹配的 mime 宽容，仍可正常解码显示）
 */
function sniffImageMime(bytes: Uint8Array): string {
  // PNG 魔数：89 50 4E 47 0D 0A 1A 0A
  if (bytes.length > 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
    return 'image/png'
  }
  // JPEG 魔数：FF D8 FF
  if (bytes.length > 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
    return 'image/jpeg'
  }
  // GIF 魔数：47 49 46 38（"GIF8"）
  if (bytes.length > 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return 'image/gif'
  }
  // WebP：RIFF....WEBP
  if (bytes.length > 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp'
  }
  // 未知格式兜底：png（img 元素加载时浏览器按内容解码，mime 仅作声明）
  return 'image/png'
}

/**
 * 预热指定图片到内存缓存。
 *
 * 行为：
 * - 已缓存：立即返回（幂等）；
 * - 拉取中：复用进行中的 Promise（并发去重）；
 * - 失败：静默吞掉（调用方不感知）—— 图片加载失败时 UAvatar 组件
 *   自身有首字母占位兜底，缓存层失败不应影响界面可用性。
 *
 * @param url CNB 图片地址（https://cnb.cool/ 前缀）
 */
export function ensureCnbImage(url: string): Promise<void> {
  // 环境守卫：非 Tauri 环境（浏览器直接 pnpm dev）无法 invoke，
  // 且无法 fetch（无 CORS 头）—— 直接跳过预热，保持原 URL 显示
  if (!('__TAURI_INTERNALS__' in window) || !url.startsWith('https://cnb.cool/')) {
    return Promise.resolve()
  }
  if (imageCache.has(url)) {
    return Promise.resolve()
  }
  const existing = pending.get(url)
  if (existing) {
    return existing
  }
  const task = (async () => {
    try {
      const resp = await invoke<CnbImageResponse>('cnb_fetch_image', { url })
      if (resp.status !== 200 || !resp.body_base64) {
        // 非 200（如组织图标被删）不缓存，保持原 URL 让 UAvatar 走失败兜底
        return
      }
      // base64 -> 二进制 -> 嗅探 mime -> data URL
      const raw = atob(resp.body_base64)
      const bytes = new Uint8Array(raw.length)
      for (let i = 0; i < raw.length; i++) {
        bytes[i] = raw.charCodeAt(i)
      }
      const mime = sniffImageMime(bytes)
      // 二进制转 base64：直接复用服务器返回的 base64 字符串，避免
      // Uint8Array 再次编码的开销（chunk 化防栈溢出）
      imageCache.set(url, `data:${mime};base64,${resp.body_base64}`)
    }
    catch {
      // 拉取失败静默：保持原 URL 显示（等效于现状，不劣化）
    }
    finally {
      pending.delete(url)
    }
  })()
  pending.set(url, task)
  return task
}

/**
 * 读取图片的展示地址：缓存命中返回 data URL（同步绘制不闪动），
 * 未命中返回原 URL（走网络，行为与此前一致）。
 *
 * 在组件模板中直接使用 —— 返回值依赖响应式 imageCache，
 * 缓存写入后引用它的组件会自动重渲染。
 */
export function cachedImageSrc(url: string | undefined): string | undefined {
  if (!url) {
    return url
  }
  return imageCache.get(url) ?? url
}

/**
 * 批量预热：并发拉取多个图片（Promise.allSettled，单个失败不影响其他）。
 * 典型场景：组织列表加载完成后预热全部组织图标。
 */
export function ensureCnbImages(urls: (string | undefined)[]): Promise<void> {
  const tasks = urls.filter((u): u is string => !!u).map(u => ensureCnbImage(u))
  return Promise.allSettled(tasks).then(() => undefined)
}
