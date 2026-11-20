use tauri::{
    tray::{TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};
use tauri_plugin_notification::NotificationExt;

/// cnb-cli 集成模块：OAuth 设备授权登录 + CLI 检测/安装/令牌生命周期。
/// 设计与 CLI 行为依据见模块顶部注释（src-tauri/src/cnb_cli.rs）。
mod cnb_cli;

/// 通知 SQLite 持久化模块：构建/应用通知落盘 + 按账号隔离 + 登出可选清空。
/// 设计说明见模块顶部注释（src-tauri/src/notice_db.rs）。
mod notice_db;

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

// ---------------------------------------------------------------------------
// 托盘菜单语言（跟随前端应用语言设置）
//
// # 为什么需要 IPC 同步
//
// 托盘菜单是 Rust 侧的原生 muda 菜单，无法直接感知 WebView 里 vue-i18n
// 的语言状态。前端在语言初始化/切换时调用 set_tray_locale 命令把最终
// 生效语言（resolvedLocale，偏好为 system 时已推断成具体语言）传过来；
// Rust 侧存内存 + 持久化到 app_data_dir，下次启动读取该文件决定初始
// 文案（读不到回落 zh-CN，与历史行为一致）。
//
// # 线程约束
//
// muda Menu / NSMenu 只允许主线程操作：命令处理线程（async runtime）
// 不能直接重建菜单，必须经 `run_on_main_thread` 派回主线程执行；
// 重建即替换 TRAY_NATIVE_MENU（thread_local，主线程语义见其注释），
// 条目 id（open/quit）不变，on_menu_event 回调无需任何改动。
// ---------------------------------------------------------------------------

/// 托盘菜单语言持久化文件名（位于 app_data_dir 下）
const TRAY_LOCALE_FILE: &str = "tray-locale.txt";

/// 托盘菜单文案三语映射（纯函数，单测锁定）。
///
/// 文案与前端 trayPanel.* 命名空间同语义（检测更新/设置用词与快捷面板
/// 底部状态栏一致）；'system' 不会出现在这里（前端只传 resolvedLocale
/// 具体值），归一化兜底也回落 zh-CN（历史行为就是中文，改默认会让老
/// 用户突兀）。账号条目文案是用户名本身，不参与翻译。
#[derive(Debug, PartialEq, Eq)]
struct TrayMenuTexts {
    /// 打开应用（前置并显示主窗口）
    open: &'static str,
    /// 退出应用（app.exit(0) 真正退出）
    quit: &'static str,
    /// 登录（未登录态显示，点击打开主窗口登录页）
    login: &'static str,
    /// 退出登录（已登录态显示，点击前置主窗口并弹出退出确认弹窗）
    logout: &'static str,
    /// 个人资料（已登录态显示，跳转应用内个人资料页 /profile）
    profile: &'static str,
    /// 检测更新（打开主窗口"设置 · 关于"页）
    check_update: &'static str,
    /// 设置（打开主窗口设置页）
    settings: &'static str,
}

fn tray_menu_texts(locale: &str) -> TrayMenuTexts {
    match locale {
        // 英文文案与中文「打开应用」同义：不把产品名放进入口项，
        // 避免托盘菜单看起来像"打开某个叫 WOCNB 的东西"
        "en" => TrayMenuTexts {
            open: "Open App",
            quit: "Quit",
            login: "Sign in",
            logout: "Sign out",
            profile: "Profile",
            check_update: "Check updates",
            settings: "Settings",
        },
        "zh-TW" => TrayMenuTexts {
            open: "開啟應用",
            quit: "退出應用",
            login: "登入",
            // 繁体用词与前端 locale（zh-TW menu.logout = 登出）保持一致
            logout: "登出",
            profile: "個人資料",
            check_update: "檢測更新",
            settings: "設定",
        },
        _ => TrayMenuTexts {
            open: "打开应用",
            quit: "退出应用",
            login: "登录",
            logout: "退出登录",
            profile: "个人资料",
            check_update: "检测更新",
            settings: "设置",
        },
    }
}

/// 归一化前端传来的 locale（防脏值：未知语言一律回落 zh-CN）。
/// 接受前端三种显式值（en / zh-CN / zh-TW），大小写不敏感。
fn normalize_tray_locale(locale: &str) -> String {
    match locale.trim().to_lowercase().as_str() {
        "en" => "en".to_string(),
        "zh-tw" => "zh-TW".to_string(),
        _ => "zh-CN".to_string(),
    }
}

/// 托盘语言内存状态（进程内全局）。
///
/// 为什么用 OnceLock<Mutex<String>> 而不是 app.manage()：
/// 这里只存一个小字符串，任何线程（命令处理线程读、主线程重建菜单读）
/// 都要能安全访问，Mutex 足够；Tauri State 需要在 setup 里注册才能用，
/// 而命令可能在 setup 前被调用（理论时序），OnceLock 天然免初始化时序问题。
static TRAY_LOCALE: std::sync::OnceLock<std::sync::Mutex<String>> =
    std::sync::OnceLock::new();

/// 托盘语言槽位（懒初始化，默认 zh-CN 与文案映射的兜底一致）
fn tray_locale_slot() -> &'static std::sync::Mutex<String> {
    TRAY_LOCALE.get_or_init(|| std::sync::Mutex::new("zh-CN".to_string()))
}

/// 持久化文件完整路径（app_data_dir/tray-locale.txt；路径解析失败返回 None，
/// 调用方按"无持久化"降级 —— 只影响下次启动的初始语言，不影响本次会话）
fn tray_locale_file_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(TRAY_LOCALE_FILE))
}

/// 读取持久化的托盘语言（启动时调用；文件缺失/脏值一律回落 zh-CN）
fn read_tray_locale(app: &tauri::AppHandle) -> String {
    if let Some(path) = tray_locale_file_path(app) {
        if let Ok(raw) = std::fs::read_to_string(path) {
            return normalize_tray_locale(&raw);
        }
    }
    "zh-CN".to_string()
}

/// 持久化托盘语言（尽力而为：写失败只影响下次启动的初始文案，不阻断）
fn write_tray_locale(app: &tauri::AppHandle, locale: &str) {
    if let Some(path) = tray_locale_file_path(app) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Err(err) = std::fs::write(&path, locale) {
            log::warn!("[tray] 持久化托盘语言失败: {err}");
        }
    }
}

/// 托盘菜单登录态持久化文件名（存当前登录用户名；空文件/缺失 = 未登录）
const TRAY_AUTH_FILE: &str = "tray-auth.txt";

/// 托盘登录态内存槽位（进程内全局，"" = 未登录）。
///
/// 线程模型与 tray_locale_slot 一致：命令处理线程写、主线程重建菜单读，
/// Mutex 字符串足够；OnceLock 免初始化时序问题。
/// 只存用户名（展示用途，非敏感凭据——令牌仍只在系统钥匙串/localStorage）。
static TRAY_AUTH: std::sync::OnceLock<std::sync::Mutex<String>> = std::sync::OnceLock::new();

fn tray_auth_slot() -> &'static std::sync::Mutex<String> {
    TRAY_AUTH.get_or_init(|| std::sync::Mutex::new(String::new()))
}

/// 登录态持久化文件完整路径（解析失败返回 None，按"无持久化"降级）
fn tray_auth_file_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(TRAY_AUTH_FILE))
}

/// 读取持久化的登录用户名（启动时调用；缺失/空白回落空串 = 未登录）
fn read_tray_auth(app: &tauri::AppHandle) -> String {
    if let Some(path) = tray_auth_file_path(app) {
        if let Ok(raw) = std::fs::read_to_string(path) {
            let name = raw.trim().to_string();
            if !name.is_empty() {
                return name;
            }
        }
    }
    String::new()
}

/// 持久化登录态（尽力而为：写失败只影响下次启动的初始条目，不阻断）
fn write_tray_auth(app: &tauri::AppHandle, username: &str) {
    if let Some(path) = tray_auth_file_path(app) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Err(err) = std::fs::write(&path, username) {
            log::warn!("[tray] 持久化托盘登录态失败: {err}");
        }
    }
}

