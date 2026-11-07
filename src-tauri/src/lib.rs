use tauri::{
    tray::{TrayIconBuilder, TrayIconEvent},
    Manager,
};

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
    if !url.starts_with("https://api.cnb.cool/") {
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
        // notification 插件：向系统通知中心发送构建结果通知（macOS 走
        // UNUserNotificationCenter）。前端经 @tauri-apps/plugin-notification
        // 调用；权限申请由前端在"用户开启开关 / 首次有通知要发"时才发起，
        // 启动阶段不弹窗打扰
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
    use super::{build_header_map, greet, is_allowed_image_url};
    use std::collections::HashMap;

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
}
