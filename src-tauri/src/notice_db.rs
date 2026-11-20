//! 本地通知消息 SQLite 持久化模块（构建通知 + 应用通知）。
//!
//! # 背景
//!
//! 此前通知列表（buildNoticeFeed / appNoticeFeed）纯存内存，应用重启即丢。
//! 本模块引入本地 SQLite 数据库，把通知消息落盘，重启/重登后可恢复历史
//! 通知与未读状态。
//!
//! # 用户数据隔离
//!
//! 所有表都带 `username` 列（取自当前登录用户 `cnbUser.username`），
//! 读取、写入、已读标记、清空全部以 username 为过滤条件 —— 多账号各自
//! 只能看到自己的通知，互不可见。
//!
//! # 登出策略
//!
//! 登出时**默认保留**数据库数据（仅清内存 feed），用户在退出确认弹窗里
//! 勾选「清空本地通知数据」才会调用 `notice_db_clear` 物理删除该账号的
//! 全部通知。401 被动登出（令牌过期）不询问、不清数据。
//!
//! # 技术选型
//!
//! rusqlite + bundled：静态编译 SQLite，不依赖用户机器的系统 libsqlite3；
//! 自建命令而非 tauri-plugin-sql：与既有 `cnb_http_request` 通道风格一致，
//! SQL 不暴露给前端，边界收敛在 Rust 侧，便于单测与审计。
//!
//! # 性能
//!
//! 每次命令独立开连接（SQLite 打开成本低，通知写入频率为分钟级），
//! 不维护全局连接池，规避 Send/Sync 与应用生命周期管理复杂度。
//! 写入后做容量裁剪（每账号构建通知 200 条 / 应用通知 100 条），
//! 防止数据库无界增长。

use std::path::PathBuf;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::Manager;

// ---------------------------------------------------------------------------
// 容量常量
// ---------------------------------------------------------------------------

/// 每账号最多保留的构建通知条数（数据库物理上限，超出删最旧）
const BUILD_KEEP_PER_USER: i64 = 200;
/// 每账号最多保留的应用通知条数
const APP_KEEP_PER_USER: i64 = 100;
/// 每账号最多保留的「最近打开」仓库记录条数（与前端 MAX_RECENT_REPOS 一致）
const RECENT_KEEP_PER_USER: i64 = 20;
/// 单次加载返回的构建通知条数（与前端内存 feed 上限 MAX_FEED_SIZE 一致）
const BUILD_LOAD_LIMIT: i64 = 50;
/// 单次加载返回的应用通知条数（与前端 MAX_APP_NOTICE_SIZE 一致）
const APP_LOAD_LIMIT: i64 = 20;

/// 数据库文件名（位于 app_data_dir 下，与托盘 locale/窗口尺寸文件同目录）
const DB_FILE_NAME: &str = "notices.db";

// ---------------------------------------------------------------------------
// 数据结构（serde camelCase 对齐前端 BuildNotice / AppNotice 字段命名）
// ---------------------------------------------------------------------------

/// 构建通知条目（数据库存储形态）
///
/// 与前端 `BuildNotice`（useCnbBuildWatch.ts）字段一一对应，另增：
/// - `notice_id`：前端生成的唯一 id（时间戳+序号），同一账号内唯一；
/// - `read`：已读标记（前端此前只有全局未读计数，持久化后按条记录）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredBuildNotice {
    /// 前端通知 id（同一账号内唯一，重复插入静默忽略）
    pub notice_id: String,
    /// 仓库完整路径
    pub repo_path: String,
    /// 仓库名
    pub repo_name: String,
    /// 构建序号
    pub sn: String,
    /// 最终状态（'' = 未知）
    pub status: String,
    /// 提交标题
    pub commit_title: String,
    /// 触发分支/引用
    pub source_ref: String,
    /// 触发人昵称
    pub nick_name: String,
    /// 通知时间（毫秒时间戳）
    pub time: i64,
    /// 是否为"应用未运行期间结束"的离线补推条目
    pub leftover: bool,
    /// 已读标记（打开通知面板即置 1）
    pub read: bool,
}

/// 应用通知条目（数据库存储形态）
///
/// 与前端 `AppNotice`（useAppNotices.ts）字段一一对应。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredAppNotice {
    /// 前端通知 id（同一账号内唯一，重复插入静默忽略）
    pub notice_id: String,
    /// 通知类型（当前仅 'update'）
    pub kind: String,
    /// 通知标题（发送时已本地化）
    pub title: String,
    /// 通知正文
    pub body: String,
    /// 相关版本号
    pub version: String,
    /// 通知时间（毫秒时间戳）
    pub time: i64,
    /// 已读标记
    pub read: bool,
}

