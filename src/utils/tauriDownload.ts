/**
 * Tauri 二进制下载通道封装（设计文档 §2.2 D2 裁决的前端出口）。
 *
 * 为什么必须走独立通道：archive / Release 附件是二进制响应，`cnbFetchText`
 * 的 `.text()` 会把字节按 UTF-8 解码破坏（zip 头损坏无法解压）。二进制
 * 下载**只能**走 Rust 命令 `cnb_download_archive`（流式落盘到系统下载
 * 目录），禁止经 cnbFetch/cnbFetchText 或 base64 IPC 通道。
 *
 * 非 Tauri 环境（浏览器 pnpm dev 调试）：返回 `{ unsupported: true }`
 * 而不抛异常 —— 调用方（下载菜单/附件列表）据此给出"桌面端专属"提示
 * 并外跳浏览器下载兜底，不产生未捕获 rejection。
 */

/** invoke 的返回结构（与 Rust CnbDownloadResult 对应，snake_case 由 invoke 自动转 camelCase） */
interface RustDownloadResult {
  path: string
  bytes: number
  contentType: string
  /** 服务端 Content-Disposition 原始头值；缺失（部分代理不透传）为 null */
  contentDisposition: string | null
}

/** 下载结果（调用方按 ok / unsupported 分支处理） */
export type DownloadResult =
  | { ok: true, path: string, bytes: number, contentType: string, contentDisposition: string | null }
  | { ok: false, message: string }
  | { unsupported: true }

/** 判断当前是否运行在 Tauri 桌面环境（Webview 会注入 __TAURI_INTERNALS__） */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/**
 * 下载二进制资源（源码包 archive / Release 附件），流式落盘到系统下载目录。
 *
 * 安全语义由 Rust 侧保证（前端不重复实现）：
 * - URL 白名单 `https://api.cnb.cool/` 前缀（调用方传非白名单 URL 会得到
 *   ok:false 与中文错误信息）；
 * - 文件名清洗：仅 [A-Za-z0-9._-]，后缀限 .zip/.tar.gz/.tgz，拒绝路径穿越；
 * - Bearer 认证：token 由调用方传入（登录态），私有仓库下载必需。
 *
 * @param url CNB API 域内的资源地址（如 https://api.cnb.cool/{repo}/-/git/archive/{ref}）
 * @param fileName 期望的落盘文件名（重名时 Rust 侧自动追加 " (2)"，不覆盖）
 * @param token Bearer 令牌（cnbToken.value；空串/undefined 时不携带认证头）
 */
export async function downloadArchive(
  url: string,
  fileName: string,
  token?: string,
): Promise<DownloadResult> {
  // 非 Tauri（浏览器调试）：明确返回不支持，由调用方给外跳兜底，不抛异常
  if (!isTauri()) {
    return { unsupported: true }
  }
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const result = await invoke<RustDownloadResult>('cnb_download_archive', {
      url,
      fileName,
      // Option<String> 语义：空串按"无令牌"处理，Rust 侧不附加认证头
      token: token || null,
    })
    return {
      ok: true,
      path: result.path,
      bytes: result.bytes,
      contentType: result.contentType,
      contentDisposition: result.contentDisposition,
    }
  }
  catch (err) {
    // Rust 侧 Err(String)：中文错误信息直接透传给调用方 toast
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}
