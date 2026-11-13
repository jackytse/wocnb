use tauri::{
    tray::{TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};
use tauri_plugin_notification::NotificationExt;

/// cnb-cli 集成模块：OAuth 设备授权登录 + CLI 检测/安装/令牌生命周期。
/// 设计与 CLI 行为依据见模块顶部注释（src-tauri/src/cnb_cli.rs）。
mod cnb_cli;

/// 托盘实例 ID，用于构建后标识（当前仅一处使用，保留常量便于扩展）
const TRAY_ID: &str = "main-tray";

// 托盘右键菜单（原生 muda 菜单）的存放位置。
//
// 为什么不用 Tauri 的 `tauri::menu::Menu` 挂到托盘？
// 见 popup_menu_at_cursor 的注释——多显示器下 tray-icon 的
// `performClick` 弹菜单会定位到错误屏幕，因此菜单不挂到托盘、
// 不交给 tray-icon 弹出，而是右键时由我们自己按光标位置弹出；
// Tauri 的 Menu 无法拿到底层 NSMenu 指针（`inner()` 是 pub(crate)），
// 所以直接用 muda 构建菜单（与 Tauri 内部同版本，共享事件通道）。
//
// 为什么用 thread_local 而不是 `app.manage()`？
// muda 菜单内部是 Rc（非 Send/Sync），不满足 Tauri State 的线程约束；
// 而 Tauri 的 setup 与托盘事件回调都保证在主线程执行，
// thread_local 语义恰好匹配，且无跨线程风险。
#[cfg(target_os = "macos")]
thread_local! {
    static TRAY_NATIVE_MENU: std::cell::RefCell<Option<muda::Menu>> =
        const { std::cell::RefCell::new(None) };
}

/// 在当前鼠标光标位置弹出原生 NSMenu（macOS 专用）。
///
/// # 多显示器修复说明
///
/// tray-icon 库在右键弹出菜单时的实现是：
/// `status_item.setMenu(menu)` + `ns_button.performClick()` ——
/// 即"模拟点击"状态栏按钮。模拟点击不携带鼠标位置信息，系统会把
/// 菜单弹在状态项按钮原始所在的那块屏幕（通常是主屏）；当用户在
/// 外接屏（显示器 B）的菜单栏上点击托盘图标时，菜单就会弹到主屏。
///
/// 本函数改用 AppKit 的
/// `-[NSMenu popUpMenuPositioningItem:atLocation:inView:]`
/// （inView 传 nil 时 location 为屏幕坐标，AppKit 左下角原点），
/// 位置取 `NSEvent.mouseLocation`（光标真实全局坐标），因此无论
/// 用户在哪块屏点击，菜单都精确弹在光标下方，与系统原生行为一致。
///
/// # 安全性
///
/// - 必须在主线程调用（托盘事件回调本身在主线程执行）；
/// - `ns_menu` 指针来自 muda 菜单，生命周期由应用状态 `TrayNativeMenu`
///   保证（存活至进程退出），调用期间不会被释放；
/// - `popUpMenuPositioningItem` 会同步进入菜单跟踪（嵌套事件循环），
///   与 tray-icon 自身 performClick 的行为一致，无额外风险。
#[cfg(target_os = "macos")]
unsafe fn popup_menu_at_cursor(ns_menu: *mut std::ffi::c_void) {
    use objc2::{class, msg_send, runtime::AnyObject};

    unsafe {
        // 把 muda 给出的裸指针包装为 &AnyObject 用于消息发送；
        // 只借用不管理生命周期（所有权仍在 TRAY_NATIVE_MENU）
        let menu = &*(ns_menu as *const AnyObject);

        // NSEvent.mouseLocation：光标的全局屏幕坐标
        // （AppKit 坐标系：主屏左下角为原点，y 向上，单位为 point）
        let location: objc2_core_foundation::CGPoint = msg_send![class!(NSEvent), mouseLocation];

        // positioningItem 传 nil：弹出整个菜单（光标处为菜单左上角附近）；
        // inView 传 nil：location 按屏幕坐标解释 —— 这是多屏定位正确的关键
        let item: Option<&AnyObject> = None;
        let view: Option<&AnyObject> = None;
        let _: () = msg_send![
            menu,
            popUpMenuPositioningItem: item,
            atLocation: location,
            inView: view
        ];
    }
}

/// Tauri 命令：返回问候语。
/// 用途：验证前端 JS 与 Rust 后端的 invoke 通信链路是否打通，
/// 是 Tauri 官方模板的标准示例命令，也是集成测试的锚点。
///
/// # 参数
/// * `name` - 前端传入的用户名（可为空字符串，不校验非空）
///
/// # 返回
/// 格式为 `Hello, {name}! You've been greeted from Rust!` 的字符串
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {name}! You've been greeted from Rust!")
}

/// CNB API HTTP 代理命令：前端经 IPC 调用，由 Rust 侧 reqwest（native-tls）执行请求。
///
/// 背景与必要性：
/// 1. CNB API 不返回 CORS 头，Webview 内原生 fetch 会被浏览器内核拦截；
/// 2. tauri-plugin-http 底层 TLS 栈（rustls）的指纹被 CNB 网关风控拦截，
///    认证请求一律返回 403 "Forbidden"（诊断实验确认：同进程内
///    native-tls reqwest 全部 200，插件 rustls 全部 403）。
/// 因此自建请求通道，使用 native-tls + 强制直连（不读系统代理，行为可控）。
///
/// # 安全约束
/// - URL 白名单：仅允许 https://api.cnb.cool/ 前缀，防止任意 URL 请求（SSRF）
/// - 剥离 Host / Content-Length 等不应由调用方指定的头
///
/// # 返回
/// status 为 HTTP 状态码，body 为原始响应文本（由前端按 JSON 解析）
#[derive(serde::Serialize)]
struct CnbHttpResponse {
    status: u16,
    body: String,
}