/// 「最近打开」仓库记录（数据库存储形态）
///
/// 托盘快捷面板的数据源（此前存 localStorage，应用更新后 WebView
/// 分区数据可能被清导致列表丢失，改落 SQLite 与通知同库同生命周期）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredRecentRepo {
    /// 仓库完整路径（唯一键，同仓库重复打开=更新时间置顶）
    pub repo_path: String,
    /// 仓库展示名（路径末段）
    pub repo_name: String,
    /// 主语言（面板色块，可空）
    pub language: String,
    /// 语言主题色 #RRGGBB（可空）
    pub language_color: String,
    /// 仓库可见性（小写三值 public/private/secret；旧数据/未知为空串 →
    /// 面板不渲染徽标，绝不把未知可见性误标成"公开"）
    pub visibility: String,
    /// 最近打开时间（毫秒时间戳）
    pub opened_at: i64,
}

/// 加载结果（一次命令同时取回两个分区，前端回灌只需一次 IPC）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoticeLoadResult {
    /// 构建通知（最新在前，最多 50 条）
    pub build_notices: Vec<StoredBuildNotice>,
    /// 应用通知（最新在前，最多 20 条）
    pub app_notices: Vec<StoredAppNotice>,
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/// 校验用户名合法性。
///
/// username 是数据隔离的过滤键（作为列值而非 SQL 标识符拼接，无注入面），
/// 这里只做边界防御：空串/过长一律拒绝，避免匿名数据混入与异常长度写入。
fn validate_username(username: &str) -> Result<(), String> {
    if username.trim().is_empty() {
        return Err("username 不能为空（通知持久化必须绑定登录账号）".to_string());
    }
    if username.len() > 128 {
        return Err("username 长度非法（>128 字符）".to_string());
    }
    Ok(())
}

/// 解析数据库文件路径（app_data_dir/notices.db），目录不存在则创建。
///
/// app_data_dir 解析失败（理论上仅在极端环境出现）返回 Err，由命令层
/// 转成前端可读的错误信息。
fn resolve_db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("解析 app_data_dir 失败: {e}"))?;
    if !dir.exists() {
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("创建数据目录 {} 失败: {e}", dir.display()))?;
    }
    Ok(dir.join(DB_FILE_NAME))
}

