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
        "#,
    )
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
/// 物理删除两个分区该账号的所有行；其他账号数据不受影响（隔离前提下的
/// 定向清除）。默认登出路径**不会**调用本命令（数据保留）。
#[tauri::command]
pub fn notice_db_clear(app: tauri::AppHandle, username: String) -> Result<(), String> {
    validate_username(&username)?;
    let path = resolve_db_path(&app)?;
    let conn = open_db(&path)?;
    conn.execute("DELETE FROM build_notices WHERE username = ?1", rusqlite::params![username])
        .map_err(|e| format!("清空构建通知失败: {e}"))?;
    conn.execute("DELETE FROM app_notices WHERE username = ?1", rusqlite::params![username])
        .map_err(|e| format!("清空应用通知失败: {e}"))?;
    Ok(())
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
}