/// 从调用方 headers 构建请求 HeaderMap（纯函数，便于单元测试）。
///
/// 为什么先建 HeaderMap 再 `.headers()` 一次性设置（2026-10-27 改造）：
/// 旧实现是 `.header("Accept", "application/json")` 后再逐个 `.header()`
/// 追加调用方 headers —— reqwest 的 `.header()` 是**追加**语义，导致
/// 调用方携带 `accept: text/plain` 时请求会同时出现两个 Accept 头，
/// 服务端按第一个（JSON）响应，raw 文本文件永远读不出来。
///
/// 规则：
/// 1. 跳过 host / content-length：传输层语义的头由 reqwest/服务器自行
///    处理，防止伪造或冲突；
/// 2. Accept 兜底：仅当调用方未携带 accept（大小写不敏感比较）时，
///    插入 "application/json"（保持既有 JSON 接口行为完全不变）；
/// 3. HeaderMap 的 `insert` 是替换语义，天然保证同名头唯一。
fn build_header_map(
    headers: &std::collections::HashMap<String, String>,
) -> reqwest::header::HeaderMap {
    use reqwest::header::{HeaderMap, HeaderName, HeaderValue};

    let mut map = HeaderMap::new();
    let mut has_accept = false;
    for (key, value) in headers {
        // 剥离传输层语义的头：由 reqwest/服务器自行处理，防止伪造或冲突
        let lower = key.to_lowercase();
        if lower == "host" || lower == "content-length" {
            continue;
        }
        if lower == "accept" {
            has_accept = true;
        }
        // 非法头名/头值（理论上 JS Headers 不会产生）直接跳过，不让单个坏头拖垮整个请求
        let (Ok(name), Ok(val)) = (
            HeaderName::from_bytes(key.as_bytes()),
            HeaderValue::from_bytes(value.as_bytes()),
        ) else {
            continue;
        };
        // insert（替换语义）而非 append（追加语义）：保证同名头唯一
        map.insert(name, val);
    }
    // Accept 兜底：调用方未显式指定时按 JSON 接口默认（与旧行为一致）
    if !has_accept {
        map.insert(
            reqwest::header::ACCEPT,
            HeaderValue::from_static("application/json"),
        );
    }
    map
}

#[tauri::command]
async fn cnb_http_request(
    method: String,
    url: String,
    headers: std::collections::HashMap<String, String>,
    body: Option<String>,
) -> Result<CnbHttpResponse, String> {
    use std::time::Duration;

    // 白名单校验：本应用所有 API 调用都应指向 CNB Open API
    // （复用 is_allowed_api_url 纯函数，与下载通道共用同一前缀常量）
    if !is_allowed_api_url(&url) {
        return Err("URL 不在 CNB API 白名单内".to_string());
    }
    let parsed_method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|e| format!("非法 HTTP 方法: {e}"))?;

    // no_proxy：强制直连。诊断实验中直连与默认配置均可达，
    // 直连可避免用户系统代理（Clash 等）分流规则影响 API 可用性
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .no_proxy()
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败: {e}"))?;

    // 头部统一经 build_header_map 构建（Accept 兜底 + 同名头唯一，见函数注释）
    let mut request = client
        .request(parsed_method.clone(), &url)
        .headers(build_header_map(&headers));

    // 请求体透传：reqwest 的 `.body(String)` 会自动计算 Content-Length；
    // Content-Type 由调用方 headers 提供（前端 cnbFetch 恒带 application/json），
    // Rust 侧不强写，避免覆盖调用方语义（如 text/plain 的 raw 请求）。
    // GET/HEAD 不允许携带 body（HTTP 语义），保持 None 时行为与旧版完全一致。
    if let Some(text) = body {
        if parsed_method != reqwest::Method::GET && parsed_method != reqwest::Method::HEAD {
            request = request.body(text);
        }
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("网络请求失败: {e}"))?;
    let status = response.status().as_u16();
    let body = response
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {e}"))?;
    Ok(CnbHttpResponse { status, body })
}

/// CNB 图片拉取命令：下载头像/组织图标并以 base64 返回给前端。
///
/// 背景与必要性（修复"打开菜单时头像闪动"）：
/// 1. CNB 头像/图标接口返回 `cache-control: no-cache`，Webview 里每次
///    重建 <img>（下拉菜单内容每次打开都会重新挂载）都会重新发起网络
///    请求，加载完成前头像区域闪现占位符；
/// 2. 前端无法用 fetch 把图片转成本地缓存 —— 图片接口不返回 CORS 头，
///    且实测携带 `Origin: tauri://localhost` 的请求会被 CNB 网关
///    直接 403（与 api.cnb.cool 的 TLS 指纹风控同源）。
/// 因此由 Rust 侧 native-tls 直连下载，前端把 base64 转成 data URL
/// 存入内存缓存，<img> 用 data URL 同步绘制，彻底消除闪动。
///
/// # 安全约束
/// - URL 白名单：仅允许 https://cnb.cool/ 前缀（图片资源所在域），
///   防止任意 URL 下载（SSRF）
/// - 响应大小上限 2 MiB：头像/图标远小于该值，防御异常超大响应
///
/// # 返回
/// status 为 HTTP 状态码；body_base64 为原始字节的标准 base64 编码；
/// content_type 为服务器返回的 Content-Type（前端据此构造 data URL）
#[derive(serde::Serialize, Debug)]
struct CnbImageResponse {
    status: u16,
    content_type: String,
    body_base64: String,
}

/// 图片 URL 白名单校验：仅允许 cnb.cool 主站的 https 资源。
/// 独立成纯函数便于单元测试（无需网络与异步运行时）。
fn is_allowed_image_url(url: &str) -> bool {
    url.starts_with("https://cnb.cool/")
}

#[tauri::command]
async fn cnb_fetch_image(url: String) -> Result<CnbImageResponse, String> {
    use std::time::Duration;

    // 白名单校验：头像/组织图标均位于 cnb.cool 主站（如
    // https://cnb.cool/users/{u}/avatar/s、https://cnb.cool/{path}/-/logos/s）
    if !is_allowed_image_url(&url) {
        return Err("URL 不在 CNB 图片白名单内".to_string());
    }

    // 与 cnb_http_request 相同的通道策略：native-tls + 强制直连，
    // 规避 Webview CORS 限制与 rustls TLS 指纹风控
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .no_proxy()
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败: {e}"))?;

    let response = client
        .get(&url)
        // 图片资源无需认证（公开端点），仅声明接受图片类型
        .header("Accept", "image/*")
        .send()
        .await
        .map_err(|e| format!("图片请求失败: {e}"))?;

    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();

    // 2 MiB 上限：防止异常超大响应占用内存（正常头像 20~150KB）
    let bytes = if status == 200 {
        let bytes = response.bytes().await.map_err(|e| format!("读取图片失败: {e}"))?;
        if bytes.len() > 2 * 1024 * 1024 {
            return Err("图片体积超过 2MiB 上限".to_string());
        }
        bytes
    } else {
        // 非 200 不返回体积无意义的错误页字节，交由前端按 status 处理
        Default::default()
    };

    use base64::Engine as _;
    let body_base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(CnbImageResponse { status, content_type, body_base64 })
}