/// 按 locale 与登录态构建托盘原生菜单（macOS 专属）。
///
/// 结构（登录/未登录只影响账号区分组条目，其余条目恒定）：
/// ```text
/// 打开应用
/// ─────────      ← 用户相关条目单独分组
/// 登录            ← 未登录：点击打开主窗口登录页
/// 用户名（禁态）    ← 已登录：只展示不响应点击
/// 个人资料         ← 已登录：跳转应用内个人资料页（/profile）
/// 退出登录         ← 已登录：前置主窗口 + 弹出退出确认弹窗（可勾选清空数据）
/// ─────────
/// 设置
/// 检测更新
/// ─────────
/// 退出应用
/// ```
///
/// 条目 id 固定（open/settings/check-update/login/account/profile/logout/
/// quit）：事件分发（on_menu_event）按 id 匹配，语言切换/登录态切换只换
/// 文案与结构、不换已有 id，回调逻辑零改动。
#[cfg(target_os = "macos")]
fn build_tray_menu(locale: &str, username: &str) -> muda::Menu {
    use muda::{Menu, MenuId, MenuItem, PredefinedMenuItem};
    let texts = tray_menu_texts(locale);
    let tray_menu = Menu::new();

    // —— 常用动作 ——
    // 打开应用（最高频入口置顶）
    let open_item = MenuItem::builder()
        .id(MenuId::new("open"))
        .text(texts.open)
        .enabled(true)
        .build();
    let _ = tray_menu.append(&open_item);

    // —— 用户相关分组（登录/账号展示/个人资料/退出登录）——
    let _ = tray_menu.append(&PredefinedMenuItem::separator());
    if username.is_empty() {
        let login_item = MenuItem::builder()
            .id(MenuId::new("login"))
            .text(texts.login)
            .enabled(true)
            .build();
        let _ = tray_menu.append(&login_item);
    } else {
        // 禁态条目：仅展示当前账号，点击无事件（原生菜单惯例，
        // 如微信/钉钉托盘菜单的账号展示）
        let account_item = MenuItem::builder()
            .id(MenuId::new("account"))
            .text(username)
            .enabled(false)
            .build();
        let _ = tray_menu.append(&account_item);
        // 个人资料：跳转应用内个人资料页（/profile）。走与 login/settings
        // 相同的 cnb://panel-navigate 下钻通道，复用主窗口既有监听
        let profile_item = MenuItem::builder()
            .id(MenuId::new("profile"))
            .text(texts.profile)
            .enabled(true)
            .build();
        let _ = tray_menu.append(&profile_item);
        // 退出登录：动作条目（区别于上面的展示条目）。实际登出逻辑在
        // 前端（含可选清空通知数据/CLI 登出），Rust 只负责前置主窗口
        // 并 emit cnb://tray-logout 事件，由 main.ts 打开确认弹窗
        let logout_item = MenuItem::builder()
            .id(MenuId::new("logout"))
            .text(texts.logout)
            .enabled(true)
            .build();
        let _ = tray_menu.append(&logout_item);
    }

    // —— 次级功能区：设置、检测更新（紧挨退出应用上方）——
    let _ = tray_menu.append(&PredefinedMenuItem::separator());
    let settings_item = MenuItem::builder()
        .id(MenuId::new("settings"))
        .text(texts.settings)
        .enabled(true)
        .build();
    let _ = tray_menu.append(&settings_item);
    // 检测更新：打开"设置 · 关于"页（与设置相邻符合直觉）
    let check_item = MenuItem::builder()
        .id(MenuId::new("check-update"))
        .text(texts.check_update)
        .enabled(true)
        .build();
    let _ = tray_menu.append(&check_item);

    let _ = tray_menu.append(&PredefinedMenuItem::separator());

    // 退出应用
    let quit_item = MenuItem::builder()
        .id(MenuId::new("quit"))
        .text(texts.quit)
        .enabled(true)
        .build();
    let _ = tray_menu.append(&quit_item);
    tray_menu
}

/// 主线程重建托盘菜单（替换 TRAY_NATIVE_MENU，旧菜单随之释放）。
///
/// 无参设计：语言与登录态分别读各自的全局槽位——两条同步链路
/// （set_tray_locale / set_tray_auth）都可能触发重建，重建时必须
/// 取两者当前值组合，避免"改了语言丢了登录态"或反之。
/// 必须在主线程调用（muda/NSMenu 线程约束，调用方保证）。
#[cfg(target_os = "macos")]
fn rebuild_tray_menu() {
    let locale = tray_locale_slot()
        .lock()
        .map(|g| g.clone())
        .unwrap_or_default();
    let username = tray_auth_slot()
        .lock()
        .map(|g| g.clone())
        .unwrap_or_default();
    let menu = build_tray_menu(&locale, &username);
    TRAY_NATIVE_MENU.with(|slot| *slot.borrow_mut() = Some(menu));
}

// ---------------------------------------------------------------------------
// macOS 应用菜单栏（屏幕顶部 menu bar）多语言
// ---------------------------------------------------------------------------

/// 应用菜单栏可翻译文案集合（纯数据，单测锁定三语齐全）。
///
/// 自定义条目（about/quit/子菜单标题）与**系统预定义条目**全部收录。
/// 预定义条目（PredefinedMenuItem）不传 text 时由 macOS 按系统语言渲染——
/// 当系统语言与应用语言不一致时，菜单栏会出现"关于 WOCNB（中文）+
/// Undo/Cut（英文）"的混搭，观感上就是"菜单没有多语言"；因此所有
/// 预定义条目都显式传应用语言文案（快捷键、行为仍由系统按预定义条目
/// 自动挂载，只换标签不换功能）。
#[derive(Debug, PartialEq, Eq)]
struct AppMenuTexts {
    /// 应用菜单里"关于 WOCNB"条目
    about: &'static str,
    /// 应用菜单里"退出 WOCNB"条目（⌘Q，行为 = 托盘"退出应用"）
    quit: &'static str,
    /// "编辑"子菜单标题
    edit: &'static str,
    /// "窗口"子菜单标题
    window: &'static str,
    /// 预定义条目：撤销 / 重做
    undo: &'static str,
    redo: &'static str,
    /// 预定义条目：剪切 / 拷贝 / 粘贴 / 全选
    cut: &'static str,
    copy: &'static str,
    paste: &'static str,
    select_all: &'static str,
    /// 预定义条目：最小化 / 关闭窗口（窗口子菜单）
    minimize: &'static str,
    close_window: &'static str,
    /// 预定义条目：隐藏 WOCNB / 隐藏其他（应用子菜单）
    hide: &'static str,
    hide_others: &'static str,
}

/// 应用菜单栏文案三语映射（纯函数，单测锁定）。
///
/// 语言口径与 tray_menu_texts 完全一致（en / zh-TW / 其余回落 zh-CN），
/// 两者共用 set_tray_locale 的同一份归一化结果，切语言时同步重建。
/// 各语言的条目用词对齐 macOS 系统简体/繁体本地化惯例（如繁体用
/// 「復原/剪下/貼上/縮小」而非简体直译）。
fn app_menu_texts(locale: &str) -> AppMenuTexts {
    match locale {
        "en" => AppMenuTexts {
            about: "About WOCNB",
            quit: "Quit WOCNB",
            edit: "Edit",
            window: "Window",
            undo: "Undo",
            redo: "Redo",
            cut: "Cut",
            copy: "Copy",
            paste: "Paste",
            select_all: "Select All",
            minimize: "Minimize",
            close_window: "Close Window",
            hide: "Hide WOCNB",
            hide_others: "Hide Others",
        },
        "zh-TW" => AppMenuTexts {
            about: "關於 WOCNB",
            quit: "退出 WOCNB",
            edit: "編輯",
            window: "視窗",
            undo: "復原",
            redo: "重做",
            cut: "剪下",
            copy: "拷貝",
            paste: "貼上",
            select_all: "全選",
            minimize: "縮小",
            close_window: "關閉視窗",
            hide: "隱藏 WOCNB",
            hide_others: "隱藏其他",
        },
        _ => AppMenuTexts {
            about: "关于 WOCNB",
            quit: "退出 WOCNB",
            edit: "编辑",
            window: "窗口",
            undo: "撤销",
            redo: "重做",
            cut: "剪切",
            copy: "拷贝",
            paste: "粘贴",
            select_all: "全选",
            minimize: "最小化",
            close_window: "关闭窗口",
            hide: "隐藏 WOCNB",
            hide_others: "隐藏其他",
        },
    }
}