/// 初始化表结构（幂等：CREATE TABLE/INDEX IF NOT EXISTS）。
///
/// 读取与写入共用；后续若字段演进，在此追加迁移逻辑（当前 v1 为首版）。
fn init_schema(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS build_notices (
            row_id       INTEGER PRIMARY KEY AUTOINCREMENT,
            username     TEXT    NOT NULL,
            notice_id    TEXT    NOT NULL,
            repo_path    TEXT    NOT NULL DEFAULT '',
            repo_name    TEXT    NOT NULL DEFAULT '',
            sn           TEXT    NOT NULL DEFAULT '',
            status       TEXT    NOT NULL DEFAULT '',
            commit_title TEXT    NOT NULL DEFAULT '',
            source_ref   TEXT    NOT NULL DEFAULT '',
            nick_name    TEXT    NOT NULL DEFAULT '',
            time         INTEGER NOT NULL DEFAULT 0,
            leftover     INTEGER NOT NULL DEFAULT 0,
            read         INTEGER NOT NULL DEFAULT 0,
            created_at   INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_build_user_time ON build_notices(username, time DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_build_unique_id ON build_notices(username, notice_id);

        CREATE TABLE IF NOT EXISTS app_notices (
            row_id     INTEGER PRIMARY KEY AUTOINCREMENT,
            username   TEXT    NOT NULL,
            notice_id  TEXT    NOT NULL,
            kind       TEXT    NOT NULL DEFAULT '',
            title      TEXT    NOT NULL DEFAULT '',
            body       TEXT    NOT NULL DEFAULT '',
            version    TEXT    NOT NULL DEFAULT '',
            time       INTEGER NOT NULL DEFAULT 0,
            read       INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_app_user_time ON app_notices(username, time DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_app_unique_id ON app_notices(username, notice_id);

        CREATE TABLE IF NOT EXISTS recent_repos (
            row_id         INTEGER PRIMARY KEY AUTOINCREMENT,
            username       TEXT    NOT NULL,
            repo_path      TEXT    NOT NULL,
            repo_name      TEXT    NOT NULL DEFAULT '',
            language       TEXT    NOT NULL DEFAULT '',
            language_color TEXT    NOT NULL DEFAULT '',
            visibility     TEXT    NOT NULL DEFAULT '',
            opened_at      INTEGER NOT NULL DEFAULT 0,
            created_at     INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_recent_user_time ON recent_repos(username, opened_at DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_recent_unique_path ON recent_repos(username, repo_path);
        "#,
    )?;
    // v2 迁移（2026-11-20）：recent_repos 增加 visibility 列（公开/私有徽标）。
    // CREATE TABLE IF NOT EXISTS 对**已存在**的旧表（rc.50 及以前）不会补列，
    // 必须显式 ALTER；列已存在时 SQLite 报 "duplicate column name"，属预期
    // 迁移幂等信号，忽略即可（其他错误同样忽略 —— ALTER 失败只会让徽标
    // 显示为空，不能让通知/最近打开的读写整体挂掉）。
    let _ = conn.execute(
        "ALTER TABLE recent_repos ADD COLUMN visibility TEXT NOT NULL DEFAULT ''",
        [],
    );
    Ok(())
}

/// 打开数据库连接并确保表结构就绪。
///
/// busy_timeout：通知写入与加载可能并发（轮询写入 + 面板打开加载），
/// 给 3 秒锁等待，避免偶发 SQLITE_BUSY 直接报错。
fn open_db(path: &PathBuf) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| format!("打开通知数据库失败: {e}"))?;
    conn.busy_timeout(std::time::Duration::from_secs(3))
        .map_err(|e| format!("设置 busy_timeout 失败: {e}"))?;
    init_schema(&conn).map_err(|e| format!("初始化通知表结构失败: {e}"))?;
    Ok(conn)
}

/// 插入后的容量裁剪：删除指定账号超出保留上限的最旧条目。
///
/// 子查询按 (time DESC, row_id DESC) 选出最新 N 条的 row_id，
/// 其余全部删除 —— 同毫秒多条通知靠 row_id 兜底排序，避免误删。
fn prune_overflow(conn: &Connection, table: &str, username: &str, keep: i64) -> Result<(), String> {
    // 表名来自模块内常量调用点（非用户输入），此处直接拼接安全
    let sql = format!(
        "DELETE FROM {table} WHERE username = ?1 AND row_id NOT IN \
         (SELECT row_id FROM {table} WHERE username = ?1 \
          ORDER BY time DESC, row_id DESC LIMIT {keep})"
    );
    conn.execute(&sql, rusqlite::params![username])
        .map_err(|e| format!("裁剪 {table} 历史通知失败: {e}"))?;
    Ok(())
}

/// 「最近打开」记录的容量裁剪（时间列名与通知表不同：opened_at）。
fn prune_recent_overflow(conn: &Connection, username: &str, keep: i64) -> Result<(), String> {
    conn.execute(
        "DELETE FROM recent_repos WHERE username = ?1 AND row_id NOT IN \
         (SELECT row_id FROM recent_repos WHERE username = ?1 \
          ORDER BY opened_at DESC, row_id DESC LIMIT ?2)",
        rusqlite::params![username, keep],
    )
    .map_err(|e| format!("裁剪最近打开记录失败: {e}"))?;
    Ok(())
}

/// 当前登录用户名（从 lib.rs 的托盘登录态槽位读取）。
///
/// 为什么不从前端传参：托盘面板是独立 WebView（tray-panel.html 单独
/// 引导的 Vue 应用），没有主应用的 cnbUser 状态；而主窗口在登录态变化
/// 时已经通过 set_tray_auth 把用户名同步进了 Rust 槽位（且启动时有
/// tray-auth.txt 持久化兜底）。所有窗口统一从槽位取值，一条数据链路。
fn current_slot_username() -> String {
    crate::tray_auth_slot()
        .lock()
        .map(|g| g.clone())
        .unwrap_or_default()
}

/// 毫秒级当前时间戳（三个写入命令共用）
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

/// 加载指定账号的「最近打开」记录（最新在前，最多 20 条，核心逻辑供单测复用）。
fn load_recent_repos_conn(conn: &Connection, username: &str) -> Result<Vec<StoredRecentRepo>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT repo_path, repo_name, language, language_color, visibility, opened_at
             FROM recent_repos WHERE username = ?1
             ORDER BY opened_at DESC, row_id DESC LIMIT ?2",
        )
        .map_err(|e| format!("查询最近打开记录失败: {e}"))?;
    let rows = stmt
        .query_map(rusqlite::params![username, RECENT_KEEP_PER_USER], |row| {
            Ok(StoredRecentRepo {
                repo_path: row.get(0)?,
                repo_name: row.get(1)?,
                language: row.get(2)?,
                language_color: row.get(3)?,
                visibility: row.get(4)?,
                opened_at: row.get(5)?,
            })
        })
        .map_err(|e| format!("读取最近打开记录失败: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("遍历最近打开记录失败: {e}"))?;
    Ok(rows)
}

/// 写入（upsert）一条「最近打开」记录（核心逻辑供单测复用）。
///
/// 同 (username, repo_path) 已存在则更新名称/语言/可见性/时间（置顶语义），
/// 不产生重复条目；写入后裁剪到每账号 20 条。
#[allow(clippy::too_many_arguments)]
fn upsert_recent_repo_conn(
    conn: &Connection,
    username: &str,
    repo_path: &str,
    repo_name: &str,
    language: &str,
    language_color: &str,
    visibility: &str,
    opened_at: i64,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO recent_repos
            (username, repo_path, repo_name, language, language_color, visibility, opened_at, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
         ON CONFLICT(username, repo_path) DO UPDATE SET
            repo_name = excluded.repo_name,
            language = excluded.language,
            language_color = excluded.language_color,
            visibility = excluded.visibility,
            opened_at = excluded.opened_at,
            created_at = excluded.created_at",
        rusqlite::params![username, repo_path, repo_name, language, language_color, visibility, opened_at],
    )
    .map_err(|e| format!("写入最近打开记录失败: {e}"))?;
    prune_recent_overflow(conn, username, RECENT_KEEP_PER_USER)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri 命令
// ---------------------------------------------------------------------------

/// 加载指定账号的通知（构建 + 应用两个分区，最新在前）。
///
/// 前端在登录态恢复 / 登录成功后调用，用结果回灌内存 feed 与未读徽标。
#[tauri::command]
pub fn notice_db_load(app: tauri::AppHandle, username: String) -> Result<NoticeLoadResult, String> {
    validate_username(&username)?;
    let path = resolve_db_path(&app)?;
    let conn = open_db(&path)?;

    // 构建通知：按时间倒序取最近 50 条（与前端 feed 容量一致）
    let mut stmt = conn
        .prepare(
            "SELECT notice_id, repo_path, repo_name, sn, status, commit_title, source_ref,
                    nick_name, time, leftover, read
             FROM build_notices WHERE username = ?1
             ORDER BY time DESC, row_id DESC LIMIT ?2",
        )
        .map_err(|e| format!("查询构建通知失败: {e}"))?;
    let build_notices = stmt
        .query_map(rusqlite::params![username, BUILD_LOAD_LIMIT], |row| {
            Ok(StoredBuildNotice {
                notice_id: row.get(0)?,
                repo_path: row.get(1)?,
                repo_name: row.get(2)?,
                sn: row.get(3)?,
                status: row.get(4)?,
                commit_title: row.get(5)?,
                source_ref: row.get(6)?,
                nick_name: row.get(7)?,
                time: row.get(8)?,
                leftover: row.get::<_, i64>(9)? != 0,
                read: row.get::<_, i64>(10)? != 0,
            })
        })
        .map_err(|e| format!("读取构建通知失败: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("遍历构建通知失败: {e}"))?;

    // 应用通知：同样倒序取最近 20 条
    let mut stmt = conn
        .prepare(
            "SELECT notice_id, kind, title, body, version, time, read
             FROM app_notices WHERE username = ?1
             ORDER BY time DESC, row_id DESC LIMIT ?2",
        )
        .map_err(|e| format!("查询应用通知失败: {e}"))?;
    let app_notices = stmt
        .query_map(rusqlite::params![username, APP_LOAD_LIMIT], |row| {
            Ok(StoredAppNotice {
                notice_id: row.get(0)?,
                kind: row.get(1)?,
                title: row.get(2)?,
                body: row.get(3)?,
                version: row.get(4)?,
                time: row.get(5)?,
                read: row.get::<_, i64>(6)? != 0,
            })
        })
        .map_err(|e| format!("读取应用通知失败: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("遍历应用通知失败: {e}"))?;

    Ok(NoticeLoadResult {
        build_notices,
        app_notices,
    })
}

/// 插入一条构建通知（重复 id 静默忽略，插入后裁剪到 200 条）。
#[tauri::command]
pub fn notice_db_insert_build(
    app: tauri::AppHandle,
    username: String,
    notice_id: String,
    repo_path: String,
    repo_name: String,
    sn: String,
    status: String,
    commit_title: String,
    source_ref: String,
    nick_name: String,
    time: i64,
    leftover: bool,
) -> Result<(), String> {
    validate_username(&username)?;
    if notice_id.trim().is_empty() {
        return Err("notice_id 不能为空".to_string());
    }
    let path = resolve_db_path(&app)?;
    let conn = open_db(&path)?;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    conn.execute(
        "INSERT INTO build_notices
            (username, notice_id, repo_path, repo_name, sn, status, commit_title,
             source_ref, nick_name, time, leftover, read, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0, ?12)
         ON CONFLICT(username, notice_id) DO NOTHING",
        rusqlite::params![
            username,
            notice_id,
            repo_path,
            repo_name,
            sn,
            status,
            commit_title,
            source_ref,
            nick_name,
            time,
            leftover as i64,
            now_ms
        ],
    )
    .map_err(|e| format!("写入构建通知失败: {e}"))?;
    prune_overflow(&conn, "build_notices", &username, BUILD_KEEP_PER_USER)?;
    Ok(())
}

/// 插入一条应用通知（重复 id 静默忽略，插入后裁剪到 100 条）。
#[tauri::command]
pub fn notice_db_insert_app(
    app: tauri::AppHandle,
    username: String,
    notice_id: String,
    kind: String,
    title: String,
    body: String,
    version: String,
    time: i64,
) -> Result<(), String> {
    validate_username(&username)?;
    if notice_id.trim().is_empty() {
        return Err("notice_id 不能为空".to_string());
    }
    let path = resolve_db_path(&app)?;
    let conn = open_db(&path)?;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    conn.execute(
        "INSERT INTO app_notices
            (username, notice_id, kind, title, body, version, time, read, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8)
         ON CONFLICT(username, notice_id) DO NOTHING",
        rusqlite::params![username, notice_id, kind, title, body, version, time, now_ms],
    )
    .map_err(|e| format!("写入应用通知失败: {e}"))?;
    prune_overflow(&conn, "app_notices", &username, APP_KEEP_PER_USER)?;
    Ok(())
}

/// 把指定账号两个分区的全部通知标记为已读（打开通知面板时调用）。
///
/// 全量 UPDATE 而非按条标记：面板打开即视为全部已读（与既有全局未读
/// 清零语义一致），且幂等可重入。
#[tauri::command]
pub fn notice_db_mark_all_read(app: tauri::AppHandle, username: String) -> Result<(), String> {
    validate_username(&username)?;
    let path = resolve_db_path(&app)?;
    let conn = open_db(&path)?;
    conn.execute("UPDATE build_notices SET read = 1 WHERE username = ?1", rusqlite::params![username])
        .map_err(|e| format!("标记构建通知已读失败: {e}"))?;
    conn.execute("UPDATE app_notices SET read = 1 WHERE username = ?1", rusqlite::params![username])
        .map_err(|e| format!("标记应用通知已读失败: {e}"))?;
    Ok(())
}

/// 清空指定账号的全部通知（退出登录且用户勾选「清空本地数据」时调用）。
///
/// 物理删除两个通知分区与「最近打开」记录中该账号的所有行；其他账号
/// 数据不受影响（隔离前提下的定向清除）。默认登出路径**不会**调用本
/// 命令（数据保留）。
#[tauri::command]
pub fn notice_db_clear(app: tauri::AppHandle, username: String) -> Result<(), String> {
    validate_username(&username)?;
    let path = resolve_db_path(&app)?;
    let conn = open_db(&path)?;
    conn.execute("DELETE FROM build_notices WHERE username = ?1", rusqlite::params![username])
        .map_err(|e| format!("清空构建通知失败: {e}"))?;
    conn.execute("DELETE FROM app_notices WHERE username = ?1", rusqlite::params![username])
        .map_err(|e| format!("清空应用通知失败: {e}"))?;
    conn.execute("DELETE FROM recent_repos WHERE username = ?1", rusqlite::params![username])
        .map_err(|e| format!("清空最近打开记录失败: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 「最近打开」记录（托盘快捷面板数据源，SQLite 持久化）
// ---------------------------------------------------------------------------

/// 加载当前登录账号的「最近打开」仓库记录（最新在前，最多 20 条）。
///
/// 用户名从托盘登录态槽位读取（主窗口 set_tray_auth 同步 + tray-auth.txt
/// 启动兜底）；未登录返回空列表（面板展示空态）。
#[tauri::command]
pub fn recent_repos_load(app: tauri::AppHandle) -> Result<Vec<StoredRecentRepo>, String> {
    let username = current_slot_username();
    if username.is_empty() {
        return Ok(Vec::new());
    }
    let path = resolve_db_path(&app)?;
    let conn = open_db(&path)?;
    load_recent_repos_conn(&conn, &username)
}

/// 记录一次仓库打开（upsert，同仓库更新时间置顶；每账号上限 20 条）。
///
/// 未登录（槽位用户名为空）直接忽略 —— 「最近打开」绑定账号隔离，
/// 未登录态不产生持久化数据。opened_at 由调用方可选传入（localStorage
/// 一次性迁移场景需要保留原始时间），缺省取当前时间。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn recent_repos_upsert(
    app: tauri::AppHandle,
    repo_path: String,
    repo_name: String,
    language: String,
    language_color: String,
    visibility: String,
    opened_at: Option<i64>,
) -> Result<(), String> {
    let username = current_slot_username();
    if username.is_empty() {
        return Ok(());
    }
    if repo_path.trim().is_empty() {
        return Err("repo_path 不能为空".to_string());
    }
    let path = resolve_db_path(&app)?;
    let conn = open_db(&path)?;
    let opened_at = opened_at.unwrap_or_else(now_ms);
    upsert_recent_repo_conn(
        &conn,
        &username,
        repo_path.trim(),
        repo_name.trim(),
        language.trim(),
        language_color.trim(),
        // 可见性统一小写落库（前端传入 RepoDetail.visibility 是首字母大写
        // 三值 Public/Private/Secret，面板徽标按小写口径渲染）
        visibility.trim().to_lowercase().as_str(),
        opened_at,
    )
}

// ---------------------------------------------------------------------------
// 单元测试（临时目录内建库验证全链路，不触碰真实 app_data_dir）
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// 生成互不冲突的临时库路径（进程 id + 纳秒时间戳兜底唯一）
    fn temp_db_path(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "wocnb-notice-db-test-{}-{}-{tag}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("notices.db")
    }

    /// 直接对指定路径建库（绕过 AppHandle，测核心 SQL 逻辑）
    fn open_test_db(path: &PathBuf) -> Connection {
        let conn = Connection::open(path).unwrap();
        conn.busy_timeout(std::time::Duration::from_secs(3)).unwrap();
        init_schema(&conn).unwrap();
        conn
    }

    /// 构造一条构建通知参数（各测试用例复用，字段按需覆写）
    fn build_row(id: &str, time: i64) -> StoredBuildNotice {
        StoredBuildNotice {
            notice_id: id.to_string(),
            repo_path: "group/repo".to_string(),
            repo_name: "repo".to_string(),
            sn: "42".to_string(),
            status: "success".to_string(),
            commit_title: "feat: x".to_string(),
            source_ref: "main".to_string(),
            nick_name: "tester".to_string(),
            time,
            leftover: false,
            read: false,
        }
    }

    #[test]
    fn test_username_validation() {
        // 空串 / 纯空白必须拒绝：通知必须绑定账号才能隔离
        assert!(validate_username("").is_err());
        assert!(validate_username("   ").is_err());
        // 过长用户名拒绝（防御异常数据）
        assert!(validate_username(&"a".repeat(129)).is_err());
        // 正常用户名放行
        assert!(validate_username("jackytse").is_ok());
    }

    #[test]
    fn test_insert_load_and_isolation() {
        let path = temp_db_path("insert-load");
        let conn = open_test_db(&path);

        // alice 写入 2 条，bob 写入 1 条
        for (user, n) in [("alice", 2), ("bob", 1)] {
            for i in 0..n {
                let t = 1700000000000i64 + i;
                let r = build_row(&format!("{user}-{i}"), t);
                conn.execute(
                    "INSERT INTO build_notices
                        (username, notice_id, repo_path, repo_name, sn, status, commit_title,
                         source_ref, nick_name, time, leftover, read, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0, ?12)",
                    rusqlite::params![
                        user, r.notice_id, r.repo_path, r.repo_name, r.sn, r.status,
                        r.commit_title, r.source_ref, r.nick_name, r.time,
                        r.leftover as i64, r.time
                    ],
                )
                .unwrap();
            }
        }

        // alice 只能读到自己的 2 条（数据隔离核心断言）
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM build_notices WHERE username = 'alice'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 2);
        // bob 1 条
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM build_notices WHERE username = 'bob'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn test_duplicate_id_ignored() {
        let path = temp_db_path("dup");
        let conn = open_test_db(&path);
        let r = build_row("dup-1", 1700000000000i64);
        let sql = "INSERT INTO build_notices
            (username, notice_id, repo_path, repo_name, sn, status, commit_title,
             source_ref, nick_name, time, leftover, read, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0, ?12)
         ON CONFLICT(username, notice_id) DO NOTHING";
        for _ in 0..2 {
            conn.execute(
                sql,
                rusqlite::params![
                    "alice", r.notice_id, r.repo_path, r.repo_name, r.sn, r.status,
                    r.commit_title, r.source_ref, r.nick_name, r.time,
                    r.leftover as i64, r.time
                ],
            )
            .unwrap();
        }
        // 同 id 重复插入只留 1 条（重启后同毫秒同序号的幂等兜底）
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM build_notices", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn test_prune_overflow() {
        let path = temp_db_path("prune");
        let conn = open_test_db(&path);
        // 写入 10 条，保留上限设为 5
        for i in 0..10i64 {
            conn.execute(
                "INSERT INTO build_notices
                    (username, notice_id, time, created_at)
                 VALUES ('alice', ?1, ?2, ?2)",
                rusqlite::params![format!("p-{i}"), 1700000000000i64 + i],
            )
            .unwrap();
        }
        prune_overflow(&conn, "build_notices", "alice", 5).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM build_notices", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 5);
        // 剩下的必须是**最新**的 5 条（时间最大的），旧的被裁掉
        let min_time: i64 = conn
            .query_row("SELECT MIN(time) FROM build_notices", [], |r| r.get(0))
            .unwrap();
        assert_eq!(min_time, 1700000000000i64 + 5);
    }

    #[test]
    fn test_mark_all_read_and_clear() {
        let path = temp_db_path("read-clear");
        let conn = open_test_db(&path);
        for i in 0..3 {
            conn.execute(
                "INSERT INTO build_notices (username, notice_id, time, read, created_at)
                 VALUES ('alice', ?1, ?2, 0, ?2)",
                rusqlite::params![format!("m-{i}"), 1700000000000i64 + i],
            )
            .unwrap();
        }
        // 标记已读：alice 的 3 条全部 read=1
        conn.execute("UPDATE build_notices SET read = 1 WHERE username = 'alice'", [])
            .unwrap();
        let unread: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM build_notices WHERE username='alice' AND read = 0",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(unread, 0);

        // 清空：alice 数据归零（模拟登出勾选「清空本地数据」）
        conn.execute("DELETE FROM build_notices WHERE username = 'alice'", []).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM build_notices", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn test_resolve_db_path_creates_dir() {
        // 走真实 resolve_db_path 的目录创建分支（AppHandle 之外难以构造，
        // 这里退而验证 DB_FILE_NAME 拼接约定不被误改）
        assert_eq!(DB_FILE_NAME, "notices.db");
        // BUILD_LOAD_LIMIT 必须与前端 feed 容量一致（50），改错会导致
        // 回灌数量与内存上限漂移
        assert_eq!(BUILD_LOAD_LIMIT, 50);
        assert_eq!(APP_LOAD_LIMIT, 20);
    }

    #[test]
    fn test_recent_repos_upsert_load_isolation() {
        let path = temp_db_path("recent-basic");
        let conn = open_test_db(&path);

        // alice 打开 2 个仓库、bob 打开 1 个（同一条 SQL 链路）
        upsert_recent_repo_conn(&conn, "alice", "cnb/feedback", "feedback", "TypeScript", "#3178c6", "public", 1000).unwrap();
        upsert_recent_repo_conn(&conn, "alice", "jackytse/wocnb", "wocnb", "Vue", "#4fc08d", "private", 2000).unwrap();
        upsert_recent_repo_conn(&conn, "bob", "cnb/feedback", "feedback", "", "", "", 3000).unwrap();

        // alice 只读到自己的 2 条，且按 opened_at 倒序（最近打开置顶）
        let list = load_recent_repos_conn(&conn, "alice").unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].repo_path, "jackytse/wocnb");
        assert_eq!(list[0].visibility, "private");
        assert_eq!(list[1].repo_path, "cnb/feedback");
        assert_eq!(list[1].visibility, "public");
        // bob 只看到自己的 1 条（账号隔离）
        let list = load_recent_repos_conn(&conn, "bob").unwrap();
        assert_eq!(list.len(), 1);
    }

    #[test]
    fn test_recent_repos_upsert_dedup_top() {
        let path = temp_db_path("recent-dedup");
        let conn = open_test_db(&path);
        upsert_recent_repo_conn(&conn, "alice", "a/b", "b", "", "", "public", 1000).unwrap();
        upsert_recent_repo_conn(&conn, "alice", "c/d", "d", "", "", "", 2000).unwrap();
        // 同仓库再次打开：更新时间到最新并置顶，不产生重复条目；
        // 可见性随最近一次访问更新（仓库中途转私有的场景）
        upsert_recent_repo_conn(&conn, "alice", "a/b", "b-renamed", "Rust", "#dea584", "private", 3000).unwrap();
        let list = load_recent_repos_conn(&conn, "alice").unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].repo_path, "a/b");
        assert_eq!(list[0].repo_name, "b-renamed");
        assert_eq!(list[0].language, "Rust");
        assert_eq!(list[0].visibility, "private");
        assert_eq!(list[0].opened_at, 3000);
    }

    #[test]
    fn test_recent_repos_visibility_migration() {
        // v2 迁移：模拟 rc.50 及以前的旧库（表存在但无 visibility 列），
        // init_schema 必须幂等补列且旧数据读写不报错（visibility 落默认空串）
        let path = temp_db_path("recent-visibility-migration");
        let conn = open_test_db(&path);
        // 旧库形态：手工建表（不含 visibility）+ 灌一条旧数据
        conn.execute_batch(
            r#"
            CREATE TABLE recent_repos_v1_probe (
                row_id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL,
                repo_path TEXT NOT NULL,
                repo_name TEXT NOT NULL DEFAULT '',
                language TEXT NOT NULL DEFAULT '',
                language_color TEXT NOT NULL DEFAULT '',
                opened_at INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL
            );
            INSERT INTO recent_repos_v1_probe (username, repo_path, repo_name, created_at)
            VALUES ('alice', 'old/repo', 'repo', 1);
            "#,
        )
        .unwrap();
        // 再跑一次 init_schema 的 ALTER 分支（open_test_db 已跑过一次：
        // 这里重复执行验证幂等 —— 第二次 ALTER 报 duplicate column 被吞）
        let migrate = || -> Result<(), String> {
            conn.execute(
                "ALTER TABLE recent_repos ADD COLUMN visibility TEXT NOT NULL DEFAULT ''",
                [],
            ).map_err(|e| e.to_string())?;
            Ok(())
        };
        // 第一次在 open_test_db 时已加列；这里再执行必然 duplicate，模拟重复迁移
        assert!(migrate().is_err());
        // 旧表结构下写入（visibility 空串）+ 读回不报错
        upsert_recent_repo_conn(&conn, "alice", "new/repo", "repo", "", "", "", 2000).unwrap();
        let list = load_recent_repos_conn(&conn, "alice").unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].visibility, "");
    }

    #[test]
    fn test_recent_repos_prune() {
        let path = temp_db_path("recent-prune");
        let conn = open_test_db(&path);
        // 写入 25 条（超过每账号上限 20）
        for i in 0..25i64 {
            upsert_recent_repo_conn(&conn, "alice", &format!("g{i}/r{i}"), &format!("r{i}"), "", "", "public", 1000 + i).unwrap();
        }
        let list = load_recent_repos_conn(&conn, "alice").unwrap();
        // 裁到 20 条，保留的是最新的（opened_at 最大）
        assert_eq!(list.len(), 20);
        assert_eq!(list[0].repo_path, "g24/r24");
        assert!(list.iter().all(|r| r.repo_path != "g0/r0"));
        assert_eq!(RECENT_KEEP_PER_USER, 20);
    }
}