/// CNB API URL 白名单前缀常量：本应用所有 API 类请求（JSON 通道 +
/// 下载通道）都只允许指向 CNB Open API。
///
/// 为什么是前缀匹配而非域名解析：`https://api.cnb.cool.evil.com/` 同样
/// "包含" api.cnb.cool，前缀匹配能拒绝这种伪造域（is_allowed_api_url
/// 单测锁定）；`http://api.cnb.cool/` 因缺 `https://` 前缀同样被拒。
/// 此常量不放松 —— 放宽白名单等于给 SSRF 开口（设计文档 R6）。
const API_URL_PREFIX: &str = "https://api.cnb.cool/";

/// CNB API URL 白名单校验（纯函数，便于单元测试）。
/// 仅允许 https 协议 + api.cnb.cool 域 + 以 `/` 结尾路径开头的 URL。
/// 独立成纯函数与 is_allowed_image_url（图片通道）同一可测范式。
fn is_allowed_api_url(url: &str) -> bool {
    url.starts_with(API_URL_PREFIX)
}

/// 下载文件名清洗（纯函数，便于单元测试）。
///
/// 规则（设计文档 §2.2 要点 2，全部是硬约束）：
/// 1. 拒绝路径穿越与分隔符：`/`、`\`、`..`、`\0` 及任何控制字符；
/// 2. 只保留白名单字符 `[A-Za-z0-9._-]`，其余字符一律剔除（中文/空格等）；
/// 3. 剩余内容不得为空、不得为 `.` / `..`（防归一化后变成路径）；
/// 4. 后缀必须在白名单内：.zip / .tar.gz / .tgz（源码包与 Release 附件中
///    可安全落盘的压缩包类型；.exe 等可执行文件**不在**白名单 —— 桌面端
///    自动落盘可执行文件风险过高，此类附件由前端引导浏览器下载）；
/// 5. 长度 ≤ 120（文件系统单文件名安全上限）。
///
/// 返回 None 表示清洗失败（调用方应返回错误给前端）。
fn sanitize_archive_name(name: &str) -> Option<String> {
    // 规则 1：路径分隔符 / 空字节 / 控制字符直接拒绝
    if name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || name.contains('\0')
        || name.chars().any(|c| c.is_control())
    {
        return None;
    }

    // 规则 2：白名单字符过滤（其余字符剔除而非整体拒绝，体验更宽容）
    let filtered: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        .collect();

    // 规则 3：空串 / 纯点（"."、"..", 已被规则 1 拦截 ".."，这里拦 "."）
    if filtered.is_empty() || filtered == "." {
        return None;
    }

    // 规则 4 前置：去掉扩展名后主名（stem）不得为空 —— 形如 ".zip"、
    // ".tar.gz" 的名字没有可读主名（且会落成隐藏文件），拒绝
    let ext_len = extension_len(&filtered);
    let stem_len = filtered.chars().count() - ext_len;
    if stem_len == 0 {
        return None;
    }

    // 规则 5：长度上限
    if filtered.chars().count() > 120 {
        return None;
    }

    // 规则 4：后缀白名单（小写比较，.ZIP 视同 .zip）
    let lower = filtered.to_lowercase();
    let allowed = lower.ends_with(".zip")
        || lower.ends_with(".tar.gz")
        || lower.ends_with(".tgz");
    if !allowed {
        return None;
    }

    Some(filtered)
}

/// 后缀 -> 扩展名长度：计算文件名中扩展名部分（含点）的字符数。
/// 用于重名追加序号时插在扩展名之前（`a (2).zip` 而非 `a.zip (2)`）。
/// tar.gz 是双段扩展名，需按最长匹配（.tar.gz 优先于 .gz，虽然后者不在白名单）。
fn extension_len(name: &str) -> usize {
    let lower = name.to_lowercase();
    for ext in [".tar.gz", ".tgz", ".zip"] {
        if lower.ends_with(ext) {
            return ext.len();
        }
    }
    0
}

/// 生成不重名的落盘路径（纯函数，便于单元测试）。
///
/// 与浏览器行为一致：目标文件已存在时不覆盖，追加 ` (2)`、` (3)`…
/// 序号插在扩展名之前（`v1.0.0 (2).zip`）。
/// `exists` 由调用方注入（真实文件系统检查或测试桩），保持纯函数可测。
fn next_available_path(dir: &std::path::Path, file_name: &str, exists: &dyn Fn(&std::path::Path) -> bool) -> std::path::PathBuf {
    let candidate = dir.join(file_name);
    if !exists(&candidate) {
        return candidate;
    }
    // 已存在：拆出 stem 与扩展名，逐个尝试序号直到不冲突
    let ext_len = extension_len(file_name);
    let (stem, ext) = if ext_len > 0 {
        let (s, e) = file_name.split_at(file_name.len() - ext_len);
        (s, e)
    } else {
        (file_name, "")
    };
    for index in 2..10000u32 {
        let candidate = dir.join(format!("{stem} ({index}){ext}"));
        if !exists(&candidate) {
            return candidate;
        }
    }
    // 10000 个序号全冲突（理论上不可能）：退化为时间戳命名兜底
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    dir.join(format!("{stem}-{ts}{ext}"))
}

/// 下载结果：保存路径 + 实际字节数 + 服务端 Content-Type / Content-Disposition。
///
/// content_disposition 为服务端原始头值（如 `attachment; filename="x.zip"`），
/// 原样透传不做解析 —— 前端真实下载一次即可据此回答 Q5（archive 真实
/// 扩展名探测）：判定优先级 Content-Disposition 的 filename > Content-Type
/// 映射 > 请求所选格式（设计文档 §2.2 要点 7 / §1.6）。
#[derive(serde::Serialize, Debug)]
struct CnbDownloadResult {
    path: String,
    bytes: u64,
    content_type: String,
    content_disposition: Option<String>,
}

/// 累计字节上限：1 GiB（设计文档 §2.2 要点 6）。
/// 超限立即中止下载并删除 .part 半成品，防止磁盘被异常超大响应写满。
const DOWNLOAD_MAX_BYTES: u64 = 1024 * 1024 * 1024;
/// 下载超时（秒）：源码包可能数十 MB，慢网络下给足 300s。
const DOWNLOAD_TIMEOUT_SECS: u64 = 300;