/// 菜单条目 id：应用菜单"关于"（点击后 emit 事件给前端跳转关于页）
const APP_MENU_ABOUT_ID: &str = "app-about";
/// 菜单条目 id：应用菜单"退出"（点击后 app.exit(0)，与托盘退出一致）
const APP_MENU_QUIT_ID: &str = "app-quit";

/// 按 locale 构建 macOS 应用菜单栏（顶部 menu bar）。
///
/// 结构（自定义条目与系统预定义条目**全部**使用应用语言文案；预定义
/// 条目只换标签，快捷键与行为仍由系统自动挂载）：
///   [WOCNB]  关于 WOCNB ／ ─ ／ 隐藏 WOCNB ／ 隐藏其他 ／ ─ ／ 退出 WOCNB ⌘Q
///   [编辑]   撤销/重做/─/剪切/拷贝/粘贴/全选（预定义，自动带快捷键）
///   [窗口]   最小化/─/关闭窗口（预定义）
///
/// 必须在主线程调用（NSMenu 线程约束，同托盘菜单）。
#[cfg(target_os = "macos")]
fn build_app_menu(
    app: &tauri::AppHandle,
    locale: &str,
) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};

    let texts = app_menu_texts(locale);

    // —— 应用子菜单 ——
    // "关于"用自定义条目而非 PredefinedMenuItem::about：系统 about 面板
    // 的语言/内容不可控，且我们希望点击直达应用内"设置 · 关于"页
    //（含检查更新入口），比原生面板更有用
    let about_item = MenuItem::with_id(app, APP_MENU_ABOUT_ID, texts.about, true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, APP_MENU_QUIT_ID, texts.quit, true, Some("Cmd+Q"))?;
    let app_submenu = Submenu::with_items(
        app,
        "WOCNB",
        true,
        &[
            &about_item,
            &PredefinedMenuItem::separator(app)?,
            // 隐藏/隐藏其他：系统行为（NSApp hide），文案显式传应用语言
            //（不传 None——None 会按系统语言渲染，系统语言与应用语言
            // 不一致时菜单栏混搭两种语言）
            &PredefinedMenuItem::hide(app, Some(texts.hide))?,
            &PredefinedMenuItem::hide_others(app, Some(texts.hide_others))?,
            &PredefinedMenuItem::separator(app)?,
            &quit_item,
        ],
    )?;

    // —— 编辑子菜单：全部系统预定义项，快捷键由系统自动挂载；
    // 文案显式传应用语言（同上，避免跟随系统语言的混搭）——
    let edit_submenu = Submenu::with_items(
        app,
        texts.edit,
        true,
        &[
            &PredefinedMenuItem::undo(app, Some(texts.undo))?,
            &PredefinedMenuItem::redo(app, Some(texts.redo))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some(texts.cut))?,
            &PredefinedMenuItem::copy(app, Some(texts.copy))?,
            &PredefinedMenuItem::paste(app, Some(texts.paste))?,
            &PredefinedMenuItem::select_all(app, Some(texts.select_all))?,
        ],
    )?;

    // —— 窗口子菜单：预定义条目 + 应用语言文案 ——
    let window_submenu = Submenu::with_items(
        app,
        texts.window,
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some(texts.minimize))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, Some(texts.close_window))?,
        ],
    )?;

    Menu::with_items(app, &[&app_submenu, &edit_submenu, &window_submenu])
}

/// 应用菜单条目点击的统一处理（setup 里注册一次，id 与语言无关）。
///
/// - app-quit：与托盘"退出应用"同路径 app.exit(0)（不走 CloseRequested，
///   关窗即隐藏的行为不会拦截真正退出）；
/// - app-about：emit 事件给前端，由前端路由跳转"设置 · 关于"页 ——
///   菜单事件在主线程，不持有 webview 路由，必须经 IPC 转交。
#[cfg(target_os = "macos")]
fn handle_app_menu_event(app: &tauri::AppHandle, id: &str) {
    match id {
        APP_MENU_QUIT_ID => app.exit(0),
        APP_MENU_ABOUT_ID => {
            let _ = app.emit("cnb://menu-about", ());
        }
        _ => {}
    }
}

/// 前端语言切换时同步托盘菜单语言（useAppLocale → 本命令）。
///
/// 处理流程：归一 → 写内存 → 持久化 → 主线程重建菜单（macOS）。
/// 任一步失败都不让前端侧报错弹窗（托盘文案是低价值 UI，静默降级）；
/// 但归一/锁失败仍返回 Err 便于 dev 排查。
#[tauri::command]
fn set_tray_locale(app: tauri::AppHandle, locale: String) -> Result<(), String> {
    let locale = normalize_tray_locale(&locale);
    // 写内存状态：下次菜单重建（含本命令触发的这次）都用它
    {
        let slot = tray_locale_slot();
        let mut guard = slot.lock().map_err(|e| e.to_string())?;
        *guard = locale.clone();
    }
    // 持久化：失败不阻断（下次启动回落默认文案）
    write_tray_locale(&app, &locale);
    // macOS：菜单重建必须回主线程（muda/NSMenu 线程约束，见模块注释）。
    // 同步重建两处菜单：托盘右键菜单 + 顶部应用菜单栏（menu bar）——
    // 两者共用同一份归一化语言，切语言必须一起换，否则会出现"托盘中文、
    // 菜单栏英文"的撕裂。
    #[cfg(target_os = "macos")]
    {
        let loc = locale.clone();
        let app_handle = app.clone();
        app.run_on_main_thread(move || {
            // 托盘菜单重建（无参：语言+登录态都从全局槽位取，见函数注释）
            rebuild_tray_menu();
            // 应用菜单栏重建：set_menu 会替换现有菜单；失败（极端场景，
            // 如菜单条目构建出错）静默降级保留旧语言菜单，不打断切换流程
            if let Ok(menu) = build_app_menu(&app_handle, &loc) {
                if let Err(err) = app_handle.set_menu(menu) {
                    log::warn!("[tray] 重建应用菜单栏失败: {err}");
                }
            }
        })
        .map_err(|e| format!("run_on_main_thread failed: {e}"))?;
    }
    Ok(())
}