/// CNB 源码包 / Release 附件下载命令：Rust 侧流式下载并直接落盘到系统下载目录。
///
/// 背景（D2 裁决，设计文档 §2.2）：
/// 1. archive / 附件响应是二进制，`cnbFetchText` 的 `.text()` 会把字节按
///    UTF-8 解码破坏（zip 头损坏无法解压），二进制**必须**走本命令；
/// 2. 方案对比：base64 经 IPC 内存约 2.3×且大字符串阻塞主线程；浏览器外跳
///    对私有仓库必然 401 —— 流式落盘是唯一可行主路径；
/// 3. Release 附件的 `url` 同样在 `api.cnb.cool` 域内，复用同一条命令，
///    一次实现覆盖两个需求。
///
/// # 安全约束（R6，全部强制）
/// - URL 白名单：仅允许 `https://api.cnb.cool/` 前缀（is_allowed_api_url）；
/// - 只发 GET（不做 method 参数化，杜绝被滥用为任意请求通道）；
/// - `redirect::Policy::none()`：不跟随重定向，防止白名单 URL 302 到任意域；
/// - 不接受调用方自定义 header：仅按需附加 Bearer 认证头（token 参数由前端
///   从登录态传入，属固定语义而非任意 header）—— 私有仓库下载必须携带
///   repo-code:r Bearer，否则必然 401（设计文档 §2.2 依据 3）；
/// - 文件名严格清洗（sanitize_archive_name）：拒绝路径穿越 / 非白名单扩展名；
/// - 累计字节 1 GiB 上限；总超时 300s；
/// - 通道策略与既有命令同构：native-tls（reqwest 默认 TLS 栈，**不要切
///   rustls** —— 已被 CNB 风控 403）+ `.no_proxy()` 强制直连。
///
/// # 原子性
/// 先写 `{name}.part`，全部写完且未超限才 rename 为最终名；任何一步失败
/// 都删除 `.part`，避免半文件被用户当成完整包解压（§2.2 要点 5）。
///
/// # 重名
/// 目标文件已存在时追加 ` (2)`、` (3)`（next_available_path），不覆盖。
#[tauri::command]
async fn cnb_download_archive(
    url: String,
    file_name: String,
    token: Option<String>,
) -> Result<CnbDownloadResult, String> {
    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;
    use std::time::Duration;

    // 1. 白名单校验：SSRF 防线（不放松前缀，见 API_URL_PREFIX 注释）
    if !is_allowed_api_url(&url) {
        return Err("URL 不在 CNB API 白名单内".to_string());
    }

    // 2. 文件名清洗：路径穿越 / 非法字符 / 非白名单扩展名一律拒绝
    let safe_name = sanitize_archive_name(&file_name)
        .ok_or_else(|| "文件名不合法：仅支持 .zip / .tar.gz / .tgz，且不含路径分隔符".to_string())?;

    // 3. 落盘目录：系统下载目录 → ~/Downloads → 系统临时目录（三级回退）
    let dir = dirs::download_dir()
        .or_else(|| dirs::home_dir().map(|h| h.join("Downloads")))
        .unwrap_or_else(std::env::temp_dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建下载目录失败: {e}"))?;

    // 4. 不重名路径：已存在则追加 " (2)"，绝不覆盖已有文件
    let target = next_available_path(&dir, &safe_name, &|p: &std::path::Path| p.exists());
    // 半成品临时文件：与最终名同目录同后缀，成功后原子 rename
    let part_path = dir.join(format!(
        "{}.part",
        target.file_name().and_then(|n| n.to_str()).unwrap_or("download")
    ));

    // 5. 请求客户端：与 cnb_http_request / cnb_fetch_image 同构的通道策略
    //    （native-tls 默认栈 + no_proxy 强制直连），另加 redirect none
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(DOWNLOAD_TIMEOUT_SECS))
        .no_proxy()
        // 不跟随重定向：白名单 URL 若被 302 到其他域，跟随等于绕过白名单
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败: {e}"))?;

    // 6. 只发 GET；header 仅按需附加 Bearer（不接受调用方自定义 header）
    let mut request = client.get(&url);
    if let Some(t) = token.as_deref() {
        if !t.is_empty() {
            request = request.bearer_auth(t);
        }
    }
    let response = request
        .send()
        .await
        .map_err(|e| format!("下载请求失败: {e}"))?;

    let status = response.status().as_u16();
    // 7. 非 2xx：中文错误透传给前端 toast（设计文档 §2.2 要点 7）
    if !(200..300).contains(&status) {
        // 尽力读取错误响应体（服务端 errmsg 便于定位），失败不影响主错误
        let body = response.text().await.unwrap_or_default();
        let message = match status {
            401 => "令牌已过期，请重新登录",
            403 => "缺少 repo-code:r 权限，无法下载",
            404 => "该引用不存在或仓库已归档",
            _ => "下载失败",
        };
        // 附加服务端原始信息片段（截断防超长）
        let detail: String = body.chars().take(200).collect();
        if detail.is_empty() {
            return Err(format!("{message}（HTTP {status}）"));
        }
        return Err(format!("{message}（HTTP {status}）：{detail}"));
    }

    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    // Content-Disposition 原样透传（不解析 filename，由前端按需提取）；
    // 头缺失（常见于部分代理）时为 None，前端回退 Content-Type / 请求格式判定
    let content_disposition = response
        .headers()
        .get(reqwest::header::CONTENT_DISPOSITION)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.to_string());

    // 8. 流式写 .part：逐 chunk 落盘 + 累计字节检查（不在内存攒整个文件）
    let mut file = tokio::fs::File::create(&part_path)
        .await
        .map_err(|e| format!("创建临时文件失败: {e}"))?;
    let mut stream = response.bytes_stream();
    let mut total: u64 = 0;

    let write_result: Result<(), String> = async {
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("读取下载数据失败: {e}"))?;
            total += chunk.len() as u64;
            // 1 GiB 上限：超限立即中止（外层负责清理 .part）
            if total > DOWNLOAD_MAX_BYTES {
                return Err("文件超过 1GiB 上限，已中止下载".to_string());
            }
            file.write_all(&chunk)
                .await
                .map_err(|e| format!("写入临时文件失败: {e}"))?;
        }
        file.flush()
            .await
            .map_err(|e| format!("写入临时文件失败: {e}"))?;
        Ok(())
    }
    .await;

    // 9. 失败清理：删除 .part 半成品（半 zip 不能被用户误当完整包）
    if let Err(message) = write_result {
        let _ = tokio::fs::remove_file(&part_path).await;
        return Err(message);
    }

    // 10. 原子 rename：.part → 最终名（同目录内 rename 是原子操作）
    tokio::fs::rename(&part_path, &target)
        .await
        .map_err(|e| {
            // rename 失败同样清理 .part（目标被占用等极端情况）
            let part = part_path.clone();
            tokio::spawn(async move {
                let _ = tokio::fs::remove_file(&part).await;
            });
            format!("保存文件失败: {e}")
        })?;

    Ok(CnbDownloadResult {
        path: target.to_string_lossy().to_string(),
        bytes: total,
        content_type,
        content_disposition,
    })
}