/// 前端登录态变化时同步托盘菜单（main.ts watch 登录态 → 本命令）。
///
/// 约定：username 空串 = 未登录（菜单显示"登录"条目）；非空 = 已登录
/// （菜单显示禁态用户名）。处理流程与 set_tray_locale 同构：
/// 写内存 → 持久化 → 主线程重建托盘菜单（应用菜单栏不含账号信息，无需重建）。
///
/// 为什么持久化用户名：应用启动时前端恢复会话（restoreSession，含网络
/// 请求）完成前用户名未知，持久化值能让启动初期的托盘菜单就显示正确的
/// 登录态条目；会话恢复完成后前端会再同步一次覆盖为本会话真值。
#[tauri::command]
fn set_tray_auth(app: tauri::AppHandle, username: String) -> Result<(), String> {
    // 归一：去首尾空白；纯空白视为未登录（防脏值）
    let username = username.trim().to_string();
    {
        let slot = tray_auth_slot();
        let mut guard = slot.lock().map_err(|e| e.to_string())?;
        *guard = username.clone();
    }
    write_tray_auth(&app, &username);
    // macOS：菜单重建必须回主线程（muda/NSMenu 线程约束，同 set_tray_locale）
    #[cfg(target_os = "macos")]
    {
        app.run_on_main_thread(rebuild_tray_menu)
            .map_err(|e| format!("run_on_main_thread failed: {e}"))?;
    }
    Ok(())
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

// ---------------------------------------------------------------------------
// 窗口尺寸记忆（统一用逻辑像素）
//
// # 为什么尺寸不交给 tauri-plugin-window-state
//
// 该插件按 **物理像素** 落盘，启动时又原样 set_size 回去。实测（2026-11-19）：
// 用户在外接屏（scale=1，窗口 x=1512）把窗口调到 1213×720，盘里存的就是
// 1213×720 physical；换到内置 Retina 屏（scale=2）启动，同样 1213×720
// physical 只剩 **606×360 逻辑点** —— 窗口"只有一小块"，与用户截图
// （607×360）完全吻合。更糟的是 set_size 是程序化调用，不受
// tauri.conf.json 的 minWidth/minHeight 约束，1024×600 的最小值兜不住它。
//
// 因此尺寸改由本模块自己管：存/取一律逻辑像素，恢复时再夹到
// [最小尺寸, 当前屏幕尺寸] 区间。插件继续负责位置/最大化/可见性/装饰/
// 全屏（这些量与缩放无关，且插件本身有"屏幕相交"判断），只摘掉 SIZE 位。
// ---------------------------------------------------------------------------

/// 尺寸持久化文件名（位于 app_data_dir 下，与插件的 .window-state.json 分开）
const WINDOW_SIZE_FILE: &str = "window-size.txt";

/// 最小窗口尺寸（逻辑像素）。必须与 tauri.conf.json 的 minWidth/minHeight
/// 一致（默认尺寸也取这两个值，用户要求"默认打开就是最小尺寸"），
/// 单测 test_window_size_constants_match_config 锁定两者不许漂移。
const MIN_WINDOW_WIDTH: f64 = 1024.0;
const MIN_WINDOW_HEIGHT: f64 = 600.0;

/// 最近一次"非最大化、非全屏"的逻辑尺寸（进程内缓存）。
///
/// 为什么不每次 Resized 都写盘：拖拽窗口会连续触发几十次事件，逐次落盘
/// 既慢又无意义；这里只更新内存，关窗/退出时写一次即可。
static LAST_WINDOW_SIZE: std::sync::OnceLock<std::sync::Mutex<Option<(f64, f64)>>> =
    std::sync::OnceLock::new();

/// 尺寸缓存槽位（懒初始化；首次为 None，表示"本进程还没记到尺寸"）
fn last_window_size_slot() -> &'static std::sync::Mutex<Option<(f64, f64)>> {
    LAST_WINDOW_SIZE.get_or_init(|| std::sync::Mutex::new(None))
}

/// 持久化文件完整路径（app_data_dir/window-size.txt；解析失败返回 None，
/// 调用方按"无持久化"降级，只影响下次启动的初始尺寸）
fn window_size_file_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(WINDOW_SIZE_FILE))
}

/// 解析持久化的尺寸文本（格式 "1024x600"）。
///
/// 容错要点：允许首尾空白与浮点（不同平台/未来版本可能写成 1024.0），
/// 非有限值、非正数、缺分隔符一律返回 None —— 坏文件按"首次启动"处理，
/// 绝不把 NaN/0 传给 set_size（那会让窗口尺寸变成不可预期值）。
fn parse_window_size(text: &str) -> Option<(f64, f64)> {
    let (w, h) = text.trim().split_once('x')?;
    let w: f64 = w.trim().parse().ok()?;
    let h: f64 = h.trim().parse().ok()?;
    if !w.is_finite() || !h.is_finite() || w <= 0.0 || h <= 0.0 {
        return None;
    }
    Some((w, h))
}

/// 把期望尺寸夹到 [最小尺寸, 屏幕尺寸] 区间（纯函数，单测覆盖）。
///
/// - `saved = None`（首次启动 / 文件损坏）→ 用最小尺寸，即配置里的默认值
/// - 屏幕比最小尺寸还小（极端缩放/小副屏）→ 只保下限，不夹上限，
///   避免把窗口压到比最小值还小
fn clamp_window_size(saved: Option<(f64, f64)>, screen: Option<(f64, f64)>) -> (f64, f64) {
    let (mut w, mut h) = saved.unwrap_or((MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT));
    w = w.max(MIN_WINDOW_WIDTH);
    h = h.max(MIN_WINDOW_HEIGHT);
    if let Some((sw, sh)) = screen {
        // 只在屏幕确实放得下最小尺寸时才夹上限（否则等于把窗口压死）
        if sw >= MIN_WINDOW_WIDTH {
            w = w.min(sw);
        }
        if sh >= MIN_WINDOW_HEIGHT {
            h = h.min(sh);
        }
    }
    (w.round(), h.round())
}

/// 读取当前窗口的内尺寸并换算成逻辑像素。
///
/// 必须逐次取 scale_factor：同一窗口拖到不同缩放的屏幕上，物理尺寸会变、
/// 逻辑尺寸不变，用旧的缩放系数换算就会得到错误的逻辑值。
fn current_logical_size(window: &tauri::WebviewWindow) -> Option<(f64, f64)> {
    let scale = window.scale_factor().ok()?;
    if scale <= 0.0 {
        return None;
    }
    let logical = window.inner_size().ok()?.to_logical::<f64>(scale);
    Some((logical.width, logical.height))
}

/// 记录窗口当前尺寸到内存缓存（Resized 事件触发）。
///
/// 最大化/全屏时跳过：那时的 inner_size 是屏幕尺寸，用户下次希望恢复的是
/// "常态尺寸"，把屏幕尺寸当成常态尺寸存下来会让窗口永远铺满。
/// 小于最小尺寸时也跳过（最小化过程中可能出现异常小的中间值）。
fn remember_window_size(window: &tauri::WebviewWindow) {
    if window.is_maximized().unwrap_or(false) || window.is_fullscreen().unwrap_or(false) {
        return;
    }
    if let Some((w, h)) = current_logical_size(window) {
        if w >= MIN_WINDOW_WIDTH && h >= MIN_WINDOW_HEIGHT {
            if let Ok(mut slot) = last_window_size_slot().lock() {
                *slot = Some((w.round(), h.round()));
            }
        }
    }
}

/// 启动时恢复上次关闭的尺寸（逻辑像素）。
///
/// 调用时机：setup 里、事件循环启动前（配置窗口此时已创建但尚未显示），
/// 因此不会出现"先小后大"的闪跳。恢复动作是程序化 set_size，必须自己
/// 保证不低于最小尺寸（不依赖系统约束，见文件头注释的踩坑记录）。
fn restore_window_size(window: &tauri::WebviewWindow) {
    let app = window.app_handle();
    let saved = window_size_file_path(app)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| parse_window_size(&text));
    let screen = window.current_monitor().ok().flatten().map(|monitor| {
        let size = monitor.size().to_logical::<f64>(monitor.scale_factor());
        (size.width, size.height)
    });
    let (w, h) = clamp_window_size(saved, screen);
    if let Err(err) = window.set_size(tauri::LogicalSize::new(w, h)) {
        log::warn!("[window] 恢复窗口尺寸失败（保持配置默认值）: {err}");
    }
    if let Ok(mut slot) = last_window_size_slot().lock() {
        *slot = Some((w, h));
    }
}

/// 把缓存的尺寸写盘（关窗 / 退出时调用）。
///
/// 尽力而为：写失败只影响下次启动的初始尺寸，记日志即可，绝不阻断退出。
/// 缓存为空（本次会话没触发过 Resized）时不写，避免用 0 覆盖掉好数据。
fn persist_window_size(app: &tauri::AppHandle) {
    let cached = last_window_size_slot().lock().ok().and_then(|slot| *slot);
    let Some((w, h)) = cached else { return };
    let Some(path) = window_size_file_path(app) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let body = format!("{}x{}", w.round() as i64, h.round() as i64);
    if let Err(err) = std::fs::write(&path, body) {
        log::warn!("[window] 持久化窗口尺寸失败: {err}");
    }
}

/// 显示并聚焦主窗口（托盘左键单击或菜单"打开应用"时调用）。
/// 若窗口此前被隐藏（点关闭按钮）或最小化，show 会将其恢复到前台。
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

// ---------------------------------------------------------------------------
// 托盘左键快捷面板（tray-panel 窗口）：显示活跃项目 + 底部状态栏
// ---------------------------------------------------------------------------

/// 托盘面板窗口的 label（与 tauri.conf.json 的 windows 数组对应）。
const TRAY_PANEL_LABEL: &str = "tray-panel";

/// 左键切换面板的防抖窗口（毫秒）：macOS 上快速连点两次会派发两个
/// Down 事件，无防抖时表现为面板"闪现即消失"（开→关）。
const TRAY_PANEL_TOGGLE_DEBOUNCE_MS: u128 = 300;