/// 系统通知点击上报时 emit 给前端的 payload。
///
/// 字段与前端 `src/composables/useBuildNotificationAction.ts` 的
/// BuildNotificationActionPayload 一一对应（camelCase 序列化），两端
/// 改动必须同步。设计说明见该 TS 文件与下方 on_action 注册处注释。
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BuildNotificationActionPayload {
    /// 点击动作 id：点通知本体为 "tap"，点 action 按钮为按钮 id（本应用为 "open"）
    action_id: String,
    /// 系统通知的数字 id（前端 sendNotification 传入），读不到时为 None
    notification_id: Option<i32>,
    /// 通知 extra 里携带的仓库完整路径（前端写入，点击时原样带回）
    repo_path: Option<String>,
    /// 构建序号
    sn: Option<String>,
    /// 通知类型：single / digest / leftover / test
    kind: Option<String>,
}

/// 系统通知 ActionType 的 id（**必须与前端常量完全一致**）。
///
/// 前端同值常量：`src/composables/useCnbBuildWatch.ts` 的
/// `BUILD_NOTIFY_ACTION_TYPE_ID`。改一处必须改另一处。
///
/// # 为什么必须注册 ActionType（反直觉，勿当冗余删掉）
///
/// macOS 走 notify-rust 4.18.2 的 NSUserNotificationCenter 旧后端。点击
/// 上报能否成功，取决于发送时是否**真的阻塞等响应**：
/// - notify-rust `wait_for_response` 以 `asynchronous: false` 调底层
///   `send_mac_notification`；
/// - mac-notification-sys 的 `needs_response()` =
///   `main_button.is_some() || close_button.is_some() || wait_for_click`；
/// - 没有 action 按钮 → 三者皆 false → `should_wait = false` →
///   send() 立即返回（只等 ≤2s 的 didDeliver XPC 确认），notify.m 随即
///   清掉 pending map；
/// - 用户之后点击 → didActivate 找不到 pending entry → **上报被丢弃** →
///   插件 wait() 收到 Closed(Expired) 后 `_ => return`，永不 dispatch。
///   现象：通知能弹出，点击完全没反应（QA 实测确认的静默 no-op）。
///
/// 注册 1 个 Action 后 `main_button = Some(SingleAction)` →
/// `should_wait = true` → 阻塞等待，通知本体点击(tap)与按钮(action)都能
/// 回调到 on_action。这是"必须注册 ActionType"的全部原因。
const BUILD_NOTIFY_ACTION_TYPE_ID: &str = "cnbBuildOpen";

/// 从通知 extra 的 serde_json::Value 中安全取字符串字段。
/// extra 值类型不受前端约束（理论上可为任意 JSON），非字符串一律按"无"处理
/// ——这也是前端 buildSystemNotificationOptions 里要把 sn/repoPath 用
/// String() 收敛的原因（数字 sn 会在这里被当成"无"）。
fn extra_str(extra: &std::collections::HashMap<String, serde_json::Value>, key: &str) -> Option<String> {
    extra
        .get(key)
        .and_then(|value| value.as_str())
        .map(|s| s.to_string())
}