/// 上一次左键切换面板的时刻（防抖状态）。
/// OnceLock<Mutex<Option<Instant>>>：首次访问惰性初始化；托盘事件回调
/// 在主线程，但 Mutex 保证了万一跨线程也无数据竞争。
static TRAY_PANEL_LAST_TOGGLE: std::sync::OnceLock<
    std::sync::Mutex<Option<std::time::Instant>>,
> = std::sync::OnceLock::new();

/// 上一次「面板因失焦被自动隐藏」的时刻。
///
/// 解决"点托盘图标关不掉面板"的交互悖论：面板可见时点击托盘图标，
/// macOS 先派发失焦（Focused(false) → 隐藏），紧接着才是托盘 Click
/// 事件 —— 此时 is_visible 已是 false，切换逻辑会把它重新打开，用户
/// 看到的是"闪一下又出来"。因此记录失焦隐藏时刻，短时间内（250ms）
/// 的托盘点击视为"用户想关面板"，直接忽略这次 show。
static TRAY_PANEL_LAST_BLUR_HIDE: std::sync::OnceLock<
    std::sync::Mutex<Option<std::time::Instant>>,
> = std::sync::OnceLock::new();

/// 失焦隐藏的判定窗口（毫秒）：太短会漏判（事件到达顺序抖动），
/// 太长会把"刚切走再点开"的正常操作也吞掉。
const TRAY_PANEL_BLUR_HIDE_WINDOW_MS: u128 = 250;

/// 记录一次失焦自动隐藏（由窗口事件 Focused(false) 分支调用）。
fn note_tray_panel_blur_hide() {
    if let Ok(mut guard) = TRAY_PANEL_LAST_BLUR_HIDE
        .get_or_init(|| std::sync::Mutex::new(None))
        .lock()
    {
        *guard = Some(std::time::Instant::now());
    }
}

/// 面板是否刚刚因失焦被隐藏（250ms 内）。
fn tray_panel_just_blur_hidden() -> bool {
    let Ok(guard) = TRAY_PANEL_LAST_BLUR_HIDE
        .get_or_init(|| std::sync::Mutex::new(None))
        .lock()
    else {
        return false;
    };
    guard
        .map(|t| t.elapsed().as_millis() < TRAY_PANEL_BLUR_HIDE_WINDOW_MS)
        .unwrap_or(false)
}

/// 防抖判定 + 记录本次触发时刻。返回 true 表示本次点击应被忽略
/// （距上次切换不足 TRAY_PANEL_TOGGLE_DEBOUNCE_MS）。
fn tray_panel_toggle_debounced() -> bool {    let now = std::time::Instant::now();
    let slot = TRAY_PANEL_LAST_TOGGLE
        .get_or_init(|| std::sync::Mutex::new(None))
        .lock();
    let Ok(mut guard) = slot else {
        // Mutex 中毒（极端情况）不应让托盘点击失效：放行本次点击
        return false;
    };
    let skip = guard
        .map(|t| now.duration_since(t).as_millis() < TRAY_PANEL_TOGGLE_DEBOUNCE_MS)
        .unwrap_or(false);
    if !skip {
        *guard = Some(now);
    }
    skip
}

/// 在托盘图标正下方定位面板窗口（物理坐标直算，不做缩放换算）。
///
/// 坐标口径：TrayIconEvent 的 position/rect 均为**物理像素**（主屏左上
/// 原点，y 向下）；窗口 set_position/outer_size 也吃物理坐标，全程同一
/// 口径最不易错。水平方向让面板中心对齐图标中心，垂直方向贴图标底边
/// 留 6px 间距；最后夹取到光标所在显示器范围内（防面板一半飘出屏幕）。
fn position_tray_panel(
    app: &tauri::AppHandle,
    panel: &tauri::WebviewWindow,
    cursor_x: f64,
    cursor_y: f64,
    icon_x: f64,
    icon_y: f64,
    icon_w: f64,
    icon_h: f64,
) {
    // 面板自身物理尺寸（配置 360x440 逻辑单位 × 该屏缩放系数）
    let panel_size = panel.outer_size().unwrap_or(tauri::PhysicalSize::new(360, 440));
    let panel_w = panel_size.width as f64;
    let panel_h = panel_size.height as f64;

    let mut px = icon_x + icon_w / 2.0 - panel_w / 2.0;
    let mut py = icon_y + icon_h + 6.0;

    // 夹取到光标所在显示器（monitor_from_point 吃物理坐标）：
    // 状态栏图标可能贴着屏幕边缘，不夹取面板会飘出可视区域
    if let Ok(Some(monitor)) = app.monitor_from_point(cursor_x, cursor_y) {
        let m = monitor.position();
        let ms = monitor.size();
        let m_x = m.x as f64;
        let m_y = m.y as f64;
        let m_w = ms.width as f64;
        let m_h = ms.height as f64;
        if m_w > panel_w + 16.0 {
            px = px.clamp(m_x + 8.0, m_x + m_w - panel_w - 8.0);
        }
        if m_h > panel_h + 16.0 {
            py = py.clamp(m_y + 8.0, m_y + m_h - panel_h - 8.0);
        }
    }

    let _ = panel.set_position(tauri::PhysicalPosition::new(px.round() as i32, py.round() as i32));
}

/// 把 TrayIconEvent.rect 的 Position/Size 归一为物理像素 (x, y, w, h)。
///
/// tray-icon 在 macOS 上报的是逻辑坐标经 to_physical 的物理值，但 Tauri
/// 包装成 `tauri::Position`/`tauri::Size` 枚举（物理/逻辑两态），直接取
/// 字段不存在 —— 必须按枚举分支换算。scale 取托盘图标所在屏的缩放系数
/// （调用方已用光标点推断）；仅逻辑态分支真正用到它。
fn tray_rect_physical(scale: f64, pos: tauri::Position, size: tauri::Size) -> (f64, f64, f64, f64) {
    let (x, y) = match pos {
        tauri::Position::Physical(p) => (p.x as f64, p.y as f64),
        tauri::Position::Logical(l) => (l.x * scale, l.y * scale),
    };
    let (w, h) = match size {
        tauri::Size::Physical(s) => (s.width as f64, s.height as f64),
        tauri::Size::Logical(s) => (s.width * scale, s.height * scale),
    };
    (x, y, w, h)
}

/// 托盘左键单击：切换（显示/隐藏）活跃项目快捷面板。
/// 已显示 → 隐藏；隐藏 → 按"托盘图标正下方"重新定位后显示并聚焦。
fn toggle_tray_panel(
    app: &tauri::AppHandle,
    cursor_x: f64,
    cursor_y: f64,
    icon_x: f64,
    icon_y: f64,
    icon_w: f64,
    icon_h: f64,
) {
    let Some(panel) = app.get_webview_window(TRAY_PANEL_LABEL) else {
        // 配置缺窗口（理论上不会发生）：降级回旧行为——直接开主窗口
        log::warn!("[tray-panel] 窗口不存在，降级为主窗口");
        show_main_window(app);
        return;
    };
    // is_visible 失败按"不可见"处理（走显示分支）
    if panel.is_visible().unwrap_or(false) {
        let _ = panel.hide();
        return;
    }
    // 刚刚因失焦被隐藏（同一操作的"先失焦后点击"事件序）：
    // 本次点击意图是关闭面板，不再重新弹出
    if tray_panel_just_blur_hidden() {
        return;
    }
    position_tray_panel(app, &panel, cursor_x, cursor_y, icon_x, icon_y, icon_w, icon_h);
    let _ = panel.show();
    let _ = panel.set_focus();
    // 通知面板页刷新数据（最近项目列表在主窗口里更新，面板是独立
    // WebView 且长期隐藏，仅靠 window focus 事件在部分 WebView 上
    // 不一定触发；这里显式发一次，面板页收到即重新读盘）
    let _ = app.emit_to(TRAY_PANEL_LABEL, "cnb://tray-panel-shown", ());
}

/// 隐藏托盘面板（面板页 Esc 键 / 失焦由窗口事件自动处理）。
#[tauri::command]
fn hide_tray_panel(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(panel) = app.get_webview_window(TRAY_PANEL_LABEL) {
        let _ = panel.hide();
    }
    Ok(())
}

/// 面板内"点击项目 / 发现新版本去查看"：隐藏面板 → 前置主窗口 →
/// emit 导航事件（主窗口 main.ts 监听 cnb://panel-navigate 后 router.push）。
/// path 为完整路由字符串（含 query，如 /repos/a%2Fb?tab=builds&sn=xxx）。
#[tauri::command]
fn tray_panel_open_target(app: tauri::AppHandle, path: String) -> Result<(), String> {
    if let Some(panel) = app.get_webview_window(TRAY_PANEL_LABEL) {
        let _ = panel.hide();
    }
    show_main_window(&app);
    // 只发给主窗口（面板窗口不注册该监听，但精准投递更稳）
    app.emit_to("main", "cnb://panel-navigate", &path)
        .map_err(|e| format!("emit panel-navigate failed: {e}"))
}

/// 应用入口：构建 Tauri Builder 并启动事件循环。
/// - 注册 greet 命令供前端 invoke
/// - 初始化系统托盘（W 图标、左键打开应用、右键弹菜单）
/// - 拦截主窗口关闭事件：隐藏而非退出，应用常驻托盘
/// - 仅在 debug 构建下挂载日志插件（release 下关闭，避免额外开销）
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            greet,
            cnb_http_request,
            cnb_fetch_image,
            // —— 二进制下载通道（源码包 / Release 附件，设计文档 D2）——
            cnb_download_archive,
            // —— 托盘菜单语言（跟随前端应用语言设置，见托盘 locale 模块注释）——
            set_tray_locale,
            // —— 托盘菜单登录态（登录/未登录渲染不同条目）——
            set_tray_auth,
            // —— 托盘左键快捷面板（活跃项目 + 检测更新 + 退出）——
            hide_tray_panel,
            tray_panel_open_target,
            // —— cnb-cli 集成（OAuth 设备授权登录）——
            cnb_cli::cnb_cli_detect,
            cnb_cli::cnb_cli_install,
            cnb_cli::cnb_cli_login,
            cnb_cli::cnb_cli_login_poll,
            cnb_cli::cnb_cli_cancel_login,
            cnb_cli::cnb_cli_read_token,
            cnb_cli::cnb_cli_refresh_token,
            cnb_cli::cnb_cli_logout,
            // —— 通知 SQLite 持久化（按账号隔离，登出默认保留数据）——
            notice_db::notice_db_load,
            notice_db::notice_db_insert_build,
            notice_db::notice_db_insert_app,
            notice_db::notice_db_mark_all_read,
            notice_db::notice_db_clear,
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
        // updater 插件：应用内热更新。配置（清单端点 + 签名公钥）在
        // tauri.conf.json 的 plugins.updater；更新包由 CI 打包时用私钥
        // 签名（TAURI_SIGNING_PRIVATE_KEY，经 CNB 密钥仓库注入），运行时
        // 用内置公钥验签后才安装。前端经 @tauri-apps/plugin-updater 调用
        // check / downloadAndInstall；Windows 端清单缺平台条目时 check
        // 会失败，前端降级为"前往 Releases 手动下载"
        .plugin(tauri_plugin_updater::Builder::new().build())
        // process 插件：更新安装完成后 relaunch 重启应用（与 updater 配套）
        .plugin(tauri_plugin_process::init())
        // window-state 插件：记住窗口位置 / 最大化 / 可见性 / 装饰 / 全屏
        // （落盘到 ~/Library/Application Support/<app>/.window-state.json）。
        //
        // ⚠️ 这里刻意摘掉 StateFlags::SIZE：该插件按**物理像素**存尺寸，
        // 换到不同缩放的屏幕（外接 1x 屏 → 内置 Retina 2x）启动会缩成一半
        // （实测 1213×720 physical 在 2x 屏上只有 606×360 逻辑点），而且
        // set_size 不受 minWidth/minHeight 约束 —— 于是"应用打开只有一小块"。
        // 尺寸改由本文件「窗口尺寸记忆」模块用逻辑像素自管（restore_window_size
        // / persist_window_size），插件只承担与缩放无关的那部分状态。
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        & !tauri_plugin_window_state::StateFlags::SIZE,
                )
                .build(),
        )
        // 全局菜单事件：托盘右键菜单（原生 muda 菜单）的条目点击会经
        // Tauri 内部的 muda 事件通道转发到这里（Builder::on_menu_event
        // 接收所有 muda 菜单的事件，不区分菜单由谁创建）
        .on_menu_event(|app, event| {
            // 菜单事件分发：
            // - open：显示应用首页（主窗口）
            // - login：打开主窗口并跳登录页（未登录态菜单条目）
            // - check-update：打开主窗口"设置 · 关于"页（含检测更新入口）
            // - settings：打开主窗口设置页
            // - quit：app.exit 触发进程完全退出
            // 说明：login/check-update/settings 复用快捷面板的下钻通道
            // cnb://panel-navigate（main.ts 已监听该事件做 router.push），
            // 与 tray_panel_open_target 同一链路，前端零新增代码。
            // logout 单独走 cnb://tray-logout 事件（不走路由跳转）：
            // 退出登录需要弹出确认弹窗（含可选清空数据勾选），由前端
            // 全局确认弹窗（LogoutConfirmDialog）响应，不能直接 push 路由。
            match event.id().0.as_str() {
                "open" => show_main_window(app),
                "quit" => app.exit(0),
                "login" | "check-update" | "settings" | "profile" => {
                    let path = match event.id().0.as_str() {
                        "login" => "/login",
                        "check-update" => "/settings/about",
                        // 个人资料：应用内个人页（/profile），非外部浏览器
                        "profile" => "/profile",
                        _ => "/settings",
                    };
                    show_main_window(app);
                    if let Err(err) = app.emit_to("main", "cnb://panel-navigate", path) {
                        log::warn!("[tray] 菜单跳转事件发送失败: {err}");
                    }
                }
                "logout" => {
                    // 前置主窗口（确认弹窗挂载在主窗口 SPA 中）+ 通知前端
                    // 打开退出登录确认弹窗；payload 无内容，传空串占位
                    show_main_window(app);
                    if let Err(err) = app.emit_to("main", "cnb://tray-logout", "") {
                        log::warn!("[tray] 退出登录事件发送失败: {err}");
                    }
                }
                _ => {}
            }
        })
        .setup(|app| {
            // —— 恢复上次关闭时的窗口尺寸（逻辑像素）——
            //
            // 时机：Tauri 的 setup 是先创建配置窗口、再执行本闭包，
            // 因此此刻窗口已存在但事件循环尚未跑起来 → 改尺寸不会出现
            // "先按默认尺寸闪一下再变大"。最小值/屏幕上限的夹取逻辑见
            // 本文件「窗口尺寸记忆」模块头注释（物理/逻辑像素踩坑记录）。
            if let Some(window) = app.get_webview_window("main") {
                restore_window_size(&window);
            }

            // —— 托盘面板窗口：启动时强制保持隐藏 ——
            //
            // tauri.conf.json 已声明 visible:false，这里再显式 hide() 一次，
            // 兜住两类会把面板"带出来"的情况：
            // 1. macOS 窗口恢复/开发态热重启时对上次可见窗口的状态恢复；
            // 2. 配置被误改为可见时的防御。
            // 面板的唯一入口是托盘左键（toggle_tray_panel），应用启动时
            // 绝不应该自己弹出来。
            if let Some(panel) = app.get_webview_window(TRAY_PANEL_LABEL) {
                let _ = panel.hide();
            }

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
            //
            //    菜单文案跟随前端应用语言：启动时读持久化的 locale（上次
            //    会话由前端 set_tray_locale 写入），随后前端语言变化时经
            //    同一命令实时重建。前端启动后也会主动同步一次（以本地
            //    localStorage 的偏好为准，覆盖文件里的旧值）。
            #[cfg(target_os = "macos")]
            {
                let tray_locale = read_tray_locale(app.handle());
                // 初始化内存状态：set_tray_locale 命令处理线程也会读它，
                // 启动阶段先把持久化值灌进去，避免主线程/命令线程不一致
                if let Ok(mut guard) = tray_locale_slot().lock() {
                    *guard = tray_locale.clone();
                }
                // 登录态同理：读持久化用户名灌入槽位（前端会话恢复完成后
                // 会经 set_tray_auth 覆盖为本会话真值）
                let tray_username = read_tray_auth(app.handle());
                if let Ok(mut guard) = tray_auth_slot().lock() {
                    *guard = tray_username.clone();
                }
                let tray_menu = build_tray_menu(&tray_locale, &tray_username);
                // 存入主线程 thread_local：保持菜单存活（弹出时引用 NSMenu），
                // 供托盘事件回调读取（见 TRAY_NATIVE_MENU 注释）
                TRAY_NATIVE_MENU.with(|slot| *slot.borrow_mut() = Some(tray_menu));
                // 应用菜单栏（顶部 menu bar）：此前未设置，macOS 只显示
                // 系统默认项（英文），不随应用内语言切换 —— 现按持久化
                // 语言构建三语菜单（条目文案见 app_menu_texts；语言切换
                // 时由 set_tray_locale 同步重建）
                match build_app_menu(app.handle(), &tray_locale) {
                    Ok(menu) => {
                        if let Err(err) = app.set_menu(menu) {
                            log::warn!("[menu] 设置应用菜单栏失败: {err}");
                        }
                    }
                    Err(err) => log::warn!("[menu] 构建应用菜单栏失败: {err}"),
                }
                // 应用菜单条目点击事件（id 与语言无关，注册一次即可）：
                // 关于 → emit 给前端跳转；退出 → app.exit(0)（与托盘退出
                // 同路径，不经过 CloseRequested，关窗隐藏逻辑不会拦截）
                let handle = app.handle().clone();
                app.on_menu_event(move |_app, event| {
                    handle_app_menu_event(&handle, event.id().0.as_str());
                });
            }

            // 2. 构建托盘图标：字母 W 的 PNG（编译期嵌入）。
            //    交互设计：
            //    - 左键单击：切换活跃项目快捷面板（tray-panel 窗口，图标
            //      正下方弹出；再点一次隐藏）—— 项目状态速览 + 检测更新
            //      + 退出的轻量入口，不必打开完整主窗口；
            //    - 右键单击：按光标位置弹出原生菜单（见 popup_menu_at_cursor
            //      的多显示器修复说明），条目事件走 on_menu_event 回调，
            //      "打开应用"仍在此菜单中（开完整主窗口）；
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
                        position,
                        rect,
                        ..
                    } = event
                    {
                        match button {
                            // 左键单击：切换快捷面板（防抖：连点两次只算一次，
                            // 否则面板"闪现即消失"；rect 的 Position/Size 是
                            // "可能物理可能逻辑"的枚举，先归一为物理像素）
                            tauri::tray::MouseButton::Left => {
                                if tray_panel_toggle_debounced() {
                                    return;
                                }
                                // 缩放系数取光标所在屏（与托盘图标同屏）；
                                // 推断失败按平台默认值兜底（macOS Retina 2.0）
                                let scale = tray
                                    .app_handle()
                                    .monitor_from_point(position.x, position.y)
                                    .ok()
                                    .flatten()
                                    .map(|m| m.scale_factor())
                                    .unwrap_or(if cfg!(target_os = "macos") { 2.0 } else { 1.0 });
                                let (icon_x, icon_y, icon_w, icon_h)
                                    = tray_rect_physical(scale, rect.position, rect.size);
                                toggle_tray_panel(
                                    tray.app_handle(),
                                    position.x,
                                    position.y,
                                    icon_x,
                                    icon_y,
                                    icon_w,
                                    icon_h,
                                );
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
            // 托盘面板窗口（tray-panel）行为独立：失焦自动隐藏（点外部
            // 关面板的惯例交互）、固定尺寸不参与记忆、关闭请求只隐藏。
            // 必须先于通用逻辑分流，否则面板尺寸会被主窗口的记忆逻辑
            // 处理（MIN 1024x600 会把它撑大）。
            if window.label() == TRAY_PANEL_LABEL {
                match event {
                    // 点击面板外任何地方（面板失去焦点）→ 自动隐藏。
                    // 同时记录时刻：紧随其后的托盘点击应视为"关面板"，
                    // 不重新弹出（见 tray_panel_just_blur_hidden 注释）
                    tauri::WindowEvent::Focused(false) => {
                        note_tray_panel_blur_hide();
                        let _ = window.hide();
                    }
                    // Esc / 面板内关闭请求：只隐藏不销毁（复用已加载的
                    // 页面，下次弹出无白屏闪烁）
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        let _ = window.hide();
                        api.prevent_close();
                    }
                    _ => {}
                }
                return;
            }
            match event {
                // 尺寸变化：只更新内存缓存。拖拽窗口会连续触发几十次，
                // 逐次写盘既慢又无意义，真正落盘放到关窗/退出时
                // 注意：这里拿到的是底层 Window，尺寸逻辑统一按
                // WebviewWindow 处理 → 用 label 取回同一个窗口句柄
                tauri::WindowEvent::Resized(_) => {
                    if let Some(webview) = window
                        .app_handle()
                        .get_webview_window(window.label())
                    {
                        remember_window_size(&webview);
                    }
                }
                // 拦截主窗口的关闭请求：先把尺寸落盘，再隐藏窗口 + 阻止
                // 销毁行为，应用继续驻留系统托盘，仅能通过托盘菜单
                // "退出应用"真正退出
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    persist_window_size(window.app_handle());
                    let _ = window.hide();
                    api.prevent_close();
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // 托盘"退出应用"走 app.exit(0)，不经过 CloseRequested → 在事件循环
    // 退出时再落一次尺寸；正常关窗已在上面写过，这里重复写是幂等的
    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            persist_window_size(app_handle);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{
        app_menu_texts, build_header_map, clamp_window_size, greet, is_allowed_api_url,
        is_allowed_image_url, next_available_path, normalize_tray_locale, parse_window_size,
        sanitize_archive_name, tray_menu_texts, tray_rect_physical, APP_MENU_ABOUT_ID,
        APP_MENU_QUIT_ID, BUILD_NOTIFY_ACTION_TYPE_ID, MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH,
    };
    use std::collections::HashMap;

    /// 尺寸文本解析：正常值 / 空白 / 浮点 / 脏值的四类分支锁定。
    /// 脏值一律 None（调用方按首次启动处理），绝不能让 NaN 流到 set_size
    #[test]
    fn test_parse_window_size() {
        assert_eq!(parse_window_size("1024x600"), Some((1024.0, 600.0)));
        assert_eq!(parse_window_size(" 1213 x 720 \n"), Some((1213.0, 720.0)));
        assert_eq!(parse_window_size("1280.0x800.0"), Some((1280.0, 800.0)));
        // 非法：缺分隔符 / 非数字 / 非正数 / 非有限值
        assert_eq!(parse_window_size("1024"), None);
        assert_eq!(parse_window_size("1024*600"), None);
        assert_eq!(parse_window_size("axb"), None);
        assert_eq!(parse_window_size("0x600"), None);
        assert_eq!(parse_window_size("1024x-600"), None);
        assert_eq!(parse_window_size("NaNx600"), None);
        assert_eq!(parse_window_size(""), None);
    }

    /// 尺寸夹取：核心回归用例是"外接 1x 屏存的 physical 尺寸在 2x 屏上
    /// 缩水一半"这个真实事故（1213×720 physical → 606×360 逻辑点）
    #[test]
    fn test_clamp_window_size() {
        // 首次启动（无历史文件）→ 用最小尺寸，即配置默认值
        assert_eq!(
            clamp_window_size(None, None),
            (MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT)
        );
        // 事故场景：2x 屏上恢复出 606×360 → 必须被抬到最小值
        assert_eq!(
            clamp_window_size(Some((606.0, 360.0)), None),
            (MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT)
        );
        // 正常尺寸原样保留（只取整）
        assert_eq!(clamp_window_size(Some((1213.4, 720.6)), None), (1213.0, 721.0));
        // 超过屏幕 → 夹到屏幕尺寸（从大屏换到小屏的场景）
        assert_eq!(
            clamp_window_size(Some((2400.0, 1400.0)), Some((1440.0, 900.0))),
            (1440.0, 900.0)
        );
        // 屏幕比最小值还小（极端缩放）→ 只保下限，不能把窗口压到更小
        assert_eq!(
            clamp_window_size(Some((800.0, 500.0)), Some((800.0, 500.0))),
            (MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT)
        );
    }

    /// 常量与 tauri.conf.json 的窗口配置必须同步：默认尺寸 == 最小尺寸，
    /// 改配置忘改常量（或反之）会让恢复逻辑夹错区间。`include_str!` 编译期
    /// 读取配置，漂移时这里直接失败
    #[test]
    fn test_window_size_constants_match_config() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json 不是合法 JSON");
        let windows = conf["app"]["windows"].as_array().expect("缺少 app.windows");
        let main = windows
            .iter()
            .find(|w| w["label"].as_str().unwrap_or("main") == "main")
            .expect("缺少主窗口配置");
        let width = main["width"].as_f64().expect("缺少 width");
        let height = main["height"].as_f64().expect("缺少 height");
        assert_eq!(width, MIN_WINDOW_WIDTH, "默认宽度与 MIN_WINDOW_WIDTH 不一致");
        assert_eq!(height, MIN_WINDOW_HEIGHT, "默认高度与 MIN_WINDOW_HEIGHT 不一致");
        assert_eq!(
            main["minWidth"].as_f64(),
            Some(MIN_WINDOW_WIDTH),
            "minWidth 与 MIN_WINDOW_WIDTH 不一致"
        );
        assert_eq!(
            main["minHeight"].as_f64(),
            Some(MIN_WINDOW_HEIGHT),
            "minHeight 与 MIN_WINDOW_HEIGHT 不一致"
        );
    }

    /// tray_rect_physical 两种坐标态的换算锁定：物理态原样透传（不乘
    /// 缩放，否则 Retina 下面板定位翻倍偏移）、逻辑态按 scale 展开。
    /// 这是托盘面板"图标正下方弹出"定位公式的输入端，错一口径面板
    /// 就会飘到屏幕外。
    #[test]
    fn test_tray_rect_physical() {
        use tauri::{LogicalPosition, LogicalSize, PhysicalPosition, PhysicalSize, Position, Size};
        // 物理态：直接透传，scale 不参与
        let (x, y, w, h) = tray_rect_physical(
            2.0,
            Position::Physical(PhysicalPosition::new(100, 40)),
            Size::Physical(PhysicalSize::new(22, 22)),
        );
        assert_eq!((x, y, w, h), (100.0, 40.0, 22.0, 22.0));
        // 逻辑态：按 scale 展开（Mac 状态栏图标 rect 常为逻辑单位）
        let (x, y, w, h) = tray_rect_physical(
            2.0,
            Position::Logical(LogicalPosition::new(50.0, 20.0)),
            Size::Logical(LogicalSize::new(11.0, 11.0)),
        );
        assert_eq!((x, y, w, h), (100.0, 40.0, 22.0, 22.0));
    }

    /// 托盘菜单三语文案映射锁定：三种显式语言各自命中独立文案，
    /// 且所有动作条目（open/quit/login/logout/profile）都不能为空
    /// （muda 空文本条目渲染异常）；account 条目文案是用户名不在此列。
    #[test]
    fn test_tray_menu_texts_locales() {
        let en = tray_menu_texts("en");
        assert!(!en.open.is_empty() && !en.quit.is_empty());
        assert!(!en.login.is_empty() && !en.logout.is_empty());
        assert!(!en.profile.is_empty());
        assert_ne!(en.login, en.logout);
        assert_ne!(en.open, en.quit);
        let tw = tray_menu_texts("zh-TW");
        assert!(!tw.open.is_empty() && !tw.quit.is_empty());
        assert!(!tw.login.is_empty() && !tw.logout.is_empty());
        assert!(!tw.profile.is_empty());
        let cn = tray_menu_texts("zh-CN");
        assert!(!cn.open.is_empty() && !cn.quit.is_empty());
        assert!(!cn.login.is_empty() && !cn.logout.is_empty());
        assert!(!cn.profile.is_empty());
        // 三种语言的文案互不相同（同一语言不可两种显示）
        assert_ne!(en, tw);
        assert_ne!(cn, en);
        // 新增功能条目（登录/检测更新/设置）三语齐全非空
        for t in [en, tw, cn] {
            assert!(!t.login.is_empty(), "login empty");
            assert!(!t.check_update.is_empty(), "check_update empty");
            assert!(!t.settings.is_empty(), "settings empty");
        }
    }

    /// 应用菜单栏三语文案映射锁定（macOS 顶部 menu bar 多语言）：
    /// 三种显式语言各自命中独立文案；所有字段非空（空串条目渲染异常）；
    /// about/quit/hide 文案必须包含应用名 WOCNB（macOS 惯例：菜单条目带应用名）。
    #[test]
    fn test_app_menu_texts_locales() {
        for locale in ["en", "zh-CN", "zh-TW"] {
            let t = app_menu_texts(locale);
            assert!(!t.about.is_empty() && t.about.contains("WOCNB"), "locale={locale}");
            assert!(!t.quit.is_empty() && t.quit.contains("WOCNB"), "locale={locale}");
            assert!(!t.edit.is_empty() && !t.window.is_empty(), "locale={locale}");
            // 预定义条目文案（跟随应用语言而非系统语言的改造）全部非空
            assert!(!t.undo.is_empty() && !t.redo.is_empty(), "locale={locale}");
            assert!(!t.cut.is_empty() && !t.copy.is_empty(), "locale={locale}");
            assert!(!t.paste.is_empty() && !t.select_all.is_empty(), "locale={locale}");
            assert!(!t.minimize.is_empty() && !t.close_window.is_empty(), "locale={locale}");
            assert!(!t.hide.is_empty() && t.hide.contains("WOCNB"), "locale={locale}");
            assert!(!t.hide_others.is_empty(), "locale={locale}");
        }
        // 三种语言互不相同（防止复制粘贴漏改某语言）
        assert_ne!(app_menu_texts("en"), app_menu_texts("zh-CN"));
        assert_ne!(app_menu_texts("zh-TW"), app_menu_texts("zh-CN"));
        assert_ne!(app_menu_texts("en"), app_menu_texts("zh-TW"));
    }

    /// 应用菜单条目 id 常量锁定：与 setup 里的 on_menu_event 注册、构建时的
    /// with_id 是同一对字面量（两侧漂移会导致点击无响应且无任何报错）。
    #[test]
    fn test_app_menu_ids() {
        assert_eq!(APP_MENU_ABOUT_ID, "app-about");
        assert_eq!(APP_MENU_QUIT_ID, "app-quit");
    }

    /// 托盘语言归一化：合法值原样保留（大小写不敏感），脏值回落 zh-CN
    #[test]
    fn test_normalize_tray_locale() {
        assert_eq!(normalize_tray_locale("en"), "en");
        assert_eq!(normalize_tray_locale("zh-CN"), "zh-CN");
        assert_eq!(normalize_tray_locale("zh-TW"), "zh-TW");
        // 大小写容错（前端理论上只传精确值，防御第三方调用）
        assert_eq!(normalize_tray_locale("EN"), "en");
        assert_eq!(normalize_tray_locale(" zh-tw "), "zh-TW");
        // 脏值 / system / 空串一律回落默认（zh-CN，与历史中文菜单一致）
        assert_eq!(normalize_tray_locale("system"), "zh-CN");
        assert_eq!(normalize_tray_locale("fr"), "zh-CN");
        assert_eq!(normalize_tray_locale(""), "zh-CN");
    }

    /// 归一化结果必须能命中文案映射（链路口径一致性：normalize 输出是
    /// tray_menu_texts 的输入，若归一产出了映射外语言会静默回落中文）
    #[test]
    fn test_normalize_output_matches_texts_input() {
        for locale in ["en", "zh-CN", "zh-TW"] {
            let norm = normalize_tray_locale(locale);
            let _ = tray_menu_texts(&norm); // 不 panic 即可，返回值被借用
        }
    }


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