/// 显示并聚焦主窗口（托盘左键单击或菜单"打开应用"时调用）。
/// 若窗口此前被隐藏（点关闭按钮）或最小化，show 会将其恢复到前台。
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// 应用入口：构建 Tauri Builder 并启动事件循环。
/// - 注册 greet 命令供前端 invoke
/// - 初始化系统托盘（W 图标、左键打开应用、右键弹菜单）
/// - 拦截主窗口关闭事件：隐藏而非退出，应用常驻托盘
/// - 仅在 debug 构建下挂载日志插件（release 下关闭，避免额外开销）
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            greet,
            cnb_http_request,
            cnb_fetch_image,
            // —— 二进制下载通道（源码包 / Release 附件，设计文档 D2）——
            cnb_download_archive,
            // —— cnb-cli 集成（OAuth 设备授权登录）——
            cnb_cli::cnb_cli_detect,
            cnb_cli::cnb_cli_install,
            cnb_cli::cnb_cli_login,
            cnb_cli::cnb_cli_login_poll,
            cnb_cli::cnb_cli_cancel_login,
            cnb_cli::cnb_cli_read_token,
            cnb_cli::cnb_cli_refresh_token,
            cnb_cli::cnb_cli_logout,
        ])
        // opener 插件：向前端暴露 open_url 命令，用于在系统默认浏览器中打开外部链接
        // （Tauri Webview 会拦截 target="_blank" 新窗口请求，必须显式转交系统浏览器）
        .plugin(tauri_plugin_opener::init())
        // notification 插件：向系统通知中心发送构建结果通知。前端经
        // @tauri-apps/plugin-notification 调用；权限申请由前端在"用户开启
        // 开关 / 首次有通知要发"时才发起，启动阶段不弹窗打扰。
        //
        // # macOS 实际后端（重要，勿改回错误说法）
        //
        // macOS 走的是 notify-rust 4.x 的 **NSUserNotificationCenter** 旧
        // 后端（系统已标记 deprecated 但仍可用）。UNUserNotificationCenter
        // 新后端需要开启 notify-rust 的 `preview-macos-un` feature，而本
        // 插件的 Cargo.toml **没有暴露该 feature**（只透传了 win7 相关
        // feature），因此当前无法切换到 UN 路径。
        //
        // # 点击上报与发送路径的语义变化（降级开关说明，勿删）
        //
        // setup 中注册了 register_action_types + Notification::on_action
        // （见下方）。插件 desktop.rs 的 show() 逻辑是
        // `let report = shared.has_listeners()`：
        // - 注册前（report == false）：走 show()，返回的 handle 立即被
        //   drop，drop 时以 asynchronous: true 兜底发送——通知"发完即忘"；
        // - 注册后（report == true）：走 show_tracked → 独立后台线程
        //   （thread name "notification"）执行 wait()。
        //
        // 注意：**线程是否真的阻塞等用户交互，取决于通知有没有 action 按钮**
        // （QA 已按 notify-rust / mac-notification-sys 源码校正）：
        // - 无 action 按钮：mac-notification-sys 的 needs_response() 为 false
        //   → send() 立即返回（仅等 ≤2s didDeliver 确认）→ 线程马上退出，
        //   且 pending map 被清掉 → 之后的点击上报被丢弃（静默 no-op）；
        // - 有 action 按钮（前端每条通知都带 actionTypeId，见下）：
        //   main_button=Some → should_wait=true → 真正阻塞等待用户点击/
        //   通知消失（自动消失由 mac-notification-sys 的 0.5s 轮询定时器
        //   兜底），点击后线程退出，不会永久泄漏。
        //
        // 所以"注册 ActionType"不是可选项，而是点击上报能成立的**前提**。
        // 若该路径在真机异常（通知不出、卡顿等），整体退回旧路径的开关就是
        // 下面这段 register_action_types + on_action 注册：注释掉即可回到
        // "发完即忘"，前端代码无需任何改动（前端只是收不到点击事件而已，
        // 通知本身照常弹出）。
        .plugin(tauri_plugin_notification::init())
        // 全局菜单事件：托盘右键菜单（原生 muda 菜单）的条目点击会经
        // Tauri 内部的 muda 事件通道转发到这里（Builder::on_menu_event
        // 接收所有 muda 菜单的事件，不区分菜单由谁创建）
        .on_menu_event(|app, event| {
            // 菜单事件分发：
            // - open：显示应用首页（主窗口）
            // - quit：app.exit 触发进程完全退出
            match event.id().0.as_str() {
                "open" => show_main_window(app),
                "quit" => app.exit(0),
                _ => {}
            }
        })
        .setup(|app| {
            // —— 系统通知点击上报（通知点击直达构建详情）——
            //
            // # 为什么必须在 Rust 侧注册
            //
            // tauri-plugin-notification 2.7.0 的 JS API 没有导出 onAction /
            // registerActionTypes（Options 里只有 actionTypeId 字段），JS 无法
            // 直接监听点击；on_action 是唯一入口（本平台为 macOS/Windows/
            // Linux DBus 通用实现，无平台 cfg 需求，故写通用代码）。
            //
            // # handler 约束（官方注释：runs on a background thread and
            // should return quickly）
            //
            // handler 里只做：取字段 → emit。禁止任何阻塞 IO / 网络 / 锁等待
            // ——它运行在插件的后台线程，慢处理会拖延其他通知的点击上报。
            //
            // # notification 为 None 的兜底
            //
            // ActionPerformed.notification 是 lenient 反序列化，平台描述方式
            // 不同，读不到时为 None。此时仍要 emit（至少带 actionId），前端
            // 收到后兜底打开应用内通知面板——宁可降级也不吞掉用户的点击。

            // —— 先注册 ActionType（点击上报的前提，机制见常量注释）——
            //
            // macOS 平台特性：**1 个 action 直接显示为按钮**；≥2 个 action
            // 会收进 "Options" 下拉菜单（按钮文案不再直观）。本应用只提供
            // "打开"一个动作，用 1 个。
            //
            // 为什么 title 用中文：目标用户为中文用户，按钮文案直接可读；
            // 暂时不做 i18n（ActionType 只在启动时注册一次，跟随前端语言
            // 切换需要额外 IPC，收益低——只影响按钮文字，不影响点击行为）。
            let action_type = tauri_plugin_notification::ActionType::builder(BUILD_NOTIFY_ACTION_TYPE_ID)
                .actions(vec![
                    tauri_plugin_notification::Action::builder("open", "打开").build(),
                ])
                .build();
            if let Err(err) = app.notification().register_action_types(vec![action_type]) {
                // 失败只降级不阻断启动：带 actionTypeId 的通知会因查不到
                // ActionType 而不挂按钮 → 点击不上报（静默失效，通知照发）。
                // 与 on_action 注册同样的容错口径，记录日志便于定位。
                log::warn!("[notification] 注册通知 ActionType 失败（点击通知将无法直达构建详情）: {err}");
            }

            let app_handle = app.handle().clone();
            let action_result = app.notification().on_action(move |action| {
                // extra 是前端随通知写入的定位载荷（repoPath/sn/kind）；
                // notification 读不到时 extra 视为空表，字段全部落到 None
                let extra = action
                    .notification()
                    .map(|notification| notification.extra().clone())
                    .unwrap_or_default();
                let payload = BuildNotificationActionPayload {
                    action_id: action.action_id().to_string(),
                    notification_id: action.notification().map(|notification| notification.id()),
                    repo_path: extra_str(&extra, "repoPath"),
                    sn: extra_str(&extra, "sn"),
                    kind: extra_str(&extra, "kind"),
                };
                if let Err(err) = app_handle.emit("cnb://build-notification-action", &payload) {
                    // emit 失败（事件名非法等）只影响"点击直达"，通知本身
                    // 已弹出，记日志即可，绝不 panic（panic 在后台线程会
                    // 拖垮插件的事件分发线程）
                    log::warn!("[notification] 点击事件转发前端失败: {err}");
                }
            });
            // on_action 注册失败不 panic：桌面端该调用永远成功（签名与移动端
            // 对齐），但防御性兜底——注册失败时退化为旧行为（通知照发、
            // 点击无响应），仅记录日志便于排查
            if let Err(err) = action_result {
                log::warn!("[notification] 注册通知点击上报失败（点击通知将无法直达构建详情）: {err}");
            }

            // —— 系统托盘 ——
            // 1. 构建托盘右键菜单（原生 muda 菜单，macOS）。
            //    注意：此菜单不挂到托盘图标上（不调用 TrayIconBuilder::menu），
            //    由 on_tray_icon_event 在右键时按光标位置手动弹出，
            //    以修复多显示器下 tray-icon performClick 弹错屏的问题。
            //    菜单条目点击事件经 Tauri 全局通道进入上面的 on_menu_event。
            #[cfg(target_os = "macos")]
            {
                use muda::{Menu, MenuId, MenuItem, PredefinedMenuItem};
                let open_item = MenuItem::builder()
                    .id(MenuId::new("open"))
                    .text("打开应用")
                    .enabled(true)
                    .build();
                let quit_item = MenuItem::builder()
                    .id(MenuId::new("quit"))
                    .text("退出应用")
                    .enabled(true)
                    .build();
                let tray_menu = Menu::new();
                tray_menu.append(&open_item)?;
                tray_menu.append(&PredefinedMenuItem::separator())?;
                tray_menu.append(&quit_item)?;
                // 存入主线程 thread_local：保持菜单存活（弹出时引用 NSMenu），
                // 供托盘事件回调读取（见 TRAY_NATIVE_MENU 注释）
                TRAY_NATIVE_MENU.with(|slot| *slot.borrow_mut() = Some(tray_menu));
            }

            // 2. 构建托盘图标：字母 W 的 PNG（编译期嵌入）。
            //    交互设计：
            //    - 左键单击：直接打开应用主窗口（on_tray_icon_event 中处理），
            //      不弹出菜单 —— 这是用户最常用的"回到应用"路径，一步直达；
            //    - 右键单击：按光标位置弹出原生菜单（见 popup_menu_at_cursor
            //      的多显示器修复说明），条目事件走 on_menu_event 回调；
            //    托盘实例由 App 的 TrayIconManager 内部持有，构建后即保持存活
            TrayIconBuilder::with_id(TRAY_ID)
                .icon(tauri::image::Image::from_bytes(include_bytes!(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/icons/tray-icon.png"
                )))?)
                .tooltip("WOCNB")
                .on_tray_icon_event(|tray, event| {
                    // 仅响应 Down（按下）状态；macOS 会额外派发 Up（抬起）
                    // 事件，不过滤会触发两次
                    if let TrayIconEvent::Click {
                        button,
                        button_state: tauri::tray::MouseButtonState::Down,
                        ..
                    } = event
                    {
                        match button {
                            // 左键单击：显示并聚焦主窗口（幂等的 show + set_focus）
                            tauri::tray::MouseButton::Left => {
                                show_main_window(tray.app_handle());
                            }
                            // 右键单击：在光标位置弹出原生菜单（多屏定位正确）
                            tauri::tray::MouseButton::Right => {
                                #[cfg(target_os = "macos")]
                                {
                                    // 先取出 NSMenu 指针并立即释放借用，
                                    // 再执行弹出（弹出过程含嵌套事件循环）
                                    use muda::ContextMenu;
                                    let ns_menu = TRAY_NATIVE_MENU
                                        .with(|slot| slot.borrow().as_ref().map(|m| m.ns_menu()));
                                    if let Some(ns_menu) = ns_menu {
                                        unsafe { popup_menu_at_cursor(ns_menu) };
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                })
                .build(app)?;

            // —— 日志插件（仅 debug）——
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // 拦截主窗口的关闭请求：隐藏窗口 + 阻止默认销毁行为，
            // 应用继续驻留系统托盘，仅能通过托盘菜单"退出应用"真正退出
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}

#[cfg(test)]
mod tests {
    use super::{
        build_header_map, greet, is_allowed_api_url, is_allowed_image_url, next_available_path,
        sanitize_archive_name, BUILD_NOTIFY_ACTION_TYPE_ID,
    };
    use std::collections::HashMap;

    /// BUILD_NOTIFY_ACTION_TYPE_ID 字面量锁定（QA Round 2 补充，跨语言契约双向锁）。
    ///
    /// 前端 useCnbBuildWatch.action.test.ts 已锁定 TS 侧字面量 'cnbBuildOpen'；
    /// 但若 Rust 侧常量被"顺手改名"，前端测试不会变红——通知会带旧 actionTypeId
    /// 发出、Rust 查不到 ActionType → 不挂按钮 → macOS 点击静默失效（通知照发）。
    /// 本用例把 Rust 侧也锁到同一字面量，任一侧改名必红。
    /// 改名属跨语言契约变更：必须两端同步 + 本用例与前端字面量用例一起改。
    #[test]
    fn test_build_notify_action_type_id_literal_lock() {
        assert_eq!(BUILD_NOTIFY_ACTION_TYPE_ID, "cnbBuildOpen");
    }

    /// 辅助：快速构造 headers HashMap
    fn hm(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    /// 普通输入：应按模板拼接出完整问候语
    #[test]
    fn test_greet_with_normal_name() {
        assert_eq!(greet("wocnb"), "Hello, wocnb! You've been greeted from Rust!");
    }

    /// 边界输入：空字符串不应 panic，返回空名字的问候语
    #[test]
    fn test_greet_with_empty_name() {
        assert_eq!(greet(""), "Hello, ! You've been greeted from Rust!");
    }

    /// 特殊字符：包含 UTF-8 多字节字符时正确拼接
    #[test]
    fn test_greet_with_unicode_name() {
        assert_eq!(greet("世界"), "Hello, 世界! You've been greeted from Rust!");
    }

    /// cnb_fetch_image 白名单（纯函数）：非 cnb.cool 域名的 URL 应拒绝（SSRF 防护）
    #[test]
    fn test_cnb_fetch_image_rejects_non_cnb_url() {
        assert!(!is_allowed_image_url("https://evil.example.com/avatar.png"));
        assert!(!is_allowed_image_url("http://cnb.cool/-/logos/s"));
        assert!(!is_allowed_image_url("https://cnb.cool.evil.com/avatar.png"));
    }

    /// cnb_fetch_image 白名单（纯函数）：cnb.cool 主站 https 资源应放行，
    /// api.cnb.cool 子域不允许（图片资源仅存在于主站，防图片命令被滥用为 API 通道）
    #[test]
    fn test_cnb_fetch_image_allows_cnb_site_only() {
        assert!(is_allowed_image_url("https://cnb.cool/cnb/-/logos/s"));
        assert!(is_allowed_image_url("https://cnb.cool/users/megadron/avatar/s"));
        assert!(!is_allowed_image_url("https://api.cnb.cool/user"));
    }

    /// build_header_map：调用方显式指定 accept 时，Accept 头唯一且取调用方值。
    /// 回归背景：旧实现 `.header("Accept", ...)` 是追加语义，会同时出现两个
    /// Accept，raw 文本请求被服务端按 JSON 响应 —— 此测试锁定修复行为。
    #[test]
    fn test_header_map_caller_accept_wins_and_unique() {
        let map = build_header_map(&hm(&[
            ("Accept", "text/plain"),
            ("Authorization", "Bearer t"),
        ]));
        // HeaderMap 按同名键取值只会有一个（insert 替换语义），数量为 1 即唯一
        let accepts: Vec<_> = map.get_all("accept").iter().collect();
        assert_eq!(accepts.len(), 1);
        assert_eq!(accepts[0], "text/plain");
    }

    /// build_header_map：accept 大小写不敏感识别（JS Headers 产生的是小写键）
    #[test]
    fn test_header_map_accept_case_insensitive() {
        let map = build_header_map(&hm(&[("accept", "text/html")]));
        assert_eq!(map.get("accept").unwrap(), "text/html");
    }

    /// build_header_map：调用方未携带 accept 时兜底 application/json（JSON 接口默认）
    #[test]
    fn test_header_map_accept_fallback() {
        let map = build_header_map(&hm(&[("Authorization", "Bearer t")]));
        assert_eq!(map.get("accept").unwrap(), "application/json");
    }

    /// build_header_map：host / content-length 被剥离（防伪造/与 reqwest 冲突）
    #[test]
    fn test_header_map_strips_host_and_content_length() {
        let map = build_header_map(&hm(&[
            ("Host", "api.cnb.cool"),
            ("content-length", "123"),
            ("Content-Type", "application/json"),
        ]));
        assert!(map.get("host").is_none());
        assert!(map.get("content-length").is_none());
        assert_eq!(map.get("content-type").unwrap(), "application/json");
    }

    /// build_header_map：空 headers 时仅含 Accept 兜底一条
    #[test]
    fn test_header_map_empty_input() {
        let map = build_header_map(&HashMap::new());
        assert_eq!(map.len(), 1);
        assert_eq!(map.get("accept").unwrap(), "application/json");
    }

    // -------------------------------------------------------------------------
    // cnb_download_archive 纯函数单测（T02-1 验收标准，设计文档 R6）
    // -------------------------------------------------------------------------

    /// is_allowed_api_url：伪造域必须被拒（SSRF 防护回归锁定）。
    /// - evil.com：非白名单域；
    /// - http://api.cnb.cool/：协议不对（必须 https）；
    /// - https://api.cnb.cool.evil.com/：后缀伪装域 —— 前缀匹配天然拒绝
    ///   （若误用"包含"匹配就会放行，此用例防止回归）。
    #[test]
    fn test_is_allowed_api_url_rejects_forgeries() {
        assert!(!is_allowed_api_url("https://evil.com/user"));
        assert!(!is_allowed_api_url("http://api.cnb.cool/user"));
        assert!(!is_allowed_api_url("https://api.cnb.cool.evil.com/user"));
        assert!(!is_allowed_api_url("https://api.cnb.cool"));
        assert!(!is_allowed_api_url(""));
    }

    /// is_allowed_api_url：api.cnb.cool 的 https 路径放行
    #[test]
    fn test_is_allowed_api_url_allows_api_domain() {
        assert!(is_allowed_api_url("https://api.cnb.cool/org/repo/-/git/archive/main?format=zip"));
        assert!(is_allowed_api_url(
            "https://api.cnb.cool/org/repo/-/releases/download/v1.0.0/app.zip"
        ));
    }

    /// sanitize_archive_name：路径穿越 / 分隔符 / 非白名单扩展名必须被拒。
    /// - ../x.zip：路径穿越；
    /// - a/b.zip：路径分隔符；
    /// - x.exe：可执行文件不在白名单（桌面端不自动落盘可执行文件）；
    /// - a\..\b.zip：Windows 反斜杠分隔符；
    /// - 控制字符 / 纯点 / 空串。
    #[test]
    fn test_sanitize_archive_name_rejects() {
        assert_eq!(sanitize_archive_name("../x.zip"), None);
        assert_eq!(sanitize_archive_name("a/b.zip"), None);
        assert_eq!(sanitize_archive_name("x.exe"), None);
        assert_eq!(sanitize_archive_name("a\\b.zip"), None);
        assert_eq!(sanitize_archive_name("a\0b.zip"), None);
        assert_eq!(sanitize_archive_name(".zip"), None);
        assert_eq!(sanitize_archive_name(""), None);
        assert_eq!(sanitize_archive_name("a.zip\n"), None);
        // 120 字符上限（含合法字符但超长的名字）
        let long_name = format!("{}.zip", "a".repeat(118));
        assert_eq!(sanitize_archive_name(&long_name), None);
    }

    /// sanitize_archive_name：合法名字放行，且剔除白名单外字符（宽容策略）。
    #[test]
    fn test_sanitize_archive_name_accepts() {
        assert_eq!(
            sanitize_archive_name("wocnb-v1.0.0.zip"),
            Some("wocnb-v1.0.0.zip".to_string())
        );
        assert_eq!(
            sanitize_archive_name("release_2026.tar.gz"),
            Some("release_2026.tar.gz".to_string())
        );
        assert_eq!(sanitize_archive_name("pkg-1.tgz"), Some("pkg-1.tgz".to_string()));
        // 大写扩展名视同小写
        assert_eq!(sanitize_archive_name("A.ZIP"), Some("A.ZIP".to_string()));
        // 非白名单字符（空格/中文）剔除后仍合法 → 放行
        assert_eq!(
            sanitize_archive_name("my app 源码包.zip"),
            Some("myapp.zip".to_string())
        );
    }

    /// next_available_path：目标不存在时原样返回；重名追加 " (2)" 序号，
    /// 序号插在扩展名之前（浏览器行为一致，不覆盖已有文件）。
    #[test]
    fn test_next_available_path_appends_index() {
        let dir = std::path::Path::new("/tmp/wocnb-test");
        let occupied = |p: &std::path::Path| -> bool {
            p.to_string_lossy().contains("a.zip") && !p.to_string_lossy().contains("(2)")
        };
        // a.zip 已存在 → a (2).zip；扩展名前插序号
        assert_eq!(
            next_available_path(dir, "a.zip", &occupied)
                .to_string_lossy()
                .to_string(),
            "/tmp/wocnb-test/a (2).zip"
        );
        // tar.gz 双段扩展名：序号同样插在 .tar.gz 之前
        let occupied2 = |p: &std::path::Path| -> bool {
            p.to_string_lossy().contains("b.tar.gz") && !p.to_string_lossy().contains("(2)")
        };
        assert_eq!(
            next_available_path(dir, "b.tar.gz", &occupied2)
                .to_string_lossy()
                .to_string(),
            "/tmp/wocnb-test/b (2).tar.gz"
        );
    }

    /// next_available_path：目标不存在时原样落盘（不追加序号）
    #[test]
    fn test_next_available_path_unique_target() {
        let dir = std::path::Path::new("/tmp/wocnb-test");
        // 没有任何文件被占用
        let none = |_p: &std::path::Path| false;
        assert_eq!(
            next_available_path(dir, "a.zip", &none)
                .to_string_lossy()
                .to_string(),
            "/tmp/wocnb-test/a.zip"
        );
    }

    /// next_available_path：连续重名时递增序号（(2) 也被占用 → (3)）
    #[test]
    fn test_next_available_path_sequential() {
        let dir = std::path::Path::new("/tmp/wocnb-test");
        // a.zip 与 a (2).zip 均被占用 → 取 (3)
        let occupied = |p: &std::path::Path| -> bool {
            let s = p.to_string_lossy();
            (s.contains("a.zip") && !s.contains("(3)")) || s.contains("(2)")
        };
        assert_eq!(
            next_available_path(dir, "a.zip", &occupied)
                .to_string_lossy()
                .to_string(),
            "/tmp/wocnb-test/a (3).zip"
        );
    }
}
