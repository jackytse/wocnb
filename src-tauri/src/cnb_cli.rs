//! cnb-cli 集成：OAuth 设备授权登录 + CLI 生命周期管理。
//!
//! 设计决策（依据主理人拍板的四项决策，2026-10）：
//! 1. 登录走 cnb-cli 的 OAuth2 设备授权流（spawn `cnb login`），不注册
//!    OAuth 应用、不内嵌 ClientSecret；
//! 2. CLI 来源：优先检测系统已安装的 cnb（PATH + 应用数据目录），没有则
//!    自动下载官方原生二进制到应用数据目录（URL 规律依据官方 install.sh）；
//! 3. cnb-cli 只负责登录与令牌生命周期，应用内 API 请求仍走现有
//!    `cnb_http_request` 通道（Rust 侧不把 CLI 当 API 通道）；
//! 4. 令牌持久化位置与 CLI 保持一致：`~/.cnb/token`（0600），两端共享登录态。
//!
//! CLI 行为依据（实测 cnb 1.18.3 + 读取 @cnbcool/cnb-cli dist/index.js 源码）：
//! - `cnb login --host cnb.cool` 非交互（stdout 管道）输出格式（实测原文）：
//!   `"\n请打开以下链接完成授权：\n  https://cnb.cool/oauth2/device/verify?user_code=XXXX\n\n(已尝试自动打开浏览器，若未打开请手动复制上方链接)\n正在等待授权...\n\n登录成功 🎉\n"`
//!   —— 验证链接（verification_uri_complete）内嵌 user_code 查询参数；
//! - CLI 拿到设备码后会自行尝试打开系统浏览器（tryOpenBrowser：darwin `open` /
//!   linux `xdg-open` / win32 `start`，dist/index.js @1284853 附近），因此前端
//!   **不**再自动打开验证页（避免重复开两个标签页），仅提供手动打开按钮兜底；
//! - 令牌刷新（refreshAccessToken，dist/index.js @948223 附近）：POST
//!   `{platform_url}/oauth2/token`，form `grant_type=refresh_token` +
//!   `refresh_token` + `client_id` —— 设备流 client 无 secret，**不用** Basic
//!   认证；响应含 access_token / expires_in / refresh_token（可选）；
//! - 令牌文件（getTokenPath，dist/index.js @943693 附近）：`homedir/.cnb/token`，
//!   JSON `{ "auths": { "<host>": { access_token, refresh_token?, expires_at,
//!   platform_url, client_id, login_host } } }`（2 空格缩进、0600 权限）；
//!   另兼容旧版扁平格式（access_token 在顶层，CLI readTokenFile 同样兼容）。
//!
//! 安全约束：
//! - 所有令牌值只在 Rust ↔ 前端 IPC 间流转，任何 log/println 均不输出；
//! - 子进程 stdout/stderr 按不可信文本处理：仅做展示与解析，绝不执行；
//! - 命令参数全部为编译期常量，无用户可控的路径/参数注入面。
//!
//! # 修复记录：登录报"未能从 cnb login 输出中解析授权链接，原始输出：空"
//!
//! ## 现象
//! 点击"使用 CNB 账号授权登录"后必然失败，错误信息中 `原始输出：` 后完全空白
//! （一个字符都没有）。这不是"CLI 没输出"，而是应用**没拿到**输出。
//!
//! ## 根因（已验证）
//! stdout 读取线程用的是 `Read::read_to_string`，该调用的语义是"一直读到
//! EOF"。子进程管道的 EOF 只在 `cnb login` 退出（进程终止、句柄关闭）时
//! 才出现，因此**在 CLI 存活等待授权的整段时间里，共享缓冲区恒为空串**。
//! 上层每 100ms 轮询该缓冲区找链接 → 必然空转满 10s → 报"输出为空"。
//!
//! 为什么此前自测没发现：自测用例是"spawn 后 8 秒 kill，再检查缓冲区"——
//! kill 之后 EOF 才触发，读取线程这才把整段文本写入缓冲区，于是看到"输出
//! 完整、可以解析"的假象。真实的 10s 等待窗口内缓冲区一直是空的。
//!
//! 复现/验证方式：同一份脚本、同一时序，`read_to_string` 在子进程存活 1.5s
//! 后 buffer len = 0（脚本早已写出 97 字节），子进程退出后才变成 97；
//! 换成 `fill_buf` 增量读取后，0.8s 时 buffer 已含全部 97 字节。
//!
//! ## 修复要点
//! 1. **增量读取**（`pump_reader`）：`BufReader::fill_buf` 拿到"当前可用字节"
//!    立即投递给上层，不等待换行、更不等待 EOF；UTF-8 边界用
//!    `Utf8ChunkDecoder` 跨块拼接，中文文案不会被切坏。
//! 2. **解析前剥离 ANSI**（`strip_ansi`）：CLI 着色时链接行首会带 `\x1b[36m`，
//!    `trim()` 去不掉转义序列，会导致 `starts_with("https://")` 判假。
//! 3. **提前退出不空等**（`wait_for_login_link`）：子进程秒退（如 shim 报错）
//!    时立即返回，并把退出状态写进错误信息。
//! 4. **部分输出追加等待**：10s 内只打印了标题行时再给 5s 宽松窗口，
//!    避免"差一步成功"被误判失败。
//! 5. **诊断信息补强**（`cli_login_error_message`）：错误信息统一带上
//!    CLI 路径 / 版本 / 子进程状态 / stdout / stderr，空流显式标注 `<空>`。
//! 6. **环境差异兜底**（`resolved_path_env` / `probe_cli`）：GUI 进程继承的
//!    PATH 常只有 `/usr/bin:/bin:/usr/sbin:/sbin`，既可能找不到用户装的 cnb，
//!    也会让 `#!/usr/bin/env node` 的 JS shim 找不到 node。现改为"当前 PATH ∪
//!    登录 shell PATH ∪ node 运行时目录"，并在检测阶段就识别/降级不可用的 shim。
//!
//! # 修复记录（Round 2，QA 回归后）
//!
//! QA 判定核心修复（增量读取）有效，另发现 4 个 P2，均已修复：
//!
//! - **Q-1 EINTR 被当成 EOF**：`pump_reader` 原先 `Err(_) => break`，
//!   一次信号打断就永久停止捕获该流，后续输出（含验证链接）全丢，
//!   错误信息退化成 `stdout: <空>` —— 与原始 bug 症状无法区分，会把排查
//!   带偏。现改为 `Interrupted => continue`（连续 100 次才放弃，防死循环）。
//! - **Q-2 成功分支丢弃 Child → 僵尸**：`try_wait` 只回收已退出的子进程；
//!   登录成功时 CLI 常还在收尾，直接 drop 会留下 `<defunct>`。应用常驻
//!   托盘，泄漏会累积。现交由 `reap_child_in_background`（只 wait 不 kill，
//!   避免误杀正在写 `~/.cnb/token` 的进程）。
//! - **Q-3 PATH 探测阻塞 async worker**：`path_lookup` → `login_shell_path`
//!   会同步 spawn shell（最坏 3×3s）。现整体放进 `spawn_blocking`，
//!   且备选 shell 的超时降到 1s（首个 shell 保 3s，可能是用户的真实登录
//!   shell，含 nvm 等重逻辑）。
//! - **Q-4 登录 shell stdout 污染 PATH**：`.zprofile` 里的 echo 会与
//!   `printf %s "$PATH"` 黏连（实测出现 `.../Python/3.9/bineval` 这种坏项），
//!   且 PATH 里带裸 `.`（`path_lookup` 会去查 `<CWD>/cnb`，是 PATH 劫持面）。
//!   现改用哨兵包裹解析（`extract_sentinel_path`，找不到标记即视为探测失败）
//!   + 只接受绝对路径项（`is_usable_path_entry`）。
//!
//! 上述 4 项都有单测锁定（含 QA 的 EINTR 用例已从 `#[ignore]` 转为回归锁）。
//!
//! # 修复记录（Round 3）：旧版 cnb CLI 不支持 `--host`，登录/退出秒退
//!
//! ## 现象
//! 用户点击"使用 CNB 账号授权登录"报错：
//! `Authorization failed 未能从 cnb login 输出中解析授权链接（CLI:
//! ~/.vite-plus/bin/cnb, 版本: 1.10.16, 状态: 已退出, exit code=1）,
//! stdout: <空>, stderr: error: unknown option '--host' (Did you mean --short?)`
//!
//! ## 根因（主理人静态排查 + 实测确认）
//! 用户的 cnb 是 vite-plus 捆绑的 1.10.16（原生二进制 symlink），其 `login`
//! 和 `logout` 子命令**都没有** `--host` 选项（`cnb login --help` 实测，选项
//! 只有 --client-id/--woa/--debug），传了即报 "unknown option '--host'" 并
//! exit 1；较新版本（如 1.18.3）才支持 --host。本模块此前硬编码
//! `login --host cnb.cool`，于是用户环境的旧版 CLI 在调用 requestDeviceCode
//! **之前**就被参数解析器拒绝，stdout 为空、只有 stderr 有线索 —— 恰好落进
//! "解析不到链接"的失败分支。
//!
//! 支撑"降级重试"正确性的三个关键事实（均已实测/读源码确认）：
//! - 1.10.16 不带 --host 时默认 platform_url 就是 "https://cnb.cool"
//!   （dist 源码：`platformURL: t.woa ? "https://cnb.woa.com" : "https://cnb.cool"`），
//!   与本模块 `CNB_LOGIN_HOST` 常量一致 —— 去掉 --host **不改变登录目标**；
//! - 1.10.16 的 login 输出格式与 1.18.3 完全一致（"请打开以下链接完成授权："
//!   + verification_uri_complete），`parse_login_output` 无需改动；
//! - 1.10.16 写的令牌文件是旧版扁平格式（access_token 等在顶层），
//!   `read_token_entry` 已兼容，无需改动。
//!
//! ## 修复要点
//! 1. **--host 参数自适应降级**（`spawn_login_session` + `login_can_retry_without_host`）：
//!    首选仍带 `--host cnb.cool` spawn；当 `wait_for_login_link` 返回
//!    parsed=None，且①子进程已退出且非零码 ②stderr 含 "unknown option"
//!    （不区分大小写，放宽匹配 "did you mean"，见 `is_unknown_option_failure`）
//!    时，清理旧会话后**不带 --host 重新 spawn 并重走等待逻辑（只重试一次）**。
//! 2. **降级无副作用论证**：首次 spawn 因参数解析错误在 CLI 调用
//!    requestDeviceCode **之前**就退出 —— 没有消耗设备码、没有打开浏览器、
//!    没有写 ~/.cnb/token；重试是一次完全干净的全新 spawn。
//! 3. **诊断注明降级**：降级重试成功/失败的输出/错误信息中注明"已按旧版
//!    CLI（不支持 --host）降级重试"，便于用户理解日志里为何有两次启动。
//! 4. **logout 同样降级**：`cnb logout --host` 非零退出且 stderr 含
//!    unknown option 时去掉 --host 重试一次；旧版不带 --host 删除的是其
//!    默认平台（即 cnb.cool）的令牌，且随后的 `remove_token_entry` 兜底
//!    仍会直接清理 ~/.cnb/token 条目，行为可接受。
//! 5. **回归锁**：`is_unknown_option_failure` / `login_can_retry_without_host`
//!    共 8 个单测 + 假 cnb 脚本端到端降级用例（脚本模拟"带 --host 报错秒退 /
//!    不带 --host 正常打印链接"两种行为，绝不触碰真实 CLI 与令牌文件）。
//!
//!
//! # 登录时序（线程与锁的分配，便于排查死锁/竞态）
//!
//! ```text
//!   前端 (WebView)              Rust 命令线程               后台线程
//!   ────────────                ─────────────               ────────
//!   invoke(cnb_cli_login) ──►   resolve_cli
//!                                 ├─ path_lookup（resolved_path_env 缓存）
//!                                 ├─ probe_cli（is_node_shim + --version）
//!                                 └─ app_cli_path 兜底
//!                               spawn(cnb login)  ─────────► [子进程]
//!                               spawn_output_reader(stdout) ► 读线程 A
//!                               spawn_output_reader(stderr) ► 读线程 B
//!                               sessions.insert(handle)         │
//!                               spawn_blocking(wait_for_login_link)
//!                                 └─ 每 100ms：snapshot(stdout_buf)
//!                                    ├─ parse_login_output → 命中即返回
//!                                    └─ session_exit_status → 退出即返回
//!   ◄── Ok(CliLoginStart)                                     │
//!   invoke(cnb_cli_login_poll, handle) 每 2s ─► 读 ~/.cnb/token
//!                                              ├─ 新令牌 → success
//!                                              └─ 子进程已退出 → failed
//!   invoke(cnb_cli_cancel_login) ─► kill + wait + 移除会话
//! ```
//!
//! 锁的使用（只有两把，且都不嵌套）：
//! - `LOGIN_SESSIONS`：会话表，仅做插入/查询/移除，临界区里不做 I/O；
//! - 每个输出缓冲区的 `Mutex<String>`：写线程追加、命令线程克隆快照，
//!   临界区里只做内存拷贝（`snapshot`）。
//! 读线程与等待循环之间没有锁顺序依赖，因此不存在死锁路径。
//!
//! # 已知限制（有意为之，不是遗漏）
//! 1. 只在"输出中出现链接"这一刻判成功；若官方 CLI 改版把链接改到 stderr
//!    输出，需要同步调整 `parse_login_output` 的输入来源（错误信息里的
//!    stdout/stderr 双份摘录正是为此留的排查线索）。
//! 2. `resolved_path_env` 只问一次登录 shell（进程内缓存）：用户在应用运行
//!    期间修改 shell 配置需重启应用才生效 —— 换取"不重复 spawn shell"的开销。
//! 3. 应用不会替用户写入 `~/.cnb/token`（除刷新后续期外）：授权成功以 CLI
//!    写入令牌文件为准，避免两端状态撕裂。
//!
//! 以下为 QA（Round 2）登记、经评估可延后的 P3 项，记录在此以免被遗忘：
//! 4. `run_version_check` 超时后只放弃等待，不 kill 探测线程：卡死的二进制
//!    会让该线程滞留到进程退出（最坏情况一次检测泄漏一个线程）。改动需要
//!    引入线程可中断机制，成本远高于收益，故仅声明。
//! 5. `session_exit_status` 吞掉 `try_wait` 的 Err（按"仍在运行"处理）：
//!    极端情况下会让等待循环多跑一个窗口，但不会误判成功；错误已由
//!    poll 命令内的显式 `try_wait` 上报给前端。
//! 6. 应用退出时不主动 kill 未结束的 login 会话：这类进程会在应用退出后
//!    被 init 接管并自行结束（`cnb login` 有设备码有效期），无资源泄漏。
//! 7. `is_node_shim` 只识别 shebang 形式的 Node 脚本：其他解释器包装
//!    （如 `#!/bin/sh` 再 exec node）识别不到，只能靠 `--version` 探测兜住。


use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use tauri::Manager;

// ---------------------------------------------------------------------------
// 常量
//
// 分组：登录目标 / 令牌文件位置 / 官方发布地址 / 时间窗口。
// 所有时间窗口的取值理由都写在注释里 —— 这些数字是与 CLI 实测行为绑定
// 的调参点，改之前请先确认对应的实测结论是否仍然成立。
// ---------------------------------------------------------------------------

/// 应用登录目标 host（令牌文件中 auths 的键，与 CLI normalizeTokenHost 结果一致）
const CNB_LOGIN_HOST: &str = "cnb.cool";
/// 令牌文件相对主目录的路径（与 CLI getTokenPath 保持一致：~/.cnb/token）
const TOKEN_DIR_NAME: &str = ".cnb";
const TOKEN_FILE_NAME: &str = "token";
/// 官方原生二进制发布地址规律（依据官方 install.sh：
/// REPO_BASE/latest/download/cnb-{os}-{arch}[.exe]，os ∈ darwin/linux/windows，
/// arch ∈ x64/arm64）
const CLI_RELEASE_BASE: &str =
    "https://cnb.cool/cnb/skills/cnb-skill/-/releases/latest/download";
/// 官方安装指引页（自动安装失败时给用户的手动兜底入口）
const CLI_MANUAL_GUIDE_URL: &str = "https://cnb.cool/cnb/skills/cnb-skill";
/// 临近过期阈值：10 分钟（超过该阈值即提前刷新，避免请求途中失效）
const REFRESH_MARGIN_SECS: i64 = 600;
/// 等待 cnb login 打印验证 URL 的兜底时限（实测 <1s 即输出，留足余量）
const LOGIN_OUTPUT_WAIT_MS: u64 = 10_000;
/// 宽松追加等待时限：10s 窗口内已有部分输出（如只打印了标题行）但尚无链接时，
/// 再等这么久才判失败 —— 避免"差一步就成功"被误杀
const LOGIN_OUTPUT_EXTRA_WAIT_MS: u64 = 5_000;
/// 轮询间隔：越短越早发现链接，100ms 对 CPU/锁竞争几乎无感
const LOGIN_POLL_INTERVAL_MS: u64 = 100;
/// 子进程输出捕获的内存上限（超出后丢弃后续内容，防止异常子进程吃满内存）。
/// 注意：这不是展示截断 —— 展示截断仍由 truncate_chars 按字符数负责。
const MAX_CAPTURE_BYTES: usize = 64 * 1024;
/// 登录 shell PATH 探测超时（防 .zprofile 里的慢逻辑卡住检测流程）。
/// 首个 shell 可能是用户的真实登录 shell，给足时间；后续备选 shell 只做兜底，
/// 用更短的超时避免"三个 shell 各卡 3s"累计成 9s 的界面空白。
const PATH_PROBE_TIMEOUT_MS: u64 = 3_000;
/// 备选 shell（bash/sh）的 PATH 探测超时
const PATH_PROBE_TIMEOUT_FALLBACK_MS: u64 = 1_000;
/// 连续 EINTR 上限：超过即认为该流不可用（见 pump_reader 注释）
const MAX_CONSECUTIVE_INTERRUPTS: u32 = 100;
/// --version 验证可执行性的超时（防悬挂二进制卡死检测流程）
const VERSION_CHECK_TIMEOUT_MS: u64 = 5_000;

// ---------------------------------------------------------------------------
// 纯函数层（便于单元测试，不依赖网络/进程/Tauri）
// ---------------------------------------------------------------------------

/// 从令牌文件原文解析当前生效的登录条目。
///
/// 兼容两种格式（与 CLI readTokenFile 的兼容逻辑一致）：
/// 1. 新格式：`{ "auths": { "<host>": {...} } }` —— 优先精确取 `cnb.cool`
///    键，取不到时取任意第一条有效条目（防御 host 键命名差异）；
/// 2. 旧版扁平格式：access_token 等字段直接在顶层。
///
/// 校验规则：
/// - access_token 必须存在且非空字符串，否则整体视为无效（返回 None）；
/// - expires_at 缺失或非数字（如字符串）→ 记 0（已过期），绝不猜测值 ——
///   过期令牌会走刷新/重新授权分支，比"拿着无法判断有效期的令牌"更安全。
pub(crate) fn parse_token_file(text: &str) -> Option<CnbTokenEntry> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    if let Some(auths) = value.get("auths").and_then(|v| v.as_object()) {
        // 优先精确匹配应用登录目标 host
        if let Some(entry) = auths.get(CNB_LOGIN_HOST).and_then(|v| v.as_object()) {
            if let Some(parsed) = parse_token_entry(entry) {
                return Some(parsed);
            }
        }
        // 兜底：任意第一条有效条目（多 host 场景下 CLI 也有类似优先级逻辑）
        for entry in auths.values() {
            if let Some(parsed) = entry.as_object().and_then(parse_token_entry) {
                return Some(parsed);
            }
        }
        return None;
    }
    // 旧版扁平格式
    parse_token_entry(value.as_object()?)
}

/// 从单个登录条目对象解析令牌字段（parse_token_file 的子步骤，独立成函数
/// 便于两种格式复用同一套字段校验）
fn parse_token_entry(entry: &serde_json::Map<String, serde_json::Value>) -> Option<CnbTokenEntry> {
    let access_token = entry
        .get("access_token")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())?
        .to_string();
    // expires_at：仅接受数字；缺失/字符串/浮点一律记 0（已过期，走刷新分支）
    let expires_at = entry.get("expires_at").and_then(|v| v.as_i64()).unwrap_or(0);
    let refresh_token = entry
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(String::from);
    let platform_url = entry
        .get("platform_url")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let client_id = entry
        .get("client_id")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let login_host = entry
        .get("login_host")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    Some(CnbTokenEntry {
        access_token,
        refresh_token,
        expires_at,
        platform_url,
        client_id,
        login_host,
    })
}

/// 令牌文件中的单个登录条目（字段名与 CLI 写入格式完全一致，snake_case）
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct CnbTokenEntry {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: i64,
    pub platform_url: String,
    pub client_id: String,
    pub login_host: String,
}

/// 过期判定：令牌已过期，或距过期不足 margin_secs 秒（需提前刷新）。
///
/// 语义：`now >= expires_at - margin` 即视为临期。
/// 临界点：now == expires_at - margin 时已算临期（提前刷新优先于压哨使用）。
pub(crate) fn is_token_expired_or_expiring(expires_at: i64, now_secs: i64, margin_secs: i64) -> bool {
    // saturating_sub 防御 expires_at 为负/极小值时的 i64 下溢
    now_secs >= expires_at.saturating_sub(margin_secs)
}

/// 当前 Unix 时间（秒）。clock 回拨等异常时返回 0（视作一切令牌未过期，
/// 宁可少刷新也不误清登录态）。
/// 当前 Unix 时间戳（秒）。取不到系统时间时返回 0（调用方按"已过期"处理，
/// 走刷新或重新授权分支，而不是给一个看起来永不过期的假值）。
fn now_unix_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 按官方 install.sh 的命名规律构造原生二进制文件名。
///
/// os: macos|darwin → darwin；linux → linux；windows → windows（带 .exe）。
/// arch: x86_64 → x64；aarch64 → arm64。
/// 不认识的 os/arch 返回 Err（由调用方给出可读错误，绝不下载错误架构产物）。
///
/// 为什么严格拒绝未知组合而不是"猜一个最接近的"：下载到错误架构的二进制
/// 在被执行时才失败（macOS 上是 "bad CPU type in executable"），
/// 报错点离病因很远；提前拒绝能给出可操作的提示。
pub(crate) fn cli_download_filename(os: &str, arch: &str) -> Result<String, String> {
    let os_name = match os {
        "macos" | "darwin" => "darwin",
        "linux" => "linux",
        "windows" => "windows",
        other => return Err(format!("不支持的操作系统: {other}")),
    };
    let arch_name = match arch {
        "x86_64" | "amd64" => "x64",
        "aarch64" | "arm64" => "arm64",
        other => return Err(format!("不支持的 CPU 架构: {other}")),
    };
    let exe_suffix = if os_name == "windows" { ".exe" } else { "" };
    Ok(format!("cnb-{os_name}-{arch_name}{exe_suffix}"))
}

/// 从 `cnb login` 的 stdout 原文中解析（验证链接, 用户码）。
///
/// 解析规则（依据实测输出格式，见模块注释）：取第一个以 http(s):// 开头的
/// 行（trim 后），user_code 从其 query 参数提取（verification_uri_complete
/// 内嵌 user_code，形如 ?user_code=XXXX）。
///
/// 兼容性处理（本次修复新增）：
/// - 解析前先 `strip_ansi` 剥离 ANSI 转义序列 —— CLI 着色时行首会带
///   `\x1b[36m`，`trim()` 去不掉它，`starts_with("https://")` 会判假；
/// - `trim()` 同时吃掉行首缩进（实测链接前有两个空格）与行尾 `\r`。
///
/// 解析失败返回 None（输出格式变化时上层给出含原文的错误，便于排查）。
pub(crate) fn parse_login_output(output: &str) -> Option<(String, String)> {
    let cleaned = strip_ansi(output);
    for line in cleaned.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("https://") || trimmed.starts_with("http://") {
            let user_code = extract_query_param(trimmed, "user_code").unwrap_or_default();
            return Some((trimmed.to_string(), user_code));
        }
    }
    None
}

/// 剥离 ANSI 转义序列（CSI / OSC / 两字节序列）。
///
/// 为什么必须做：`cnb login` 的输出在着色环境下会带控制序列，
/// 典型形态 `\x1b[36mhttps://cnb.cool/...\x1b[0m`。`trim()` 只处理空白，
/// 序列仍在行首 → `starts_with("https://")` 判假 → 有链接也解析失败。
/// 同时用于清洗错误信息（控制字符直接塞进弹窗会显示成乱码/花屏）。
///
/// 实现（手写状态机，不引第三方正则依赖）：
/// - CSI：`ESC [` 后跟参数字节 0x30-0x3F、中间字节 0x20-0x2F，
///   以终止字节 0x40-0x7E 结束；
/// - OSC：`ESC ]` 后跟任意内容，以 BEL(0x07) 或 `ESC \` 结束；
/// - 其余 `ESC x`：按两字节序列吞掉。
pub(crate) fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        // 非 ESC：原样保留（含 \n、中文等）
        if ch != '\u{1b}' {
            out.push(ch);
            continue;
        }
        match chars.next() {
            // CSI 序列：吞到终止字节为止
            Some('[') => {
                for next in chars.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&next) {
                        break;
                    }
                }
            }
            // OSC 序列：吞到 BEL 或 ESC\ 为止
            Some(']') => {
                while let Some(next) = chars.next() {
                    if next == '\u{7}' {
                        break;
                    }
                    if next == '\u{1b}' && chars.peek() == Some(&'\\') {
                        chars.next();
                        break;
                    }
                }
            }
            // 两字节序列（ESC + 单字符）或输入以 ESC 结尾：全部吞掉
            _ => {}
        }
    }
    out
}

/// 判断可执行文件头部是否是 Node 脚本（`#!/usr/bin/env node` 一类 shebang）。
///
/// 局限（见模块头「已知限制」第 7 条）：只认 shebang 声明，
/// `#!/bin/sh` 再 exec node 这类包装识别不到，由后续 `--version` 探测兜底。
///
/// 为什么需要识别：系统里的 `cnb` 很可能是 npm 装的 JS shim，能否启动完全
/// 取决于 PATH 里有没有 `node`。macOS 从 Finder 启动的 .app 继承的 PATH
/// 通常只有 `/usr/bin:/bin:/usr/sbin:/sbin` —— 不含 nvm/homebrew 的 node 目录，
/// `/usr/bin/env node` 立刻失败（stdout 为空、stderr 一行 env 报错），
/// 与本次 bug 的"原始输出为空"现象完全一致。因此检测阶段必须识别出来，
/// 优先降级到应用数据目录里的原生二进制。
///
/// 只检查头部（解释器声明必在首行），参数为待检查的前若干字节。
pub(crate) fn is_node_script(head: &[u8]) -> bool {
    let first_line = head.split(|byte| *byte == b'\n').next().unwrap_or(&[]);
    if !first_line.starts_with(b"#!") {
        return false;
    }
    // 兼容 `#!/usr/bin/env node` / `#!/usr/bin/node` / `#!/usr/local/bin/node`
    String::from_utf8_lossy(first_line)
        .to_ascii_lowercase()
        .contains("node")
}

/// 读取文件头部若干字节判断是否为 Node 脚本（I/O 失败按"不是"处理，
/// 后续 `--version` 探测会兜住真正不可执行的情况）。
fn is_node_shim(path: &Path) -> bool {
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let mut head = [0u8; 512];
    match file.read(&mut head) {
        Ok(read) => is_node_script(&head[..read]),
        Err(_) => false,
    }
}

/// 从 URL 原文中提取指定 query 参数值（不 decode：user_code 为字母数字，
/// CLI 输出的是未编码原文）。
///
/// 复杂度说明：`split_once('?')` 取第一段 query，遇 `&` 逐段比对 key。
/// 遇到不含 `=` 的畸形片段直接返回 None（宁可判"无设备码"，
/// 也不要从一个畸形 URL 里猜出半个设备码）。
fn extract_query_param(url: &str, key: &str) -> Option<String> {
    let query = url.split_once('?')?.1;
    for pair in query.split('&') {
        let (k, v) = pair.split_once('=')?;
        if k == key {
            return Some(v.to_string());
        }
    }
    None
}

/// 按字符数安全截断（避免多字节中文被按字节切出乱码），用于错误信息摘录
/// 子进程原文 —— 原文按不可信文本处理，只截断展示、绝不执行
fn truncate_chars(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let head: String = text.chars().take(max_chars).collect();
    format!("{head}…")
}

// ---------------------------------------------------------------------------
// 子进程状态与诊断信息（纯数据 + 纯函数，便于单元测试）
// ---------------------------------------------------------------------------

/// 子进程状态（与 std 的 ExitStatus 解耦，便于纯函数单测）
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum ProcessState {
    /// 仍在运行（等待窗口内未退出）
    Running,
    /// 已退出：code 为退出码（被信号终止时为 None），signal 为信号编号
    Exited { code: Option<i32>, signal: Option<i32> },
}

impl ProcessState {
    /// 人类可读的状态描述（直接进错误信息，供用户/支持人员判断卡点）
    pub(crate) fn describe(&self) -> String {
        match self {
            ProcessState::Running => "进程仍在运行（未退出）".to_string(),
            ProcessState::Exited {
                code: Some(code), ..
            } => format!("已退出, exit code={code}"),
            ProcessState::Exited {
                code: None,
                signal: Some(signal),
            } => format!("已退出, signal={signal}（被信号终止）"),
            ProcessState::Exited {
                code: None,
                signal: None,
            } => "已退出（退出状态未知）".to_string(),
        }
    }
}

/// 把 std 的退出状态转成纯数据（unix 下区分"被信号杀"与"正常退出码"）。
/// `None` 表示进程仍在运行。
pub(crate) fn process_state_of(status: Option<ExitStatus>) -> ProcessState {
    let Some(status) = status else {
        return ProcessState::Running;
    };
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        ProcessState::Exited {
            code: status.code(),
            signal: status.signal(),
        }
    }
    #[cfg(not(unix))]
    {
        ProcessState::Exited {
            code: status.code(),
            signal: None,
        }
    }
}

/// 摘录输出流内容：空内容显式标注 `<空>`。
///
/// 为什么要标注：本次 bug 的症状就是错误信息里"原始输出："后面完全空白，
/// 让人无法判断是"真的没输出"还是"输出被吞了"。显式 `<空>` 能立刻区分。
fn describe_stream(text: &str) -> String {
    let trimmed = strip_ansi(text).trim().to_string();
    if trimmed.is_empty() {
        "<空>".to_string()
    } else {
        truncate_chars(&trimmed, 300)
    }
}

/// 组装 `cnb login` 失败的完整诊断信息（唯一出口，保证各失败分支信息一致）。
///
/// 为什么要把 CLI 路径 / 版本 / 退出状态都带上：现象"输出为空"至少有三种
/// 完全不同的成因 —— ① 输出读取被阻塞（缓冲区永远空）；② JS shim 找不到
/// node（进程秒退，只有 stderr 有线索）；③ CLI 打印格式变化。只有把
/// stderr 尾部与退出状态一起透出，排查才能一步到位。
///
/// 安全约束：CLI 路径与版本号不含令牌，可安全展示；stdout/stderr 按不可信
/// 文本处理，只截断展示（300 字符），绝不执行。
pub(crate) fn cli_login_error_message(
    reason: &str,
    cli_path: &str,
    version: &str,
    state: ProcessState,
    stdout: &str,
    stderr: &str,
) -> String {
    format!(
        "{reason}（CLI: {cli_path}, 版本: {version}, 状态: {}），stdout: {}，stderr: {}",
        state.describe(),
        describe_stream(stdout),
        describe_stream(stderr),
    )
}

// ---------------------------------------------------------------------------
// 子进程输出捕获（增量读取）
// ---------------------------------------------------------------------------

/// 增量 UTF-8 解码器：把分块到达的字节流安全拼成字符串。
///
/// 为什么需要：按块读取时块边界可能落在多字节字符中间（CLI 文案含中文），
/// 对每块单独 `from_utf8_lossy` 会产生 U+FFFD 乱码。本结构把"末尾不完整的
/// 多字节前缀"留到下一块一起解码，保证中文不被打碎。
///
/// 状态机只有两个出口：
/// - `Ok`：整块合法 → 全部取走；
/// - `Err(valid_up_to = n)`：前 n 字节合法可取；若 `error_len` 为 Some 说明
///   剩下的是**真非法**字节（用 lossy 消化掉，否则会永久卡住后续内容），
///   为 None 说明只是"字符被截断"（保留等下一块）。
#[derive(Default)]
struct Utf8ChunkDecoder {
    /// 尚未构成完整字符的尾部字节（理论上 ≤3 字节）
    pending: Vec<u8>,
}

impl Utf8ChunkDecoder {
    /// 喂入一块字节，返回当前已能确定解码的文本（可能为空串）
    fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut out = String::new();
        match std::str::from_utf8(&self.pending) {
            // 整块都是合法 UTF-8：直接取走
            Ok(text) => {
                out.push_str(text);
                self.pending.clear();
            }
            Err(err) => {
                let valid = err.valid_up_to();
                if valid > 0 {
                    // valid_up_to 保证前 valid 字节是合法 UTF-8，可直接取用
                    if let Ok(text) = std::str::from_utf8(&self.pending[..valid]) {
                        out.push_str(text);
                    }
                    self.pending.drain(..valid);
                }
                if err.error_len().is_some() {
                    // 真实非法字节（非"截断"）：用 lossy 替换消化，
                    // 否则这些字节会永久卡在 pending 里导致后续内容全丢
                    out.push_str(&String::from_utf8_lossy(&self.pending));
                    self.pending.clear();
                }
                // error_len() == None → 末尾是被截断的多字节字符，保留等下一块
            }
        }
        // 防御：正常情况 pending ≤3 字节，异常输入下也绝不让它无限增长
        if self.pending.len() > 8 {
            self.pending.clear();
        }
        out
    }

    /// 流结束：残留的不完整字节按 lossy 输出（宁可显示替换字符也不丢内容）
    fn finish(&mut self) -> String {
        let tail = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        tail
    }
}

/// 从 reader 中增量泵出输出，每读到一块立即回调 sink。
///
/// ⚠️ 本函数是本次 bug 的核心修复点，**绝不能**退回 `Read::read_to_string`：
/// `read_to_string` 语义是"一直读到 EOF"，而 EOF 只在子进程退出并关闭管道
/// 时才出现 —— 因此 `cnb login` 存活期间缓冲区永远是空字符串，上层轮询
/// 解析必然空转到超时（现象：错误信息里"原始输出："后一片空白）。
/// 这里用 `BufReader::fill_buf` 拿到"当前可用字节"就立刻交给 sink，
/// 不等待换行、更不等待 EOF，链接在打印出来后亚秒级即可见。
///
/// 用 fill_buf 而非 read_until 的原因：若 CLI 打印不带换行的片段
/// （如进度提示），read_until 会一直阻塞到换行/EOF，仍会漏掉中间输出。
fn pump_reader<R: Read>(reader: &mut R, sink: &mut dyn FnMut(&str)) {
    let mut buffered = BufReader::new(reader);
    let mut decoder = Utf8ChunkDecoder::default();
    // 连续 EINTR 计数：正常信号打断是瞬态的，连续上百次说明底层已不可用
    // （或对端一直被打断），此时必须退出，否则读线程会无限空转
    let mut consecutive_interrupts: u32 = 0;
    loop {
        // fill_buf 返回内部缓冲中"已读到但未消费"的字节；空切片即 EOF
        let available = match buffered.fill_buf() {
            Ok(bytes) if bytes.is_empty() => break,
            Ok(bytes) => {
                consecutive_interrupts = 0;
                bytes
            }
            // EINTR（被信号打断）**不是**流结束：必须重试。
            // 为什么关键：当成 EOF 提前退出会让整条流永久停止捕获 ——
            // 之后包括验证链接在内的所有输出全部丢失，错误信息退化成
            // `stdout: <空>`，与"输出被阻塞"这个原始 bug 的症状无法区分，
            // 排查方向会被带偏。qt/GTK 事件循环、调试器附加、SIGWINCH
            // 都可能触发 EINTR。
            Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => {
                consecutive_interrupts += 1;
                if consecutive_interrupts >= MAX_CONSECUTIVE_INTERRUPTS {
                    break;
                }
                continue;
            }
            // 其他读错误（管道被关闭等）：终止读取，已捕获内容保留
            Err(_) => break,
        };
        let consumed = available.len();
        let text = decoder.push(available);
        if !text.is_empty() {
            sink(&text);
        }
        buffered.consume(consumed);
    }
    // EOF：把末尾残留的截断字节也交给 sink（不丢内容）
    let tail = decoder.finish();
    if !tail.is_empty() {
        sink(&tail);
    }
}

/// 启动后台线程增量读取子进程的一个输出管道，累积到共享缓冲区。
///
/// 输出按不可信文本处理：只累积原文，供解析与失败时摘录展示，
/// 任何一个字节都不会被解释为命令或路径。
///
/// 线程自然随管道 EOF（子进程退出）结束，无需 join：登录流程只依赖
/// 缓冲区内容，不依赖读线程存活。这也意味着"子进程已退出"之后，
/// 缓冲区可能还有最后一小段在路上 —— 因此等待循环在探测到退出后
/// 会短暂 sleep 再抓一次快照（见 wait_for_login_link）。
fn spawn_output_reader<R>(reader: R, buf: Arc<Mutex<String>>)
where
    R: Read + Send + 'static,
{
    std::thread::spawn(move || {
        let mut reader = reader;
        pump_reader(&mut reader, &mut |text| {
            let mut guard = buf.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            // 超过上限后只保留前缀（解析与展示都只需开头），避免内存无限增长
            if guard.len() < MAX_CAPTURE_BYTES {
                guard.push_str(text);
            }
        });
    });
}

/// 读取共享缓冲区的当前快照（Mutex 中毒时取内层数据：
/// 子进程输出只是展示/解析用，中毒不应连累登录流程）。
///
/// 返回克隆而非加锁后的引用：调用方（解析/错误信息组装）会在持锁情况下
/// 做字符串处理，克隆可以把临界区压缩到一次内存拷贝，避免读线程被饿死。
fn snapshot(buf: &Arc<Mutex<String>>) -> String {
    buf.lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

// ---------------------------------------------------------------------------
// 令牌文件读写（~/.cnb/token，与 CLI 共享）
//
// 为什么直接读文件而不走 `cnb status` 之类的命令：
// - 令牌文件是 CLI 与应用的唯一共享真相，读文件零延迟、无子进程开销；
// - 判定"是否本次新授权"需要比较令牌指纹，命令输出格式反而更易变；
// - 文件不存在/损坏一律容错为"未登录"（与 CLI readTokenFile 语义一致）。
//
// 写操作只有两处：① 刷新令牌后写回（保持 CLI 侧登录态同步）；
// ② 退出登录时移除本 host 条目（CLI 未安装时的兜底）。
// 两处都保留文件里**其余 host** 的条目，绝不整文件覆盖 —— 用户可能同时
// 登录了多个 CNB 平台实例。
//
// 权限：unix 下写入强制 0600（与 CLI saveToken 的 mode 384 一致）。
// 理由：令牌等价于密码，同机其他用户不应可读。
// ---------------------------------------------------------------------------

/// 令牌文件绝对路径（与 CLI getTokenPath 语义一致：homedir/.cnb/token）
fn token_file_path() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(TOKEN_DIR_NAME).join(TOKEN_FILE_NAME))
}

/// 读取并解析令牌文件（文件不存在/损坏返回 None，不报错 —— 与 CLI
/// readTokenFile 的容错语义一致）
fn read_token_entry() -> Option<CnbTokenEntry> {
    let text = std::fs::read_to_string(token_file_path()?).ok()?;
    parse_token_file(&text)
}

/// 写回令牌文件：保持 JSON 结构与其余 host 的登录条目不变。
/// unix 下强制 0600 权限（与 CLI 写入行为一致，防止其他用户读取令牌）。
fn write_token_file(path: &PathBuf, value: &serde_json::Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("创建令牌文件目录失败: {e}"))?;
    }
    let json = serde_json::to_string_pretty(value)
        .map_err(|e| format!("序列化令牌文件失败: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            // 0600：仅文件属主可读写（CLI 源码写文件用 mode 384，即 0600）
            .mode(0o600)
            .open(path)
            .map_err(|e| format!("打开令牌文件失败: {e}"))?;
        file.write_all(json.as_bytes())
            .map_err(|e| format!("写入令牌文件失败: {e}"))
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, json).map_err(|e| format!("写入令牌文件失败: {e}"))
    }
}

/// 把刷新后的令牌写回令牌文件，保持 CLI 侧登录态同步。
///
/// 定位规则：优先取 auths["cnb.cool"]；键异常时按旧 access_token 匹配兜底
/// （防御 host 键命名差异导致的更新落空）。
fn update_token_entry(
    old_access_token: &str,
    new_access_token: &str,
    new_expires_at: i64,
    new_refresh_token: Option<&str>,
) -> Result<(), String> {
    let path = token_file_path().ok_or("无法确定令牌文件路径")?;
    let text = std::fs::read_to_string(&path).map_err(|e| format!("读取令牌文件失败: {e}"))?;
    let mut value: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("解析令牌文件失败: {e}"))?;
    let auths = value
        .get_mut("auths")
        .and_then(|v| v.as_object_mut())
        .ok_or("令牌文件缺少 auths 结构")?;
    let entry = if let Some(v) = auths.get_mut(CNB_LOGIN_HOST) {
        v.as_object_mut()
    } else {
        auths
            .values_mut()
            .find(|v| v.get("access_token").and_then(|t| t.as_str()) == Some(old_access_token))
            .and_then(|v| v.as_object_mut())
    };
    let Some(entry) = entry else {
        return Err("令牌文件中未找到目标登录条目".to_string());
    };
    entry.insert("access_token".into(), serde_json::Value::String(new_access_token.into()));
    entry.insert(
        "expires_at".into(),
        serde_json::Value::Number(serde_json::Number::from(new_expires_at)),
    );
    if let Some(rt) = new_refresh_token {
        entry.insert("refresh_token".into(), serde_json::Value::String(rt.into()));
    }
    write_token_file(&path, &value)
}

/// 从令牌文件移除指定 host 的登录条目（CLI 退出命令的兜底，保证两端一致）。
fn remove_token_entry(host: &str) -> bool {
    let Some(path) = token_file_path() else {
        return false;
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return false;
    };
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return false;
    };
    let Some(auths) = value.get_mut("auths").and_then(|v| v.as_object_mut()) else {
        return false;
    };
    if auths.remove(host).is_none() {
        return false;
    }
    write_token_file(&path, &value).is_ok()
}

// ---------------------------------------------------------------------------
// CLI 检测 / 安装
//
// 检测链（顺序即优先级，见 resolve_cli）：
//   ① PATH 中的 cnb（用户自装，版本通常更新）
//   ② 应用数据目录的 cnb（本应用自动下载的原生二进制）
// 两个候选都要过 probe_cli 的两道关：Node shim 必须先确认能找到 node，
// 然后实跑一次 `--version`。两道关都过才认为"可用"。
//
// 安装：仅在检测完全失败时由前端触发（`cnb_cli_install`），
// 下载官方原生二进制到应用数据目录，成功后再跑一次 --version 校验。
// ---------------------------------------------------------------------------

/// CLI 检测结果（serde camelCase 与前端 TS 类型对齐）
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CliDetectResult {
    pub found: bool,
    pub path: String,
    pub version: String,
    /// "system"（PATH 中找到）| "app"（应用数据目录）| "none"
    pub source: String,
    /// 未找到时的具体原因（找到时为空串）。
    /// 单独给字段而不是只塞日志：Node shim 缺 node、产物损坏这类原因
    /// 必须能让用户看到，否则只能看到"未找到"而无从自查。
    pub reason: String,
}

// ---------------------------------------------------------------------------
// PATH 解析（解决 GUI 进程 PATH 与登录 shell PATH 不一致）
// ---------------------------------------------------------------------------

/// 缓存解析后的 PATH（一次探测，全程复用：探测要 spawn shell，代价不低）
static RESOLVED_PATH: OnceLock<String> = OnceLock::new();

/// shell 打印 PATH 时使用的哨兵标记。
///
/// 为什么必须用哨兵：`.zprofile` / `.zlogin` 里常有 `echo`/`neofetch`/版本管理
/// 器的提示输出，它们与 `printf %s "$PATH"` 的结果会在同一 stdout 里黏连成
/// 一行（实测出现过 `.../Python/3.9/bineval`、`go/bin:.:...` 这类畸形项）。
/// 用一段极不可能出现在 PATH 里的标记包裹，只取标记之间的内容，
/// 就能精确切出真正的 PATH。
const PATH_SENTINEL_BEGIN: &str = "__CNB_PATH_BEGIN__";
const PATH_SENTINEL_END: &str = "__CNB_PATH_END__";

/// 从 shell 的原始 stdout 中提取被哨兵包裹的 PATH。
///
/// - 找不到标记（shell 未执行到 printf、被污染吞掉）→ `None`：
///   调用方退回进程自身 PATH，**绝不用半截垃圾串**（半截 PATH 会让
///   `path_lookup` 查到完全不相关目录，比找不到更危险）。
/// - 标记之间的内容为空 → `None`（等价于探测失败）。
/// - 标记之后的内容（如 shell 的收尾提示）一律丢弃。
pub(crate) fn extract_sentinel_path(raw: &str) -> Option<String> {
    let begin = raw.find(PATH_SENTINEL_BEGIN)? + PATH_SENTINEL_BEGIN.len();
    let rest = &raw[begin..];
    let end = rest.find(PATH_SENTINEL_END)?;
    let path = rest[..end].trim();
    if path.is_empty() {
        return None;
    }
    Some(path.to_string())
}

/// 判断一个 PATH 项是否可用：必须是非空**绝对**路径。
///
/// 为什么过滤相对项（含裸 `.`）：PATH 里的 `.` 会让 `path_lookup` 去查
/// "当前工作目录下的 cnb" —— GUI 应用的 CWD 通常是 `/` 或用户主目录，
/// 等于把任意同名文件变成可执行入口，是典型的 PATH 劫持面。
/// 实测本机登录 shell 的 PATH 里确实带 `.`，因此这一层过滤是必要的。
fn is_usable_path_entry(dir: &Path) -> bool {
    !dir.as_os_str().is_empty() && dir.is_absolute()
}

/// 把 `path` 中的目录按顺序并入 `dirs`（去重且保持先后优先级）。
///
/// 去重是必须的：登录 shell PATH 往往包含当前 PATH 的大部分内容，
/// 不去重会让 PATH 长度翻倍，且 `path_lookup` 的查找顺序变得难以预期。
/// 相对项（`.`、`foo/bin`）与非绝对路径在此统一丢弃，见 `is_usable_path_entry`。
fn merge_path_dirs(dirs: &mut Vec<PathBuf>, path: &str) {
    for dir in std::env::split_paths(path) {
        if !is_usable_path_entry(&dir) {
            continue;
        }
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
}

/// 用登录 shell 解析用户真实 PATH。
///
/// 为什么必须问 shell：macOS 从 Finder/Dock 启动的 .app 由 launchd 派发，
/// 其 PATH 通常只有 `/usr/bin:/bin:/usr/sbin:/sbin` —— nvm / homebrew /
/// npm 全局目录统统不在其中。而用户的 `cnb` 恰恰常装在这些目录里，
/// 且多半是 `#!/usr/bin/env node` 的 JS shim（连 node 都找不到）。
/// 只读 `std::env::var("PATH")` 会得到"看不到用户装了什么"的假结论。
///
/// `-lc`（登录 shell + 执行命令、非交互）：只加载 .zprofile/.zlogin，
/// 不加载 .zshrc（后者常含交互式提示、可能阻塞）。
///
/// 超时策略：首个 shell 给 3s（可能是用户真实登录 shell，含 nvm 等重逻辑），
/// 备选 shell（bash/sh）只给 1s —— 它们仅作兜底，不该让界面再等 3s。
///
/// 输出解析：用哨兵包裹后再取（见 `extract_sentinel_path`），
/// 避免 .zprofile 里的 echo 与 PATH 黏连成畸形项。
fn login_shell_path() -> Option<String> {
    for (index, shell) in ["/bin/zsh", "/bin/bash", "/bin/sh"].iter().enumerate() {
        if !Path::new(shell).is_file() {
            continue;
        }
        let timeout_ms = if index == 0 {
            PATH_PROBE_TIMEOUT_MS
        } else {
            PATH_PROBE_TIMEOUT_FALLBACK_MS
        };
        let shell = *shell;
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            // printf 而非 echo：避免部分 shell 的 echo 对反斜杠做转义；
            // 哨兵包裹保证只取真正的 PATH（隔离 .zprofile 的输出污染）
            let command = format!(
                "printf '{PATH_SENTINEL_BEGIN}%s{PATH_SENTINEL_END}' \"$PATH\""
            );
            let output = Command::new(shell)
                .args(["-lc", &command])
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .output();
            let path = output.ok().filter(|o| o.status.success()).and_then(|o| {
                extract_sentinel_path(&String::from_utf8_lossy(&o.stdout))
            });
            let _ = tx.send(path);
        });
        if let Ok(Some(path)) = rx.recv_timeout(Duration::from_millis(timeout_ms)) {
            return Some(path);
        }
    }
    None
}

/// 探测 node 运行时所在目录（专为 `#!/usr/bin/env node` 的 JS shim 服务）。
///
/// 顺序：① 合并后的 PATH 里已有 node → 直接用（尊重用户选定的版本）；
/// ② 否则扫常见安装位置（homebrew / 官方 pkg / volta / bun / pnpm / nvm）。
/// nvm 多版本并存时按目录名字典序取最大者（通常即最新安装的版本）。
///
/// 返回的是**目录**而不是 node 可执行文件路径：调用方要做的是把该目录
/// 追加进 PATH（供 `env` 解析），而不是自己 exec node。
fn node_runtime_dir(search_path: &str) -> Option<String> {
    for dir in std::env::split_paths(search_path) {
        for exe in ["node", "node.exe"] {
            if dir.join(exe).is_file() {
                return Some(dir.to_string_lossy().into_owned());
            }
        }
    }
    let mut candidates: Vec<PathBuf> = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ];
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".volta/bin"));
        candidates.push(home.join(".bun/bin"));
        candidates.push(home.join(".local/bin"));
        candidates.push(home.join("Library/pnpm/bin"));
        // nvm：多版本目录，倒序（版本号大者在前）逐个子目录探测
        if let Ok(entries) = std::fs::read_dir(home.join(".nvm/versions/node")) {
            let mut nvm_bins: Vec<PathBuf> = entries
                .flatten()
                .map(|entry| entry.path().join("bin"))
                .collect();
            nvm_bins.sort();
            candidates.extend(nvm_bins.into_iter().rev());
        }
    }
    candidates
        .into_iter()
        .find(|dir| dir.join("node").is_file())
        .map(|dir| dir.to_string_lossy().into_owned())
}

/// 应用内查找与子进程环境统一使用的 PATH：
/// 当前进程 PATH（保持既有优先级）∪ 登录 shell PATH ∪ node 运行时目录。
///
/// 双用途：
/// - 应用内 `path_lookup` 用它找 cnb（GUI 下也能找到用户真实安装的版本）；
/// - 注入子进程 env 用它，让 JS shim 的 `#!/usr/bin/env node` 能解析到 node。
///
/// 三段来源的优先级有意如此：
/// 1. 进程自身 PATH 最优先 —— tauri dev / 终端启动时保持既有解析顺序不变，
///    避免"开发环境行为与打包后不一致"这类难查问题；
/// 2. 登录 shell PATH 追加在后 —— 补上 GUI 进程看不到的 nvm/homebrew 目录；
/// 3. node 运行时目录最后兜底 —— 仅当上面两段都找不到 node 时才追加，
///    保证用户自己选定的 node 版本永远优先。
///
/// 每一段都经 `merge_path_dirs` 过滤（绝对路径 + 去重），因此脏项进不来。
fn resolved_path_env() -> &'static str {
    RESOLVED_PATH.get_or_init(|| {
        let mut dirs: Vec<PathBuf> = Vec::new();
        // 当前 PATH 优先：开发环境（tauri dev）下保持既有解析顺序，行为不变
        if let Some(current) = std::env::var_os("PATH") {
            merge_path_dirs(&mut dirs, &current.to_string_lossy());
        }
        if let Some(shell_path) = login_shell_path() {
            merge_path_dirs(&mut dirs, &shell_path);
        }
        let merged = std::env::join_paths(&dirs)
            .map(|joined| joined.to_string_lossy().into_owned())
            .unwrap_or_default();
        // 兜底补 node 目录：仅当合并后的 PATH 里找不到 node 时才追加，
        // 保证不改变既有优先级（用户自己 PATH 里的 node 永远优先）
        if let Some(node_dir) = node_runtime_dir(&merged) {
            merge_path_dirs(&mut dirs, &node_dir);
        }
        std::env::join_paths(&dirs)
            .map(|joined| joined.to_string_lossy().into_owned())
            .unwrap_or(merged)
    })
}

/// PATH 语义查找（等价 `which cnb`）：按 PATH 顺序找第一个存在的可执行候选。
/// PATH 来源为 `resolved_path_env()`（含登录 shell PATH，GUI 下同样有效）。
///
/// 注意：这是**阻塞**操作（首次调用可能 spawn 登录 shell 探测 PATH），
/// 因此所有 async 调用点都必须包在 `spawn_blocking` 里（见 `resolve_cli`）。
fn path_lookup() -> Option<PathBuf> {
    let path_env = resolved_path_env();
    let exe_names: &[&str] = if cfg!(windows) {
        &["cnb.exe", "cnb.cmd", "cnb"]
    } else {
        &["cnb"]
    };
    for dir in std::env::split_paths(path_env) {
        for exe in exe_names {
            let candidate = dir.join(exe);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// 应用数据目录下的 CLI 安装路径：app_data_dir/bin/cnb
///
/// 为什么要单独一个目录：应用自动下载的原生二进制必须与系统安装的 cnb 隔离，
/// 避免覆盖用户自己维护的版本（升级/回滚互不影响）。
fn app_cli_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    let exe = if cfg!(windows) { "cnb.exe" } else { "cnb" };
    Some(app.path().app_data_dir().ok()?.join("bin").join(exe))
}

/// 运行 `--version` 验证可执行性（带超时，防悬挂二进制卡死检测流程）。
/// 返回版本号首行（如 "1.18.3"）；不可执行/超时返回 None。
/// 版本号不含任何敏感信息，可安全透出。
///
/// 为什么用"独立线程 + mpsc + recv_timeout"而不是直接在调用线程里
/// `output()`：`Command::output()` 没有超时参数，遇到卡死的二进制
/// （例如等待 stdin、或架构不匹配导致半启动）会永久阻塞调用线程。
/// 把工作丢到临时线程、主线程只等 5s，超时即放弃（线程随后自然结束，
/// 最坏情况泄漏一个被卡住的线程，不会拖死整个界面）。
///
/// 注意 env：必须注入 `resolved_path_env()`，否则 JS shim 在 GUI 环境下
/// 会因 `#!/usr/bin/env node` 找不到 node 而立即失败（--version 也就探测不到）。
fn run_version_check(path: PathBuf) -> Option<String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let output = Command::new(&path)
            .arg("--version")
            .env("PATH", resolved_path_env())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output();
        let version = output.ok().filter(|o| o.status.success()).and_then(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .next()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
        });
        let _ = tx.send(version);
    });
    rx.recv_timeout(Duration::from_millis(VERSION_CHECK_TIMEOUT_MS))
        .ok()
        .flatten()
}

/// 已解析且经验证可用的 CLI 信息（路径 + 版本 + 来源）。
struct ResolvedCli {
    path: PathBuf,
    version: String,
    /// "system"（PATH 中找到）| "app"（应用数据目录）
    source: &'static str,
}

/// 校验单个候选可执行性。
///
/// 两道关（顺序有意为之）：
/// 1. Node 脚本先确认环境里能找到 node —— 找不到就直接给出明确原因，
///    避免 spawn 后只得到" stdout 空 / exit 127"这种无从下手的现象；
/// 2. `--version` 实际执行一次（损坏产物、架构不符都会在这一步暴露）。
///
/// 返回版本号，或不可用的原因（原因直接并入错误信息，便于用户自查）。
async fn probe_cli(path: PathBuf) -> Result<String, String> {
    if is_node_shim(&path) && node_runtime_dir(resolved_path_env()).is_none() {
        return Err(format!(
            "检测到 Node 版 cnb（{display}），但应用环境找不到 node 运行时（GUI 进程 PATH 通常不含 nvm/homebrew），请安装原生版 cnb 或将 node 所在目录加入系统 PATH",
            display = path.display()
        ));
    }
    let check_path = path.clone();
    match tauri::async_runtime::spawn_blocking(move || run_version_check(check_path)).await {
        Ok(Some(version)) => Ok(version),
        Ok(None) => Err(format!(
            "cnb CLI 无法执行（{display}）",
            display = path.display()
        )),
        Err(e) => Err(format!(
            "校验 cnb CLI 可执行性失败（{display}）: {e}",
            display = path.display()
        )),
    }
}

/// 完整解析：PATH 优先（用户自装版本更新），其次应用数据目录（内置下载）。
/// 两个候选都失败时返回合并后的可读原因（供前端展示 / 登录命令报错）。
async fn resolve_cli(app: &tauri::AppHandle) -> Result<ResolvedCli, String> {
    let mut skipped: Vec<String> = Vec::new();
    // PATH 探测会同步 spawn 登录 shell（最长 3s + 1s + 1s），绝不能在 async
    // 上下文里直接做 —— 否则会阻塞 tokio worker，首帧界面出现可见卡顿。
    // 放进 spawn_blocking：探测失败（JoinError）按"PATH 里没找到"处理。
    let path_candidate = tauri::async_runtime::spawn_blocking(path_lookup)
        .await
        .ok()
        .flatten();
    if let Some(path) = path_candidate {
        match probe_cli(path.clone()).await {
            Ok(version) => {
                return Ok(ResolvedCli {
                    path,
                    version,
                    source: "system",
                });
            }
            Err(reason) => skipped.push(reason),
        }
    }
    if let Some(app_path) = app_cli_path(app) {
        if app_path.is_file() {
            match probe_cli(app_path.clone()).await {
                Ok(version) => {
                    return Ok(ResolvedCli {
                        path: app_path,
                        version,
                        source: "app",
                    });
                }
                Err(reason) => skipped.push(reason),
            }
        }
    }
    if skipped.is_empty() {
        Err(format!(
            "未找到可用的 cnb CLI，请先安装（官方指引：{CLI_MANUAL_GUIDE_URL}）"
        ))
    } else {
        Err(format!(
            "{}（官方指引：{CLI_MANUAL_GUIDE_URL}）",
            skipped.join("；")
        ))
    }
}

/// Tauri 命令：检测 cnb CLI 是否可用。
///
/// 与"能跑就行"的简易检测不同，这里复用 `resolve_cli` 的完整校验链
/// （PATH ∪ 登录 shell PATH → Node shim 可用性 → `--version`），
/// 因此前端拿到的 `found=false` 一定附带了可读的 `reason`，
/// 用户不必再靠猜"为什么我的 cnb 明明装了却提示未找到"。
///
/// 不返回 Result：检测失败本就是正常业务状态（引导用户安装），
/// 用 `found` 表达比让前端区分"抛错/未找到"两种语义更省事。
#[tauri::command]
pub async fn cnb_cli_detect(app: tauri::AppHandle) -> CliDetectResult {
    match resolve_cli(&app).await {
        Ok(cli) => CliDetectResult {
            found: true,
            path: cli.path.to_string_lossy().into_owned(),
            version: cli.version,
            source: cli.source.to_string(),
            reason: String::new(),
        },
        Err(reason) => CliDetectResult {
            found: false,
            path: String::new(),
            version: String::new(),
            source: "none".to_string(),
            reason,
        },
    }
}

/// 安装结果：path 供后续 spawn 直接用，version 用于确认产物可执行。
/// 两者都由安装流程实测得到，不是"照抄期望值"——这样前端展示的版本号
/// 一定等于实际跑起来的版本。
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CliInstallResult {
    /// 安装到应用数据目录后的绝对路径（后续直接用它 spawn）
    pub path: String,
    /// 安装后实测到的版本号（验证产物可执行）
    pub version: String,
}

/// Tauri 命令：下载官方原生二进制到应用数据目录并验证可执行。
///
/// 下载 URL 依据官方 install.sh：`{REPO_BASE}/latest/download/cnb-{os}-{arch}`。
/// 下载通道与 cnb_http_request 同策略（native-tls 默认栈 + no_proxy 强制直连），
/// 规避系统代理分流与 rustls TLS 指纹风控。
#[tauri::command]
pub async fn cnb_cli_install(app: tauri::AppHandle) -> Result<CliInstallResult, String> {
    let filename = cli_download_filename(std::env::consts::OS, std::env::consts::ARCH)
        .map_err(|e| format!("{e}（请参考官方指引手动安装：{CLI_MANUAL_GUIDE_URL}）"))?;
    let url = format!("{CLI_RELEASE_BASE}/{filename}");
    let target = app_cli_path(&app).ok_or("无法确定应用数据目录")?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .no_proxy()
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败: {e}"))?;
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("下载 cnb CLI 失败: {e}（可参考官方指引手动安装：{CLI_MANUAL_GUIDE_URL}）"))?;
    if response.status() != reqwest::StatusCode::OK {
        return Err(format!(
            "下载 cnb CLI 失败（HTTP {}），可参考官方指引手动安装：{CLI_MANUAL_GUIDE_URL}",
            response.status().as_u16()
        ));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("读取 cnb CLI 下载内容失败: {e}"))?;
    if bytes.is_empty() {
        return Err(format!(
            "下载的 cnb CLI 内容为空（{url}），可参考官方指引手动安装：{CLI_MANUAL_GUIDE_URL}"
        ));
    }

    // 写入 app_data_dir/bin/cnb 并设置可执行权限（unix 0755）
    std::fs::create_dir_all(
        target
            .parent()
            .ok_or("应用数据目录路径异常")?,
    )
    .map_err(|e| format!("创建 CLI 安装目录失败: {e}"))?;
    write_executable_binary(&target, &bytes).map_err(|e| format!("写入 CLI 文件失败: {e}"))?;

    // 安装后必须通过 --version 验证，防止把损坏产物当作可用 CLI
    let verify_path = target.clone();
    let version = tauri::async_runtime::spawn_blocking(move || run_version_check(verify_path))
        .await
        .map_err(|e| format!("验证 CLI 可执行性失败: {e}"))?
        .ok_or_else(|| {
            format!("安装的 cnb CLI 无法执行（{filename}），可参考官方指引手动安装：{CLI_MANUAL_GUIDE_URL}")
        })?;
    Ok(CliInstallResult {
        path: target.to_string_lossy().into_owned(),
        version,
    })
}

/// 写入二进制文件并设置可执行权限。
///
/// unix 下用 0755 创建（下载的产物没有权限位，`create` 默认 0644 会导致
/// "文件存在但无法执行"）；非 unix 直接写文件（Windows 靠 .exe 后缀识别）。
fn write_executable_binary(target: &PathBuf, bytes: &[u8]) -> Result<(), std::io::Error> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o755)
            .open(target)?;
        file.write_all(bytes)
    }
    #[cfg(not(unix))]
    {
        std::fs::write(target, bytes)
    }
}

// ---------------------------------------------------------------------------
// 设备授权登录会话管理
//
// IPC 契约总览（前端对应文件：src/composables/useCnbCliAuth.ts；
// serde 一律 rename_all = "camelCase"，TS 侧字段名与之一一对应）：
//
// | 命令                    | 入参   | 返回                          | 典型失败                 |
// |-------------------------|--------|-------------------------------|--------------------------|
// | cnb_cli_detect          | -      | CliDetectResult（含 reason）  | 不抛错，found=false      |
// | cnb_cli_install         | -      | CliInstallResult              | 下载/校验失败（含指引）  |
// | cnb_cli_login           | -      | CliLoginStart（handle+url）   | CLI 不可用 / 解析失败    |
// | cnb_cli_login_poll      | handle | CliLoginPoll（pending/…）     | 会话不存在               |
// | cnb_cli_cancel_login    | handle | void                          | 无（幂等）               |
// | cnb_cli_read_token      | -      | CliTokenInfo | null           | 无                       |
// | cnb_cli_refresh_token   | -      | CliRefreshResult              | 无 refresh_token / HTTP  |
// | cnb_cli_logout          | -      | void                          | 无（有文件兜底）         |
//
// 会话生命周期：login 创建 → poll 轮询（success 时由 poll 移除）→
// cancel 或前端卸载时移除。会话表里残留的 Child 由 cancel/失败分支 kill，
// 因为前端超时（5min）一定会调 cancel —— 不存在"永久僵尸进程"路径。
// ---------------------------------------------------------------------------

/// 一次设备授权登录会话：持有子进程与启动时的令牌指纹。
/// initial_access_token 用于区分"启动前已有旧登录"与"本次新授权"——
/// 授权成功的判定是令牌文件中出现**与启动时不同**的新令牌，否则旧令牌
/// 会让轮询瞬间误报成功。
struct LoginSession {
    child: std::process::Child,
    initial_access_token: Option<String>,
    /// stdout 原文（增量累积；失败时摘录展示，绝不执行）
    stdout_buf: Arc<Mutex<String>>,
    /// stderr 原文（同上）
    stderr_tail: Arc<Mutex<String>>,
    /// 实际使用的 CLI 路径（诊断用；路径不含令牌，可安全展示）
    cli_path: String,
    /// CLI 版本号（诊断用，用于区分 JS shim / 原生二进制）
    cli_version: String,
}

/// 全局登录会话表：handle -> session。Mutex 中毒时直接取内层数据
/// （会话管理操作相互独立，无需放弃整个表）。
///
/// 为什么用全局表而不是让前端持有状态：Tauri 命令是无状态的 async fn，
/// 前端只能传一个可序列化的凭据（handle），因此子进程必须由 Rust 侧托管。
/// handle 用 `AtomicU64` 自增：只需唯一，不必可预测（不作为权限凭据，
/// 因为只有同一进程内的本应用前端能调用这些命令）。
static LOGIN_SESSIONS: OnceLock<Mutex<HashMap<u64, LoginSession>>> = OnceLock::new();
static NEXT_HANDLE: AtomicU64 = AtomicU64::new(1);

/// 全局登录会话表的访问器（首次调用时初始化）。
fn sessions() -> &'static Mutex<HashMap<u64, LoginSession>> {
    LOGIN_SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 取会话表锁；Mutex 中毒时取内层数据继续用。
///
/// 为什么不用 unwrap：会话表操作彼此独立（插入/查询/移除），
/// 某个线程 panic 导致锁中毒不应把整个登录功能判死刑。
fn lock_sessions() -> std::sync::MutexGuard<'static, HashMap<u64, LoginSession>> {
    sessions().lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 登录启动结果（handle 供后续轮询/取消引用；验证链接与用户码直接展示）
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CliLoginStart {
    /// 会话句柄：poll / cancel 的唯一凭据（进程内自增，不跨重启）
    pub handle: u64,
    /// 验证链接（verification_uri_complete，已剥离 ANSI 与缩进）
    pub verification_url: String,
    /// 设备码（user_code；缺失时为空串，前端据此隐藏设备码区）
    pub user_code: String,
    /// CLI 初始输出原文（截断，兜底展示用；可帮助用户确认 CLI 走到了哪一步）
    pub raw_output: String,
}

/// 查询会话子进程是否已退出。
///
/// `try_wait` 是幂等的：进程已被回收时仍返回同一个 ExitStatus，
/// 因此在轮询循环里反复调用是安全的（不会丢状态、不会阻塞）。
fn session_exit_status(handle: u64) -> Option<ExitStatus> {
    let mut map = lock_sessions();
    let session = map.get_mut(&handle)?;
    session.child.try_wait().ok().flatten()
}

/// 把子进程交给后台线程 `wait()` 回收，返回该线程句柄。
///
/// 为什么需要：Rust 的 `Child` **没有** Drop-based reap —— 直接 drop 一个
/// 仍存活的子进程，进程会继续运行并在退出后变成 `<defunct>` 僵尸，
/// 直到父进程（本应用）退出才被 init 接管回收。登录成功时 CLI 往往还要
/// 收尾几百毫秒，这一格正好会漏僵尸（应用常驻托盘 → 泄漏长期累积）。
///
/// 为什么不 kill：CLI 此时可能正在写 `~/.cnb/token`，误杀会写坏令牌文件。
/// 因此只 wait 不 kill：进程自然退出后立即被回收，零副作用。
///
/// 返回句柄是为了可测（单测可以 join 它，确认真的调用了 wait 并等到退出）。
fn reap_child_in_background(mut child: std::process::Child) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let _ = child.wait();
    })
}

/// 清理并移除一个登录会话：kill 子进程后 wait 回收，防止僵尸进程。
///
/// 为什么 kill 是安全的：该函数只在两条路径上调用 ——
/// ① 登录启动失败（没解析到链接，子进程要么已秒退要么在空转）；
/// ② 用户主动取消。两条路径下子进程都**不可能**正在写 ~/.cnb/token
/// （写令牌只发生在授权成功之后），因此 kill 不会写坏令牌文件。
/// 与 `reap_child_in_background`（成功路径、只 wait 不 kill）刻意区分。
///
/// kill 后必须 wait：只 kill 不 wait 会留下 `<defunct>` 僵尸；`wait` 对
/// 已退出的进程是幂等回收，对仍存活的进程则等到 kill 生效后立即返回。
fn cleanup_login_session(handle: u64) {
    if let Some(mut session) = lock_sessions().remove(&handle) {
        let _ = session.child.kill();
        let _ = session.child.wait();
    }
}

/// 等待结果：解析出的链接、累计的 stdout/stderr、子进程退出状态（None=仍存活）
struct LoginWaitOutcome {
    parsed: Option<(String, String)>,
    stdout: String,
    stderr: String,
    exit: Option<ExitStatus>,
}

/// 轮询等待 `cnb login` 输出验证链接。
///
/// 三条行为约束（本次修复新增，均由真实故障场景驱动）：
/// 1. **每轮先解析、再探测退出**：进程可能刚写出链接就退出，
///    顺序颠倒会把"已成功的输出"判成失败；
/// 2. **子进程提前退出立即返回**：CLI 报错（参数不支持、网络失败、
///    JS shim 缺 node）时会秒退，此时不该再空等满 10s —— 用户会以为卡死；
/// 3. **已有部分输出则追加宽松等待**：只打印了标题行、链接还没打印时，
///    10s 窗口到期不该直接判失败，再给 5s（宽松窗口）才失败。
///
/// `probe_exit` 以闭包注入而不是绑定到具体 Child：让本函数保持可测
/// （单测可用固定返回值模拟"仍在运行"与"已退出"两条分支）。
fn wait_for_login_link(
    stdout_buf: &Arc<Mutex<String>>,
    stderr_buf: &Arc<Mutex<String>>,
    probe_exit: &dyn Fn() -> Option<ExitStatus>,
) -> LoginWaitOutcome {
    let interval = Duration::from_millis(LOGIN_POLL_INTERVAL_MS);
    // 无需初值：循环体第一句必定赋值，正常窗口结束时必然有快照
    let mut last_stdout: String;

    // —— 阶段一：正常等待窗口 ——
    let deadline = std::time::Instant::now() + Duration::from_millis(LOGIN_OUTPUT_WAIT_MS);
    loop {
        last_stdout = snapshot(stdout_buf);
        if let Some(parsed) = parse_login_output(&last_stdout) {
            return LoginWaitOutcome {
                parsed: Some(parsed),
                stdout: last_stdout,
                stderr: snapshot(stderr_buf),
                exit: probe_exit(),
            };
        }
        if let Some(status) = probe_exit() {
            // 进程已退出：读取线程在 EOF 之后还有最后一段要写入，
            // 短暂让出 CPU 再抓一次快照，避免丢掉"临死前"输出的链接
            std::thread::sleep(Duration::from_millis(50));
            last_stdout = snapshot(stdout_buf);
            return LoginWaitOutcome {
                parsed: parse_login_output(&last_stdout),
                stdout: last_stdout,
                stderr: snapshot(stderr_buf),
                exit: Some(status),
            };
        }
        if std::time::Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(interval);
    }

    // —— 阶段二：已有部分输出（进程仍存活）时追加宽松等待 ——
    if !last_stdout.trim().is_empty() {
        let extra_deadline =
            std::time::Instant::now() + Duration::from_millis(LOGIN_OUTPUT_EXTRA_WAIT_MS);
        loop {
            last_stdout = snapshot(stdout_buf);
            if let Some(parsed) = parse_login_output(&last_stdout) {
                return LoginWaitOutcome {
                    parsed: Some(parsed),
                    stdout: last_stdout,
                    stderr: snapshot(stderr_buf),
                    exit: probe_exit(),
                };
            }
            if let Some(status) = probe_exit() {
                std::thread::sleep(Duration::from_millis(50));
                last_stdout = snapshot(stdout_buf);
                return LoginWaitOutcome {
                    parsed: parse_login_output(&last_stdout),
                    stdout: last_stdout,
                    stderr: snapshot(stderr_buf),
                    exit: Some(status),
                };
            }
            if std::time::Instant::now() >= extra_deadline {
                break;
            }
            std::thread::sleep(interval);
        }
    }

    LoginWaitOutcome {
        parsed: None,
        stdout: last_stdout,
        stderr: snapshot(stderr_buf),
        exit: probe_exit(),
    }
}

// ---------------------------------------------------------------------------
// spawn + 等待的可复用封装（Round 3 修复抽出）
//
// 抽成内部函数的目的：--host 降级重试需要"重新 spawn + 重走等待逻辑"，
// 不封装就得在 login 主流程里复制一整段 spawn/读线程/登记/等待代码。
// 封装后主流程只剩"spawn → wait → 判定 → （必要时）再 spawn → 再 wait"，
// 与架构上的时序图一一对应。
// ---------------------------------------------------------------------------

/// 一次成功 spawn 的登录会话的轻量引用：handle + 两个输出缓冲区的克隆。
///
/// 只存 Arc 克隆而不存 Child：Child 的所有权归全局会话表（LOGIN_SESSIONS），
/// 退出探测统一走 `session_exit_status(handle)`，避免同一 Child 的所有权
/// 分裂在两处。
struct SpawnedLogin {
    /// 会话句柄（poll / cancel / 清理的唯一凭据）
    handle: u64,
    /// stdout 增量缓冲区（读线程写入，等待循环读取快照）
    stdout_buf: Arc<Mutex<String>>,
    /// stderr 增量缓冲区（降级判定需要从中找 "unknown option"）
    stderr_buf: Arc<Mutex<String>>,
}

/// spawn `cnb login` 并完成全部会话登记（读线程 + 会话表）。
///
/// `with_host` 控制是否带 `--host CNB_LOGIN_HOST`：
/// - true：首选路径，新版 CLI 显式指定登录平台；
/// - false：旧版 CLI 降级路径，依赖其默认 platform_url == cnb.cool。
///
/// stdin 恒为 null（设备流不需要交互输入）、stdout/stderr 恒为管道
/// （增量捕获是解析与降级判定的前提），PATH 注入解析后的登录 shell PATH
/// （JS shim 的 `#!/usr/bin/env node` 依赖它）。
fn spawn_login_session(
    cli_path: &Path,
    with_host: bool,
    initial_access_token: Option<String>,
    cli_path_text: &str,
    cli_version: &str,
) -> Result<SpawnedLogin, String> {
    let mut command = Command::new(cli_path);
    command.arg("login");
    if with_host {
        // 为什么写在这里而不是调用方拼接：保证 login/logout 两条命令的
        // 参数组装都集中在一处，将来再加选项不会漏改降级分支
        command.args(["--host", CNB_LOGIN_HOST]);
    }
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("PATH", resolved_path_env())
        .spawn()
        .map_err(|e| format!("启动 cnb login 失败: {e}（CLI: {cli_path_text}）"))?;

    // stdout / stderr 读取线程：**增量**读取（见 pump_reader 的根因说明）。
    // 子进程输出按不可信文本处理，仅累积原文，绝不执行、绝不写盘。
    let stdout_buf = Arc::new(Mutex::new(String::new()));
    if let Some(stdout) = child.stdout.take() {
        spawn_output_reader(stdout, stdout_buf.clone());
    }
    let stderr_buf = Arc::new(Mutex::new(String::new()));
    if let Some(stderr) = child.stderr.take() {
        spawn_output_reader(stderr, stderr_buf.clone());
    }

    let handle = NEXT_HANDLE.fetch_add(1, Ordering::Relaxed);
    lock_sessions().insert(
        handle,
        LoginSession {
            child,
            initial_access_token,
            stdout_buf: stdout_buf.clone(),
            stderr_tail: stderr_buf.clone(),
            cli_path: cli_path_text.to_string(),
            cli_version: cli_version.to_string(),
        },
    );
    Ok(SpawnedLogin {
        handle,
        stdout_buf,
        stderr_buf,
    })
}

/// 等待一次 spawn 的登录输出（阻塞式，由调用方放进 spawn_blocking）。
///
/// 独立成函数的意义：正常路径与降级重试路径共用同一段"阻塞等待"代码，
/// 且探测闭包绑定到 handle（从会话表取退出状态），两次 spawn 的会话
/// 各自独立、互不干扰。
fn wait_login_outcome_blocking(spawn: SpawnedLogin) -> (u64, LoginWaitOutcome) {
    let handle = spawn.handle;
    let outcome = wait_for_login_link(&spawn.stdout_buf, &spawn.stderr_buf, &|| {
        session_exit_status(handle)
    });
    (handle, outcome)
}

/// 异步包装：把阻塞等待放进 spawn_blocking（不阻塞 tokio worker）。
async fn wait_login_outcome(
    spawn: SpawnedLogin,
) -> Result<(u64, LoginWaitOutcome), String> {
    tauri::async_runtime::spawn_blocking(move || wait_login_outcome_blocking(spawn))
        .await
        .map_err(|e| format!("等待登录输出失败: {e}"))
}

/// 判定 stderr 是否为"CLI 不认识某个选项"类参数错误（不区分大小写）。
///
/// 匹配策略：主匹配 "unknown option"（clap/ commander 风格报错的稳定措辞），
/// 放宽匹配 "did you mean"（部分 CLI 版本对未知参数的建议式报错）。
/// 为什么不精确匹配 "'--host'"：将来若 CLI 再砍掉其他选项（如 --woa），
/// 同一判定应当继续生效，降级逻辑不该绑定在具体参数名上。
///
/// 误报风险评估：匹配命中还会叠加"非零退出码 + 无验证链接"两个前置条件
/// （见 login_can_retry_without_host），登录成功输出不可能同时满足三者，
/// 因此放宽到 "did you mean" 不会把成功误判成失败。
pub(crate) fn is_unknown_option_failure(stderr: &str) -> bool {
    let lowered = stderr.to_lowercase();
    lowered.contains("unknown option") || lowered.contains("did you mean")
}

/// 降级重试的完整判定：**全部**条件满足才允许去掉 --host 重试一次。
///
/// 条件清单（与 Round 3 修复记录一一对应）：
/// 1. `parsed` 为 None —— 已经拿到验证链接的会话绝不能重试（重试会丢弃
///    一个已发出的设备码授权，且用户可能已经在浏览器里授权到一半）；
/// 2. 子进程已退出且退出码非 0 —— 正常登录中（exit=None）绝不降级；
///    退出码 0 却没链接属于输出格式类问题，降级重试也无济于事；
/// 3. stderr 是 unknown option 类参数错误（is_unknown_option_failure）。
///
/// 三条件合取的意图：只在"参数被 CLI 拒绝"这一种确定性失败上做降级，
/// 其他任何失败（网络、node 缺失、输出格式变化）都原样报错，不拖长用户
/// 等待时间，也不掩盖真实根因。
fn login_can_retry_without_host(outcome: &LoginWaitOutcome) -> bool {
    let exited_nonzero = outcome.exit.map_or(false, |status| !status.success());
    outcome.parsed.is_none() && exited_nonzero && is_unknown_option_failure(&outcome.stderr)
}

/// Tauri 命令：发起设备授权登录。
///
/// 流程：解析 CLI（含 Node shim 可用性校验）→ spawn `cnb login --host cnb.cool`
/// （stdin 关闭，stdout/stderr 管道增量捕获）→ 从 stdout 解析验证链接与
/// user_code → 进程留在后台轮询授权结果，返回会话句柄给前端。
///
/// # 旧版 CLI 的 --host 降级（Round 3 修复）
///
/// 新版 CLI（≥1.11）支持 `--host` 显式指定登录平台；旧版（如 vite-plus
/// 捆绑的 1.10.16）不认识该参数，会在参数解析阶段报
/// `error: unknown option '--host'` 并 exit 1 —— 此时尚未调用
/// requestDeviceCode，没有消耗设备码、没有打开浏览器、没有写 ~/.cnb/token，
/// 因此**降级重试完全无副作用**：清理旧会话后去掉 --host 重新 spawn 一次
/// （只重试一次）。旧版默认 platform_url 就是 cnb.cool（dist 源码
/// `platformURL: t.woa ? "https://cnb.woa.com" : "https://cnb.cool"`），与
/// `CNB_LOGIN_HOST` 一致，登录目标不变。
///
/// 说明：CLI 自身会尝试打开系统浏览器（tryOpenBrowser），因此本命令与前端
/// 均不自动重复打开，仅由前端提供手动打开按钮兜底。
#[tauri::command]
pub async fn cnb_cli_login(app: tauri::AppHandle) -> Result<CliLoginStart, String> {
    // 解析失败时 resolve_cli 已给出可读原因（含 Node shim 缺 node 的专项提示）
    let cli = resolve_cli(&app).await?;
    let cli_path_text = cli.path.to_string_lossy().into_owned();
    let cli_version = cli.version.clone();
    // 记录启动时的令牌指纹（仅内存，绝不落日志），供轮询判断"新授权"。
    // 注意：两次 spawn（正常 + 降级重试）共用同一指纹 —— 首次 spawn 因参数
    // 错误秒退，不可能产生新令牌，指纹不需要在重试间刷新。
    let initial_access_token = read_token_entry().map(|e| e.access_token);

    // —— 第一次 spawn：首选带 --host cnb.cool（新版 CLI 语义）——
    let first = spawn_login_session(
        &cli.path,
        true,
        initial_access_token.clone(),
        &cli_path_text,
        &cli_version,
    )?;
    let (handle, outcome) = wait_login_outcome(first).await?;

    // —— 降级判定：三个条件全部满足才重试（见 login_can_retry_without_host）——
    // 为什么不无条件重试：把网络故障、令牌文件损坏等其他失败也重试一遍，
    // 只会让用户等双倍时间且掩盖真实错误；参数不识别是唯一"重试必然有效"
    // 的失败形态。
    let (handle, outcome, degraded) =
        if outcome.parsed.is_none() && login_can_retry_without_host(&outcome) {
            // 清理首次会话（kill + wait 回收，无僵尸残留）后重试
            cleanup_login_session(handle);
            let retry = spawn_login_session(
                &cli.path,
                false,
                initial_access_token.clone(),
                &cli_path_text,
                &cli_version,
            )?;
            let (retry_handle, retry_outcome) = wait_login_outcome(retry).await?;
            (retry_handle, retry_outcome, true)
        } else {
            (handle, outcome, false)
        };

    match outcome.parsed {
        Some((verification_url, user_code)) => {
            let mut raw_output = truncate_chars(&outcome.stdout, 500);
            if degraded {
                // 成功也注明降级：用户在日志/展示里看到两次 CLI 启动时，
                // 能一眼理解这是参数自适应而不是异常重复
                raw_output
                    .push_str("\n（已按旧版 CLI（不支持 --host）自动降级重试并成功）");
            }
            Ok(CliLoginStart {
                handle,
                verification_url,
                user_code,
                raw_output,
            })
        }
        None => {
            // 未解析到验证链接：清理会话并 kill 子进程（已退出时 kill 是安全空操作，
            // 会话不存在时幂等），错误信息带上 CLI 路径/版本/退出状态/stdout/stderr
            // 全套诊断；降级重试也失败时在 reason 里注明，用户能据此报告"我的
            // CLI 是旧版"
            cleanup_login_session(handle);
            let reason = if degraded {
                "未能从 cnb login 输出中解析授权链接（已按旧版 CLI（不支持 --host）降级重试，仍失败）"
            } else {
                "未能从 cnb login 输出中解析授权链接"
            };
            Err(cli_login_error_message(
                reason,
                &cli_path_text,
                &cli_version,
                process_state_of(outcome.exit),
                &outcome.stdout,
                &outcome.stderr,
            ))
        }
    }
}

/// 登录轮询结果：pending（等待用户授权）| success（已获取新令牌）| failed
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CliLoginPoll {
    /// "pending" | "success" | "failed"
    pub status: String,
    /// failed 时的完整诊断信息（success/pending 为空串）
    pub message: String,
}

/// Tauri 命令：轮询登录会话状态（前端每 2s 调用一次）。
///
/// 成功判定：令牌文件中出现与启动时**不同**的新 access_token（CLI 先写
/// 文件再退出，因此文件是新授权的第一信号，比等进程退出更快）。
///
/// 三元判定矩阵（顺序即优先级，改动前请先想清楚这里每一格的含义）：
///
/// | 会话存在 | 出现新令牌 | 子进程已退出 | 结论                          |
/// |----------|-----------|-------------|-------------------------------|
/// | 否       | -         | -           | 报错"会话不存在或已结束"      |
/// | 是       | 是        | 任意        | success（并移除会话）         |
/// | 是       | 否        | 是          | failed（带 stdout/stderr 诊断）|
/// | 是       | 否        | 否          | pending（继续等用户授权）     |
///
/// 注意"成功但进程还没退出"这一格：此时只移除会话、不 kill 子进程 ——
/// CLI 可能正在收尾写文件，误杀会写坏令牌文件。但**必须把它交给后台线程
/// wait() 回收**（`reap_child_in_background`），否则每次成功登录都会漏一个
/// `<defunct>` 僵尸（本应用常驻托盘，可能多天不重启）。
///
/// "启动前无令牌"的情形：`initial_access_token = None` 时任何出现的令牌
/// 都算本次新授权（用户此前从未登录过）。
#[tauri::command]
pub async fn cnb_cli_login_poll(handle: u64) -> Result<CliLoginPoll, String> {
    let token_now = tauri::async_runtime::spawn_blocking(|| read_token_entry().map(|e| e.access_token))
        .await
        .map_err(|e| format!("读取令牌状态失败: {e}"))?;

    let mut map = lock_sessions();
    let Some(session) = map.get_mut(&handle) else {
        // 会话不存在：可能已被取消或从未创建
        return Err("登录会话不存在或已结束".to_string());
    };
    let exited = session
        .child
        .try_wait()
        .map_err(|e| format!("检查登录进程状态失败: {e}"))?;

    // 判断是否出现"新"令牌（与启动时指纹不同）
    let has_new_token = match (&session.initial_access_token, &token_now) {
        (Some(previous), Some(current)) => previous != current,
        (None, Some(_)) => true, // 启动前无令牌 → 任何令牌都是本次新授权
        _ => false,
    };
    if has_new_token {
        // 授权成功：移除会话（若进程仍在收尾则留给其自行退出，避免误杀
        // 正在写文件的子进程）
        let session = map.remove(&handle).expect("session checked above");
        // 回收（reap）：`try_wait` 只回收"已退出"的子进程；若此刻 CLI 还没
        // 退出，直接 drop Child 会让它变成 `<defunct>` 僵尸 —— 本应用常驻
        // 托盘、可能连续多天不重启，每成功登录一次就漏一个僵尸进程。
        // 因此把 Child 交给后台线程 wait()（阻塞到进程真正退出，随后回收）。
        if exited.is_none() {
            reap_child_in_background(session.child);
        }
        return Ok(CliLoginPoll {
            status: "success".to_string(),
            message: String::new(),
        });
    }
    if let Some(status) = exited {
        // 进程已退出且没有新令牌：失败（摘录 stdout/stderr + 退出状态，
        // 与登录启动失败共用同一套诊断格式，便于用户对照排查）
        let session = map.remove(&handle).expect("session checked above");
        let stdout_text = snapshot(&session.stdout_buf);
        let stderr_text = snapshot(&session.stderr_tail);
        return Ok(CliLoginPoll {
            status: "failed".to_string(),
            message: cli_login_error_message(
                "cnb login 已退出但未获得新令牌",
                &session.cli_path,
                &session.cli_version,
                process_state_of(Some(status)),
                &stdout_text,
                &stderr_text,
            ),
        });
    }
    Ok(CliLoginPoll {
        status: "pending".to_string(),
        message: String::new(),
    })
}

/// Tauri 命令：取消登录会话（kill 子进程并移除会话）。
///
/// 幂等：会话不存在（已成功/已取消/从未创建）时静默成功。
/// 为什么要 kill + wait 两步：只 kill 不 wait 会留下僵尸进程，
/// 长期运行（本应用常驻托盘）会累积进程表垃圾。
#[tauri::command]
pub async fn cnb_cli_cancel_login(handle: u64) -> Result<(), String> {
    // cleanup_login_session：kill + wait（幂等，会话不存在时静默成功）
    cleanup_login_session(handle);
    Ok(())
}

// ---------------------------------------------------------------------------
// 令牌读取 / 刷新 / 退出
//
// 三者都不 spawn `cnb login`，只读/写令牌文件与调用刷新端点；
// 唯一的子进程调用是 `cnb logout`（且失败也有文件兜底，不影响结果）。
// ---------------------------------------------------------------------------

/// 令牌信息（经 IPC 传给前端；值只在 Rust ↔ 前端间流转，任何日志不输出）
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CliTokenInfo {
    /// OAuth access_token（敏感：只在 IPC 中流转）
    pub access_token: String,
    /// 刷新用 refresh_token（可能不存在，如用户手写的 PAT）
    pub refresh_token: Option<String>,
    /// 过期时间（Unix 秒；0 表示无法判断，按已过期处理）
    pub expires_at: i64,
    /// 平台根地址（刷新令牌时拼接 /oauth2/token）
    pub platform_url: String,
    /// 设备流 client_id（刷新时需带回，设备流无 secret）
    pub client_id: String,
    /// 登录入口地址（仅展示/诊断用）
    pub login_host: String,
}

/// Tauri 命令：读取当前 CLI 侧令牌（无令牌/文件损坏返回 None）。
#[tauri::command]
pub async fn cnb_cli_read_token() -> Result<Option<CliTokenInfo>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        Ok(read_token_entry().map(|entry| CliTokenInfo {
            access_token: entry.access_token,
            refresh_token: entry.refresh_token,
            expires_at: entry.expires_at,
            platform_url: entry.platform_url,
            client_id: entry.client_id,
            login_host: entry.login_host,
        }))
    })
    .await
    .map_err(|e| format!("读取令牌失败: {e}"))?
}

/// 刷新结果：refreshed=false 表示令牌仍有效、无需刷新（返回现值）
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CliRefreshResult {
    /// 当前可用的 access_token（刷新后为新值，未刷新时为原值）
    pub access_token: String,
    /// 过期时间（Unix 秒）
    pub expires_at: i64,
    /// 是否真的发生了刷新（false = 令牌仍有效）
    pub refreshed: bool,
}

/// Tauri 命令：按需刷新 OAuth 令牌（临期 <10min 或已过期时）。
///
/// 端点与参数依据 cnb-cli 源码 refreshAccessToken（dist/index.js @948223 附近）：
/// POST `{platform_url}/oauth2/token`，form `grant_type=refresh_token` +
/// `refresh_token` + `client_id`（设备流 client 无 secret，**不用** Basic 认证）；
/// 响应 200 JSON 含 access_token / expires_in / refresh_token（可选）。
/// 刷新成功后写回 ~/.cnb/token 保持 CLI 侧登录态同步。
///
/// 分步说明（每一步的失败都返回可读错误，绝不静默降级）：
/// 1. 读令牌文件 → 无令牌：直接报"请先授权登录"；
/// 2. 未临期（距过期 >10min）→ 直接返回现值，refreshed=false（零网络开销）；
/// 3. 无 refresh_token（如手写 PAT）→ 无法刷新，引导重新授权；
/// 4. 发刷新请求 → 非 200 只透出状态码（绝不打印令牌）；
/// 5. 解析响应 → 缺 access_token 视为失败；
/// 6. 写回令牌文件（保留其余 host 条目）。
#[tauri::command]
pub async fn cnb_cli_refresh_token() -> Result<CliRefreshResult, String> {
    let entry = read_token_entry().ok_or("未找到 CNB 登录令牌（~/.cnb/token），请先授权登录")?;
    let now = now_unix_secs();
    if !is_token_expired_or_expiring(entry.expires_at, now, REFRESH_MARGIN_SECS) {
        // 仍有效且距过期超过 10 分钟：无需刷新
        return Ok(CliRefreshResult {
            access_token: entry.access_token,
            expires_at: entry.expires_at,
            refreshed: false,
        });
    }
    let Some(refresh_token) = entry.refresh_token.clone().filter(|s| !s.is_empty()) else {
        // 无 refresh_token（如用户手动写入的 PAT）：无法刷新，引导重新授权
        return Err("令牌已临期且无 refresh_token，请重新授权".to_string());
    };

    let platform_url = if entry.platform_url.is_empty() {
        "https://cnb.cool".to_string()
    } else {
        entry.platform_url.clone()
    };
    let url = format!("{}/oauth2/token", platform_url.trim_end_matches('/'));
    let client_id = if entry.client_id.is_empty() {
        "cnb_cli".to_string()
    } else {
        entry.client_id.clone()
    };

    // 与 cnb_http_request 同通道策略：native-tls + no_proxy 强制直连
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .no_proxy()
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败: {e}"))?;
    let response = client
        .post(&url)
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token.as_str()),
            ("client_id", client_id.as_str()),
        ])
        .send()
        .await
        .map_err(|e| format!("刷新令牌请求失败: {e}"))?;
    if response.status() != reqwest::StatusCode::OK {
        // 刷新失败（refresh_token 过期/被吊销等）：只透出状态码，绝不打印令牌
        return Err(format!(
            "刷新令牌失败（HTTP {}），请重新授权",
            response.status().as_u16()
        ));
    }
    // 不启用 reqwest json feature：取原始文本后手动解析（与现有通道用法一致）
    let body_text = response
        .text()
        .await
        .map_err(|e| format!("读取刷新响应失败: {e}"))?;
    let body: serde_json::Value =
        serde_json::from_str(&body_text).map_err(|e| format!("解析刷新响应失败: {e}"))?;
    let new_access_token = body
        .get("access_token")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or("刷新响应缺少 access_token")?
        .to_string();
    let expires_in = body.get("expires_in").and_then(|v| v.as_i64()).unwrap_or(0);
    let new_expires_at = now + expires_in.max(0);
    // refresh_token 可能轮换：优先取响应中的新值，缺省沿用旧值（与 CLI 一致）
    let new_refresh_token = body
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .map(String::from)
        .filter(|s| !s.is_empty())
        .or_else(|| entry.refresh_token.clone());

    // 写回令牌文件保持 CLI 同步（保留其余 host 的登录态）
    update_token_entry(
        &entry.access_token,
        &new_access_token,
        new_expires_at,
        new_refresh_token.as_deref(),
    )?;

    Ok(CliRefreshResult {
        access_token: new_access_token,
        expires_at: new_expires_at,
        refreshed: true,
    })
}

/// Tauri 命令：在 CLI 侧退出登录（两端一致）。
///
/// CLI 存在时执行 `cnb logout --host cnb.cool`（只清本应用 host，不动用户
/// 其他平台的 CLI 登录态）；CLI 不存在时直接从令牌文件移除条目兜底。
///
/// # 旧版 CLI 的 --host 降级（Round 3 修复）
///
/// cnb 1.10.16 的 `logout` 同样没有 `--host` 选项，带参执行会报
/// "unknown option '--host'" 并 exit 1 且**什么都不删**。因此：带 --host
/// 执行后若非零退出且 stderr 是 unknown option 类错误，去掉 --host 重试
/// 一次。旧版不带 --host 删除的是其默认平台（cnb.cool，与本应用登录目标
/// 一致）的令牌 —— 行为可接受；且无论 CLI 成败，下方 `remove_token_entry`
/// 兜底都会直接清理 ~/.cnb/token 条目，保证退出语义完整。
#[tauri::command]
pub async fn cnb_cli_logout(app: tauri::AppHandle) -> Result<(), String> {
    // 解析失败（CLI 不可用）不阻断退出：下面还有直接改令牌文件的兜底路径
    if let Ok(cli) = resolve_cli(&app).await {
        tauri::async_runtime::spawn_blocking(move || {
            // 用 output() 而不是 status()：降级判定需要读到 stderr 原文。
            // stdout/stderr 都是管道，但 logout 输出极短（一行级别），
            // 不存在管道缓冲写满导致子进程阻塞的死锁风险。
            let with_host_output = Command::new(&cli.path)
                .args(["logout", "--host", CNB_LOGIN_HOST])
                // 同 login：JS shim 依赖 PATH 中的 node
                .env("PATH", resolved_path_env())
                .stdin(Stdio::null())
                .output();

            match with_host_output {
                Ok(output) => {
                    // 降级条件与 login 一致：非零退出 + stderr 是
                    // unknown option 类参数错误（缺一不可）。
                    if !output.status.success()
                        && is_unknown_option_failure(&String::from_utf8_lossy(
                            &output.stderr,
                        ))
                    {
                        // 去掉 --host 重试一次（只重试一次）。
                        // logout 无副作用累积问题：最多就是多删一次令牌条目。
                        let _ = Command::new(&cli.path)
                            .arg("logout")
                            .env("PATH", resolved_path_env())
                            .stdin(Stdio::null())
                            .output();
                    }
                }
                // spawn 失败（CLI 被删/权限变化等）：不影响整体结果，
                // 下方文件兜底负责保证 ~/.cnb/token 条目被清理
                Err(_) => {}
            }
        })
        .await
        .map_err(|e| format!("执行 cnb logout 失败: {e}"))?;
    }
    // 兜底：直接从令牌文件移除本 host 条目（CLI 未安装/命令失败时保证清理）
    tauri::async_runtime::spawn_blocking(|| remove_token_entry(CNB_LOGIN_HOST))
        .await
        .map_err(|e| format!("清理令牌文件失败: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 单元测试（纯函数层：令牌解析、过期判定、下载文件名、登录输出解析）
//
// 测试分组（按"防止哪类回归"划分）：
// A. 令牌文件解析 / 过期判定 —— 防止登录态被误清或永不刷新；
// B. CLI 下载文件名 —— 防止下载到错误架构的产物；
// C. 登录输出解析（含 ANSI / 缩进 / CRLF）—— 防止"有链接却解析不出"；
// D. 增量读取（pump_reader / Utf8ChunkDecoder）—— 本次 bug 的核心回归点：
//    证明"内容在第一批到达时就可见"，而不是等到 EOF；
// E. 等待循环（wait_for_login_link）—— 提前退出不空等、后到链接仍能等到；
// F. 诊断信息（cli_login_error_message）—— 空流必须显式标注 `<空>`，
//    并带上 CLI 路径 / 版本 / 退出状态，避免再次出现"原始输出：空"这种
//    无从排查的信息；
// G. 假 CLI 端到端（spawn 真实管道）—— 用 /bin/sh 假脚本模拟 `cnb login`
//    的输出时序，覆盖从 spawn 到解析成功的完整链路。
//
// 红线：本模块**绝不** spawn 真实 `cnb login`（会覆盖用户 ~/.cnb/token）。
// 所有令牌一律用假值 `cnb_test_*`；假 CLI 脚本只 printf/sleep，不碰任何文件。
//
// 本地验证方式（不接触真实 cnb，也不产生任何网络请求）：
// - 全量：`cd src-tauri && cargo test --lib`
// - 看实测数据：`cargo test --lib cnb_cli::tests::test_login_pipeline -- --nocapture`
//   → 会打印"链接解析耗时 + 子进程是否仍存活 + 累计 stdout"，
//     以及"node shim 缺 node"场景下的完整诊断信息；
// - 若未来要换真实 CLI 做端到端验证，务必先把 ~/.cnb/token 备份，且验证后还原，
//   否则测试会改写用户的真实登录态（上次故障就是这样产生副作用的）。
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // —— parse_token_file：合法输入 ——
    // 令牌值一律使用假值 cnb_test_xxx，绝不出现真实令牌

    /// 构造新格式令牌文件原文
    fn token_file_json(host: &str, access_token: &str, expires_at: &str) -> String {
        format!(
            r#"{{ "auths": {{ "{host}": {{ "access_token": "{access_token}", "refresh_token": "cnb_test_refresh", "expires_at": {expires_at}, "platform_url": "https://api.cnb.cool", "client_id": "cnb_cli", "login_host": "https://cnb.cool" }} }} }}"#
        )
    }

    // 验证点：新格式（auths.<host>）正常解析：令牌/过期时间/refresh_token/client_id 全部取到
    #[test]
    fn test_parse_token_file_valid() {
        let entry = parse_token_file(&token_file_json("cnb.cool", "cnb_test_aaa", "1793266392"))
            .expect("应解析成功");
        assert_eq!(entry.access_token, "cnb_test_aaa");
        assert_eq!(entry.expires_at, 1793266392);
        assert_eq!(entry.refresh_token.as_deref(), Some("cnb_test_refresh"));
        assert_eq!(entry.client_id, "cnb_cli");
    }

    // 验证点：多 host 共存时必须精确取 cnb.cool，不能被其他平台的条目顶掉
    #[test]
    fn test_parse_token_file_multi_host_prefers_cnb_cool() {
        let text = r#"{"auths": {"other.host": {"access_token": "cnb_test_other", "expires_at": 1}, "cnb.cool": {"access_token": "cnb_test_main", "expires_at": 2}}}"#;
        let entry = parse_token_file(text).expect("应解析成功");
        assert_eq!(entry.access_token, "cnb_test_main");
    }

    // 验证点：host 键与预期不符时兜底取第一条有效条目（防御 CLI 键名变化）
    #[test]
    fn test_parse_token_file_unknown_host_falls_back_to_first_valid() {
        let text = r#"{"auths": {"git.example.com": {"access_token": "cnb_test_fallback", "expires_at": 5}}}"#;
        let entry = parse_token_file(text).expect("应回退到第一条有效条目");
        assert_eq!(entry.access_token, "cnb_test_fallback");
    }

    // —— parse_token_file：畸形输入 ——
    #[test]
    fn test_parse_token_file_invalid_json() {
        assert!(parse_token_file("not json at all").is_none());
        assert!(parse_token_file("").is_none());
    }

    // 验证点：缺少 auths 结构（或空 auths）→ 视为未登录
    #[test]
    fn test_parse_token_file_missing_auths() {
        assert!(parse_token_file(r#"{"foo": 1}"#).is_none());
        assert!(parse_token_file(r#"{"auths": {}}"#).is_none());
    }

    // 验证点：缺 access_token 的条目无效（不允许"猜"令牌）
    #[test]
    fn test_parse_token_file_missing_access_token() {
        let text = r#"{"auths": {"cnb.cool": {"expires_at": 123}}}"#;
        assert!(parse_token_file(text).is_none());
    }

    // 验证点：空串 access_token 同样无效：空令牌会让请求全 401
    #[test]
    fn test_parse_token_file_empty_access_token() {
        let text = r#"{"auths": {"cnb.cool": {"access_token": "", "expires_at": 123}}}"#;
        assert!(parse_token_file(text).is_none());
    }

    // 验证点：expires_at 缺失/类型不对 → 记 0（已过期），走刷新分支而不是盲信
    #[test]
    fn test_parse_token_file_expires_at_missing_or_string() {
        // 缺失 expires_at → 记 0（已过期），access_token 仍可用
        let entry = parse_token_file(r#"{"auths": {"cnb.cool": {"access_token": "cnb_test_x"}}}"#)
            .expect("缺失 expires_at 不应整体失败");
        assert_eq!(entry.expires_at, 0);
        // 字符串 expires_at → 同样记 0，绝不猜值
        let entry = parse_token_file(
            r#"{"auths": {"cnb.cool": {"access_token": "cnb_test_x", "expires_at": "1793266392"}}}"#,
        )
        .expect("字符串 expires_at 不应整体失败");
        assert_eq!(entry.expires_at, 0);
    }

    // 验证点：兼容 CLI 旧版扁平格式（access_token 在顶层），老用户不必重新登录
    #[test]
    fn test_parse_token_file_legacy_flat_format() {
        // 旧版扁平格式（access_token 在顶层）应兼容（CLI readTokenFile 同样兼容）
        let text = r#"{"access_token": "cnb_test_legacy", "expires_at": 42}"#;
        let entry = parse_token_file(text).expect("应兼容旧版扁平格式");
        assert_eq!(entry.access_token, "cnb_test_legacy");
        assert_eq!(entry.expires_at, 42);
    }

    // —— 过期判定（含 <10min 临界） ——
    #[test]
    fn test_expiry_boundary_10min_margin() {
        let margin = 600i64;
        let expires_at = 10_000i64;
        // 距过期还有 10 分钟 + 1s：未临期
        assert!(!is_token_expired_or_expiring(expires_at, expires_at - margin - 1, margin));
        // 恰好等于 10 分钟：已算临期（提前刷新优先于压哨使用）
        assert!(is_token_expired_or_expiring(expires_at, expires_at - margin, margin));
        // 已过期
        assert!(is_token_expired_or_expiring(expires_at, expires_at + 1, margin));
        // expires_at 为 0（解析失败的兜底值）：任何当前时间都算临期
        assert!(is_token_expired_or_expiring(0, 1, margin));
    }

    // —— cli_download_filename：平台/架构命名 ——
    #[test]
    fn test_cli_download_filename() {
        assert_eq!(
            cli_download_filename("macos", "aarch64").as_deref(),
            Ok("cnb-darwin-arm64")
        );
        assert_eq!(
            cli_download_filename("darwin", "x86_64").as_deref(),
            Ok("cnb-darwin-x64")
        );
        assert_eq!(
            cli_download_filename("linux", "x86_64").as_deref(),
            Ok("cnb-linux-x64")
        );
        assert_eq!(
            cli_download_filename("windows", "x86_64").as_deref(),
            Ok("cnb-windows-x64.exe")
        );
        // 不认识的平台/架构必须拒绝（绝不下载错误产物）
        assert!(cli_download_filename("freebsd", "x86_64").is_err());
        assert!(cli_download_filename("macos", "riscv64").is_err());
    }

    // —— parse_login_output：实测输出格式 ——
    #[test]
    fn test_parse_login_output_real_format() {
        // 实测 cnb 1.18.3 stdout 管道输出（user_code 为假值）
        let output = "\n请打开以下链接完成授权：\n  https://cnb.cool/oauth2/device/verify?user_code=TESTCODE\n\n(已尝试自动打开浏览器，若未打开请手动复制上方链接)\n正在等待授权...\n\n登录成功 🎉\n";
        let (url, code) = parse_login_output(output).expect("应解析出验证链接");
        assert_eq!(url, "https://cnb.cool/oauth2/device/verify?user_code=TESTCODE");
        assert_eq!(code, "TESTCODE");
    }

    // 验证点：无链接时返回 None（上层据此给出含原文的错误信息）
    #[test]
    fn test_parse_login_output_no_url() {
        assert!(parse_login_output("空输出").is_none());
        assert!(parse_login_output("").is_none());
    }

    // 验证点：query 参数提取的三种情况：命中 / 无该参数 / 无 query
    #[test]
    fn test_extract_query_param() {
        assert_eq!(
            extract_query_param("https://cnb.cool/p?user_code=AB12&x=1", "user_code").as_deref(),
            Some("AB12")
        );
        assert_eq!(extract_query_param("https://cnb.cool/p", "user_code"), None);
        assert_eq!(
            extract_query_param("https://cnb.cool/p?other=1", "user_code"),
            None
        );
    }

    // —— truncate_chars：多字节安全截断 ——
    #[test]
    fn test_truncate_chars_multibyte() {
        assert_eq!(truncate_chars("你好世界", 10), "你好世界");
        assert_eq!(truncate_chars("你好世界", 2), "你好…");
        assert_eq!(truncate_chars("", 5), "");
    }

    // =======================================================================
    // 以下为 QA 对抗性补充用例（只含测试，零生产代码改动）
    // =======================================================================

    // 验证点：负 expires_at（时钟异常写入）不得整体失败，且必须判临期
    #[test]
    fn test_parse_token_file_expires_at_negative() {
        // 负数 expires_at（如系统时钟异常写入）：不应整体失败，且必须判临期
        let entry = parse_token_file(
            r#"{"auths": {"cnb.cool": {"access_token": "cnb_test_x", "expires_at": -5}}}"#,
        )
        .expect("负数 expires_at 不应整体失败");
        assert_eq!(entry.expires_at, -5);
        assert!(is_token_expired_or_expiring(entry.expires_at, 0, 600));
    }

    // 验证点：未知字段不影响解析（CLI 加字段不应让旧版应用无法登录）
    #[test]
    fn test_parse_token_file_unknown_fields_ignored() {
        // JSON 带未知字段：解析不受影响（写回时也必须保留，见 update_token_entry）
        let text = r#"{"auths": {"cnb.cool": {"access_token": "cnb_test_x", "expires_at": 10, "extra_unknown": {"a": 1}, "scopes": "repo-code:r"}}}"#;
        let entry = parse_token_file(text).expect("含未知字段应解析成功");
        assert_eq!(entry.access_token, "cnb_test_x");
        assert_eq!(entry.expires_at, 10);
    }

    // 验证点：单位契约：expires_at 是 Unix 秒；误按毫秒会让令牌永不刷新
    #[test]
    fn test_parse_token_file_expires_at_is_seconds() {
        // 契约钉死：expires_at 按 Unix 秒解释。CLI 源码（1.18.x dist/index.js
        // saveToken/refreshAccessToken）为 Math.floor(Date.now()/1000) + expires_in。
        // 若误按毫秒解释，is_token_expired_or_expiring 会判"远未过期"导致永不刷新。
        let ms_like = 1_793_267_245_000i64; // 同一时刻的毫秒表示
        let now = 1_793_267_245i64; // 同一时刻的秒表示
        assert!(!is_token_expired_or_expiring(ms_like, now, 600));
        // 同一时刻的秒值则按临期语义正确判定（还剩 599s < 600s 阈值）
        assert!(is_token_expired_or_expiring(now + 599, now, 600));
    }

    // 验证点：链接带额外 query 参数时 user_code 仍要能提取
    #[test]
    fn test_parse_login_output_extra_query_params() {
        // verification_uri_complete 带额外 query 参数：user_code 仍能提取
        let output = "\n请打开以下链接完成授权：\n  https://cnb.cool/oauth2/device/verify?foo=1&user_code=CODE42&bar=x\n";
        let (url, code) = parse_login_output(output).expect("应解析出验证链接");
        assert!(url.contains("user_code=CODE42"));
        assert_eq!(code, "CODE42");
    }

    // 验证点：纯 verification_uri（无 user_code）时链接仍可用，设备码为空串
    #[test]
    fn test_parse_login_output_missing_user_code() {
        // 缺 user_code（纯 verification_uri）：链接仍返回，code 为空串，
        // 前端据此隐藏设备码区、仅展示"打开授权页面"按钮
        let (url, code) = parse_login_output("  https://cnb.cool/oauth2/device/verify\n")
            .expect("应解析出链接");
        assert_eq!(code, "");
        assert_eq!(url, "https://cnb.cool/oauth2/device/verify");
    }

    // 验证点：多 host 时损坏条目被跳过，绝不被空令牌/非对象条目带崩
    #[test]
    fn test_parse_token_file_malformed_entries_are_skipped() {
        // 多 host 场景：cnb.cool 条目损坏时，兜底逻辑取其余第一条**有效**条目，
        // 且绝不被空 access_token / 非 object 的条目带崩
        let text = r#"{"auths": {"cnb.cool": {"expires_at": 1}, "a.example.com": {"access_token": "cnb_test_valid", "expires_at": 2}, "b.example.com": "not-an-object"}}"#;
        let entry = parse_token_file(text).expect("应跳过损坏条目取有效条目");
        assert_eq!(entry.access_token, "cnb_test_valid");
    }

    // =======================================================================
    // 本次 Bug 修复的回归用例（增量读取 / ANSI / 提前退出诊断 / 假 CLI 端到端）
    // =======================================================================

    /// 分块 Read 桩：按 chunks 顺序逐次返回，最后返回 EOF。
    /// 用于证明"内容在第一块到达时就可见"，而不是等到 EOF 才可见。
    struct StagedReader {
        chunks: Vec<Vec<u8>>,
        index: usize,
    }

    impl StagedReader {
        fn new(chunks: Vec<&[u8]>) -> Self {
            Self {
                chunks: chunks.into_iter().map(|c| c.to_vec()).collect(),
                index: 0,
            }
        }
    }

    impl Read for StagedReader {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.index >= self.chunks.len() {
                return Ok(0); // EOF
            }
            let chunk = &self.chunks[self.index];
            let n = chunk.len().min(buf.len());
            buf[..n].copy_from_slice(&chunk[..n]);
            self.index += 1;
            Ok(n)
        }
    }

    #[test]
    fn test_pump_reader_delivers_partial_output_before_eof() {
        // 复现原 bug 的关键差异：第一块（标题行）到达时就应立即可见；
        // 旧实现 read_to_string 在这时缓冲区仍是空的。
        let header = "\n请打开以下链接完成授权：\n".as_bytes();
        let url = "  https://cnb.cool/oauth2/device/verify?user_code=STAGE01\n".as_bytes();
        let mut reader = StagedReader::new(vec![header, url]);

        let mut collected = String::new();
        let mut snapshots: Vec<String> = Vec::new();
        pump_reader(&mut reader, &mut |text| {
            collected.push_str(text);
            // 每次回调都记一次快照，等价于"上层轮询看到的内容"
            snapshots.push(collected.clone());
        });

        assert!(
            snapshots.len() >= 2,
            "应至少分两批交付，实际 {} 批",
            snapshots.len()
        );
        // 第一批只有标题行：此时还没有链接（但已有内容，可据此判断"卡在哪一步"）
        assert!(snapshots[0].contains("请打开以下链接"));
        assert!(parse_login_output(&snapshots[0]).is_none());
        // 第二批后链接可解析 —— 证明增量读取生效
        let (parsed_url, code) = parse_login_output(&collected).expect("增量读取后应能解析出链接");
        assert_eq!(code, "STAGE01");
        assert_eq!(
            parsed_url,
            "https://cnb.cool/oauth2/device/verify?user_code=STAGE01"
        );
    }

    #[test]
    fn test_pump_reader_preserves_multibyte_chars_split_across_chunks() {
        // 在"权"字的 UTF-8 中间切开（E6 9D 83 → 前 2 字节 + 后 1 字节）
        let bytes = "授权".as_bytes().to_vec();
        let mut reader = StagedReader::new(vec![&bytes[..2], &bytes[2..]]);
        let mut collected = String::new();
        pump_reader(&mut reader, &mut |text| collected.push_str(text));
        assert_eq!(collected, "授权");
        assert!(
            !collected.contains('\u{fffd}'),
            "跨块切分的多字节字符不得出现替换字符"
        );
    }

    #[test]
    fn test_utf8_decoder_invalid_bytes_are_replaced_not_stuck() {
        // 真实非法字节（0xFF）：应替换为 U+FFFD 并继续解码后续内容，
        // 绝不能卡在 pending 里导致后续输出全部丢失
        let mut decoder = Utf8ChunkDecoder::default();
        let mut out = decoder.push(&[0xff]);
        out.push_str(&decoder.push("https://ok".as_bytes()));
        assert!(out.contains('\u{fffd}'));
        assert!(out.contains("https://ok"));
        assert_eq!(decoder.finish(), "");
    }

    #[test]
    fn test_pump_reader_empty_stream() {
        let mut reader = StagedReader::new(vec![]);
        let mut called = false;
        pump_reader(&mut reader, &mut |_| called = true);
        assert!(!called, "空流不应产生任何回调");
    }

    // —— ANSI 转义序列剥离 ——
    #[test]
    fn test_strip_ansi_csi_sequences() {
        assert_eq!(strip_ansi("\u{1b}[36mhttps://x\u{1b}[0m"), "https://x");
        assert_eq!(strip_ansi("普通文本"), "普通文本");
        assert_eq!(strip_ansi(""), "");
        // 未终止的 CSI（输出被截断）：吞到末尾，不 panic
        assert_eq!(strip_ansi("abc\u{1b}[38;5;"), "abc");
        // 两字节序列 ESC c（全量重置）
        assert_eq!(strip_ansi("a\u{1b}cb"), "ab");
        // OSC 序列（以 BEL 结束）
        assert_eq!(strip_ansi("\u{1b}]0;title\u{7}ok"), "ok");
    }

    #[test]
    fn test_parse_login_output_with_ansi_colors() {
        // 真实触发场景：CLI 着色后链接行变成 \x1b[36mhttps://...\x1b[0m，
        // trim() 去不掉 ESC，旧实现会判"没有链接"
        let output = "\n请打开以下链接完成授权：\n  \u{1b}[36mhttps://cnb.cool/oauth2/device/verify?user_code=ANSI01\u{1b}[0m\n";
        let (url, code) = parse_login_output(output).expect("带 ANSI 颜色码的链接也必须解析出来");
        assert_eq!(url, "https://cnb.cool/oauth2/device/verify?user_code=ANSI01");
        assert_eq!(code, "ANSI01");
    }

    #[test]
    fn test_parse_login_output_indented_and_crlf() {
        // 缩进 + Windows 换行（\r 残留）：trim() 需同时处理两者
        let output = "标题\r\n    https://cnb.cool/oauth2/device/verify?user_code=CRLF01\r\n";
        let (url, code) = parse_login_output(output).expect("应解析出链接");
        assert_eq!(url, "https://cnb.cool/oauth2/device/verify?user_code=CRLF01");
        assert_eq!(code, "CRLF01");
    }

    // —— Node shim 识别 ——
    #[test]
    fn test_is_node_script() {
        assert!(is_node_script(b"#!/usr/bin/env node\nrequire('x')"));
        assert!(is_node_script(b"#!/usr/local/bin/node\n"));
        assert!(!is_node_script(b"#!/bin/sh\necho hi"));
        // 二进制文件（无 shebang）
        assert!(!is_node_script(&[0xcf, 0xfa, 0xed, 0xfe]));
        assert!(!is_node_script(b""));
    }

    // —— 子进程状态与诊断信息 ——
    #[test]
    fn test_process_state_describe_all_branches() {
        assert_eq!(ProcessState::Running.describe(), "进程仍在运行（未退出）");
        assert_eq!(
            ProcessState::Exited {
                code: Some(1),
                signal: None
            }
            .describe(),
            "已退出, exit code=1"
        );
        assert_eq!(
            ProcessState::Exited {
                code: None,
                signal: Some(9)
            }
            .describe(),
            "已退出, signal=9（被信号终止）"
        );
        assert_eq!(
            ProcessState::Exited {
                code: None,
                signal: None
            }
            .describe(),
            "已退出（退出状态未知）"
        );
    }

    #[test]
    fn test_process_state_of_none_is_running() {
        assert_eq!(process_state_of(None), ProcessState::Running);
    }

    #[test]
    fn test_cli_login_error_message_running_branch() {
        // still-running 分支：错误信息必须带上路径/版本/状态/stdout/stderr
        let message = cli_login_error_message(
            "未能从 cnb login 输出中解析授权链接",
            "/tmp/fake/cnb",
            "1.18.3",
            ProcessState::Running,
            "\n请打开以下链接完成授权：\n",
            "",
        );
        assert!(message.contains("CLI: /tmp/fake/cnb"));
        assert!(message.contains("版本: 1.18.3"));
        assert!(message.contains("进程仍在运行"));
        // 有内容就展示，空流显式标注 <空>（不再出现"原始输出："后一片空白）
        assert!(message.contains("stdout: 请打开以下链接完成授权："));
        assert!(message.contains("stderr: <空>"));
    }

    #[test]
    fn test_cli_login_error_message_exited_branch() {
        // exited(code) 分支：必须写明退出码，并把 stderr 线索带出来
        let message = cli_login_error_message(
            "未能从 cnb login 输出中解析授权链接",
            "/usr/local/bin/cnb",
            "1.18.3",
            ProcessState::Exited {
                code: Some(127),
                signal: None,
            },
            "",
            "env: node: No such file or directory",
        );
        assert!(message.contains("exit code=127"));
        assert!(message.contains("stdout: <空>"));
        assert!(message.contains("env: node: No such file or directory"));
    }

    #[test]
    fn test_cli_login_error_message_truncates_streams() {
        // 超长输出截断到 300 字符（不可信文本只摘录，不整段回显）
        let long = "x".repeat(1000);
        let message = cli_login_error_message(
            "原因",
            "/p",
            "v",
            ProcessState::Running,
            &long,
            &long,
        );
        assert!(message.contains("…"), "超长输出应带省略号");
        assert!(
            message.chars().count() < 1000,
            "错误信息不应包含完整超长输出"
        );
    }

    #[test]
    fn test_describe_stream_strips_ansi() {
        assert_eq!(describe_stream("\u{1b}[31m错误\u{1b}[0m"), "错误");
        assert_eq!(describe_stream("   "), "<空>");
    }

    // —— 等待循环：提前退出不空等 / 分两段输出仍能拿到链接 ——
    #[test]
    fn test_wait_for_login_link_detects_url_written_later() {
        // 模拟"标题行先到、链接 200ms 后到"（进程持续存活）
        let stdout_buf = Arc::new(Mutex::new(String::new()));
        let stderr_buf = Arc::new(Mutex::new(String::new()));
        let writer = stdout_buf.clone();
        std::thread::spawn(move || {
            writer
                .lock()
                .unwrap()
                .push_str("\n请打开以下链接完成授权：\n");
            std::thread::sleep(Duration::from_millis(200));
            writer
                .lock()
                .unwrap()
                .push_str("  https://cnb.cool/oauth2/device/verify?user_code=LATE01\n");
        });

        let started = std::time::Instant::now();
        let outcome = wait_for_login_link(&stdout_buf, &stderr_buf, &|| None);
        let elapsed = started.elapsed();

        let (url, code) = outcome.parsed.expect("后到的链接也应被等到");
        assert_eq!(code, "LATE01");
        assert!(url.contains("user_code=LATE01"));
        assert!(
            elapsed < Duration::from_secs(5),
            "链接到达后应立即返回，实际耗时 {elapsed:?}"
        );
        assert!(outcome.exit.is_none());
    }

    #[test]
    fn test_wait_for_login_link_returns_immediately_when_child_exited() {
        // 子进程提前退出（如 JS shim 缺 node）：必须立刻返回，不得空等 10s
        let stdout_buf = Arc::new(Mutex::new(String::new()));
        let stderr_buf = Arc::new(Mutex::new(String::new()));
        stderr_buf
            .lock()
            .unwrap()
            .push_str("env: node: No such file or directory\n");

        let started = std::time::Instant::now();
        let outcome = wait_for_login_link(&stdout_buf, &stderr_buf, &|| {
            // 用当前进程的退出状态构造一个"已退出"返回值（纯数据，无需真实子进程）
            std::process::Command::new("/bin/sh")
                .args(["-c", "exit 127"])
                .status()
                .ok()
        });
        let elapsed = started.elapsed();

        assert!(outcome.parsed.is_none());
        assert!(outcome.exit.is_some(), "应带回退出状态");
        assert_eq!(outcome.exit.and_then(|s| s.code()), Some(127));
        assert!(outcome.stderr.contains("env: node"));
        assert!(
            elapsed < Duration::from_secs(2),
            "提前退出应立即返回，实际耗时 {elapsed:?}"
        );
    }

    #[test]
    fn test_wait_for_login_link_empty_output_no_url() {
        // 完全无输出且进程存活：走完正常窗口 + 无追加等待（无部分输出），
        // 返回 None 且 stdout 为空
        let stdout_buf = Arc::new(Mutex::new(String::new()));
        let stderr_buf = Arc::new(Mutex::new(String::new()));
        let started = std::time::Instant::now();
        let outcome = wait_for_login_link(&stdout_buf, &stderr_buf, &|| None);
        assert!(outcome.parsed.is_none());
        assert!(outcome.stdout.is_empty());
        assert!(
            started.elapsed() >= Duration::from_millis(LOGIN_OUTPUT_WAIT_MS - 500),
            "无任何输出时应等满正常窗口"
        );
    }

    /// 假 cnb 脚本端到端用例：用 /bin/sh 脚本模拟 `cnb login` 的输出时序，
    /// 验证"spawn → 增量读取 → 解析出链接"整条链路。
    ///
    /// 红线：绝不 spawn 真实 `cnb login`（会覆盖用户 ~/.cnb/token）。
    /// 本用例的脚本只 printf + sleep，不碰任何文件。
    #[cfg(unix)]
    #[test]
    fn test_login_pipeline_with_fake_cli_script() {
        use std::os::unix::fs::OpenOptionsExt;

        let dir = std::env::temp_dir().join(format!("wocnb-fake-cnb-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("创建临时目录");
        let script_path = dir.join("cnb");
        let script = "#!/bin/sh\n\
             printf '\\n请打开以下链接完成授权：\\n'\n\
             sleep 0.3\n\
             printf '  https://cnb.cool/oauth2/device/verify?user_code=FAKE01\\n'\n\
             sleep 5\n";
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o755)
            .open(&script_path)
            .expect("写入假 cnb 脚本");
        file.write_all(script.as_bytes()).expect("写入脚本内容");
        drop(file);

        // 用绝对路径 spawn（与生产代码同一条路径：stdout/stderr 都是管道）
        let mut child = Command::new(&script_path)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn 假 cnb 脚本");

        let stdout_buf = Arc::new(Mutex::new(String::new()));
        if let Some(stdout) = child.stdout.take() {
            spawn_output_reader(stdout, stdout_buf.clone());
        }
        let stderr_buf = Arc::new(Mutex::new(String::new()));
        if let Some(stderr) = child.stderr.take() {
            spawn_output_reader(stderr, stderr_buf.clone());
        }

        let started = std::time::Instant::now();
        // RefCell：等待函数接收 `&dyn Fn`（不可变借用），而 try_wait 需要 &mut，
        // 单线程内用 RefCell 提供内部可变性即可（生产代码走 session 表的 Mutex）
        let child = std::cell::RefCell::new(child);
        let outcome = wait_for_login_link(&stdout_buf, &stderr_buf, &|| {
            child.borrow_mut().try_wait().ok().flatten()
        });
        let elapsed = started.elapsed();

        // 关键断言：子进程仍在 sleep（存活 5s）时，链接就已经被解析出来
        assert!(
            outcome.exit.is_none(),
            "解析成功时子进程应仍在等待授权，而非已退出"
        );
        let (url, code) = outcome.parsed.expect("应从假脚本输出中解析出链接");
        assert_eq!(code, "FAKE01");
        assert!(url.starts_with("https://cnb.cool/oauth2/device/verify"));
        assert!(
            elapsed < Duration::from_secs(3),
            "增量读取应在秒级拿到链接，实际耗时 {elapsed:?}"
        );
        // --nocapture 时输出可核对的实测数据（脚本先打印标题、0.3s 后才打印链接）
        eprintln!(
            "[假 cnb 脚本] 链接解析耗时 {elapsed:?}（子进程仍存活={}），累计 stdout={:?}",
            outcome.exit.is_none(),
            outcome.stdout
        );

        let mut child = child.into_inner();
        let _ = child.kill();
        let _ = child.wait();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 环境差异用例：模拟"JS shim + GUI 受限 PATH（无 node）"这一失效场景，
    /// 验证 ① 不再空等 10s（进程秒退即返回）② 错误信息能带出 node 缺失线索。
    ///
    /// 为什么用 `#!/usr/bin/env node` 的假脚本：与真实 npm 安装的 cnb shim
    /// 完全同构（那次故障的第二候选成因），但不会触碰任何真实令牌文件。
    #[cfg(unix)]
    #[test]
    fn test_login_pipeline_reports_node_shim_failure_fast() {
        use std::os::unix::fs::OpenOptionsExt;

        let dir = std::env::temp_dir().join(format!("wocnb-fake-shim-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("创建临时目录");
        let script_path = dir.join("cnb");
        // 与 npm bin/cnb.js 一致：shebang 依赖 PATH 中的 node
        let script = "#!/usr/bin/env node\nconsole.log('should not run');\n";
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o755)
            .open(&script_path)
            .expect("写入假 shim");
        file.write_all(script.as_bytes()).expect("写入脚本内容");
        drop(file);

        // 受限 PATH：只含系统目录（等价 launchd 派发给 .app 的默认 PATH）
        let mut child = Command::new(&script_path)
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn 假 shim");

        let stdout_buf = Arc::new(Mutex::new(String::new()));
        if let Some(stdout) = child.stdout.take() {
            spawn_output_reader(stdout, stdout_buf.clone());
        }
        let stderr_buf = Arc::new(Mutex::new(String::new()));
        if let Some(stderr) = child.stderr.take() {
            spawn_output_reader(stderr, stderr_buf.clone());
        }

        let started = std::time::Instant::now();
        let child = std::cell::RefCell::new(child);
        let outcome = wait_for_login_link(&stdout_buf, &stderr_buf, &|| {
            child.borrow_mut().try_wait().ok().flatten()
        });
        let elapsed = started.elapsed();

        let message = cli_login_error_message(
            "未能从 cnb login 输出中解析授权链接",
            &script_path.to_string_lossy(),
            "未知（--version 不可用）",
            process_state_of(outcome.exit),
            &outcome.stdout,
            &outcome.stderr,
        );
        // --nocapture 时用于人工核对诊断信息是否完整（不影响断言）
        eprintln!("[node-shim 缺失 node 场景] 耗时 {elapsed:?}\n{message}");

        let mut child = child.into_inner();
        let _ = child.wait();
        let _ = std::fs::remove_dir_all(&dir);

        // ① 进程秒退 → 立即返回，不再空等满 10s
        assert!(
            elapsed < Duration::from_secs(2),
            "进程提前退出应立即返回，实际耗时 {elapsed:?}"
        );
        // ② stdout 为空但错误信息显式标注 <空>，stderr 带出 node 缺失线索
        assert!(message.contains("stdout: <空>"), "空 stdout 应显式标注");
        assert!(
            message.contains("node"),
            "错误信息应带出 node 运行时缺失的线索，实际: {message}"
        );
        // ③ 带上退出状态（env 找不到 node 时退出码 127）
        assert!(message.contains("已退出"), "应标明子进程已退出");
    }

    // =======================================================================
    // Round 2 修复的回归用例（Q-1 EINTR / Q-2 僵尸回收 / Q-4 PATH 污染）
    // =======================================================================

    #[test]
    fn test_pump_reader_survives_interrupted_then_eof() {
        // Q-1 回归：EINTR 之后正常读到数据、再正常 EOF，全程不得丢内容
        struct InterruptThenData {
            calls: u32,
        }
        impl Read for InterruptThenData {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                self.calls += 1;
                match self.calls {
                    1 => Err(std::io::Error::new(
                        std::io::ErrorKind::Interrupted,
                        "EINTR",
                    )),
                    2 => {
                        let payload = b"  https://cnb.cool/oauth2/device/verify?user_code=EINTR2\n";
                        let n = payload.len().min(buf.len());
                        buf[..n].copy_from_slice(&payload[..n]);
                        Ok(n)
                    }
                    _ => Ok(0),
                }
            }
        }
        let mut reader = InterruptThenData { calls: 0 };
        let mut collected = String::new();
        pump_reader(&mut reader, &mut |text| collected.push_str(text));
        let code = parse_login_output(&collected).map(|(_, code)| code);
        assert_eq!(code.as_deref(), Some("EINTR2"), "EINTR 不应终结读取");
    }

    #[cfg(unix)]
    #[test]
    fn test_reap_child_in_background_waits_for_exit() {
        // Q-2 回归：把"仍在运行"的子进程交给后台回收线程，该线程必须等到
        // 进程真正退出才返回（= 调用了 wait，僵尸会被 GC）。
        let child = Command::new("/bin/sh")
            .args(["-c", "sleep 0.3"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn 子进程");
        let started = std::time::Instant::now();
        let reaper = reap_child_in_background(child);
        reaper.join().expect("回收线程应正常结束");
        let elapsed = started.elapsed();
        assert!(
            elapsed >= Duration::from_millis(200),
            "回收线程必须 wait 到子进程退出，实际仅 {elapsed:?}"
        );
    }

    // —— Q-4：登录 shell 输出污染与 PATH 项过滤 ——
    #[test]
    fn test_extract_sentinel_path_ignores_shell_noise() {
        // 真实污染形态：.zprofile 的 echo 与 PATH 黏连成一行
        let polluted = "__CNB_PATH_BEGIN__/usr/bin:/bin:/Users/me/.local/bin__CNB_PATH_END__";
        assert_eq!(
            extract_sentinel_path(polluted).as_deref(),
            Some("/usr/bin:/bin:/Users/me/.local/bin")
        );
        // 前置噪声（echo 的提示行）+ 后置噪声（收尾提示）
        let noisy = "Welcome to zsh\nnvm loaded\n__CNB_PATH_BEGIN__/usr/bin:/opt/homebrew/bin__CNB_PATH_END__\nbye\n";
        assert_eq!(
            extract_sentinel_path(noisy).as_deref(),
            Some("/usr/bin:/opt/homebrew/bin")
        );
        // 无换行、多次出现时取第一对标记
        let twice = "__CNB_PATH_BEGIN__/a__CNB_PATH_END____CNB_PATH_BEGIN__/b__CNB_PATH_END__";
        assert_eq!(extract_sentinel_path(twice).as_deref(), Some("/a"));
    }

    #[test]
    fn test_extract_sentinel_path_rejects_broken_output() {
        // 标记缺失：必须返回 None（调用方退回进程自身 PATH），
        // 绝不能把半截垃圾当成 PATH —— 那会引入完全无关的目录
        assert_eq!(extract_sentinel_path("/usr/bin:/bin"), None);
        assert_eq!(extract_sentinel_path("__CNB_PATH_BEGIN__/usr/bin"), None);
        assert_eq!(extract_sentinel_path(""), None);
        // 标记之间为空：等价于探测失败
        assert_eq!(
            extract_sentinel_path("__CNB_PATH_BEGIN____CNB_PATH_END__"),
            None
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_merge_path_dirs_filters_relative_and_bare_dot() {
        // 实测污染样本：粘连坏项 + 裸 `.` + 相对项 + 重复项
        let polluted = "/usr/bin:.:~/Library/Python/3.9/bineval:/Users/me/go/bin:relative/bin:/usr/bin:";
        let mut dirs: Vec<PathBuf> = Vec::new();
        merge_path_dirs(&mut dirs, polluted);
        let as_strings: Vec<String> = dirs
            .iter()
            .map(|d| d.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            as_strings,
            vec![
                "/usr/bin".to_string(),
                "/Users/me/go/bin".to_string()
            ],
            "只保留绝对路径且去重（裸 . / 相对项 / 空项必须丢弃）"
        );
        // 裸 `.` 是 PATH 劫持面：绝不能让 path_lookup 去查 <CWD>/cnb
        assert!(!as_strings.iter().any(|d| d == "."), "裸 . 必须被过滤");
    }

    #[test]
    fn test_is_usable_path_entry() {
        assert!(is_usable_path_entry(Path::new("/usr/bin")));
        assert!(!is_usable_path_entry(Path::new(".")));
        assert!(!is_usable_path_entry(Path::new("..")));
        assert!(!is_usable_path_entry(Path::new("relative/bin")));
        assert!(!is_usable_path_entry(Path::new("")));
        assert!(!is_usable_path_entry(Path::new("~/not-expanded")));
    }

    #[test]
    fn test_merge_path_dirs_keeps_priority_order() {
        // 当前 PATH 优先：登录 shell PATH 只在追加位置补充
        let mut dirs: Vec<PathBuf> = Vec::new();
        merge_path_dirs(&mut dirs, "/opt/homebrew/bin:/usr/bin");
        merge_path_dirs(&mut dirs, "/usr/bin:/usr/local/bin");
        let as_strings: Vec<String> = dirs
            .iter()
            .map(|d| d.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            as_strings,
            vec!["/opt/homebrew/bin", "/usr/bin", "/usr/local/bin"]
        );
    }

    #[test]
    fn test_resolved_path_env_never_yields_junk_entries() {
        // 端到端断言（环境相关但结论稳定）：无论登录 shell 输出被怎样污染，
        // 最终 PATH 必须非空且只含绝对路径 —— 这正是不让脏项进入
        // path_lookup 的最后一道闸门（Q-4 的验收点）。
        let path = resolved_path_env();
        assert!(!path.is_empty(), "合并后的 PATH 不应为空");
        for dir in std::env::split_paths(path) {
            assert!(
                dir.is_absolute(),
                "合并后的 PATH 不允许出现相对项/裸 .，实际: {dir:?}"
            );
        }
    }

    // =======================================================================
    // QA 独立回归补充用例（Round 2，独立视角；只含测试，零生产代码改动）
    //
    // 覆盖工程师用例未覆盖的边界：
    // 1. Utf8ChunkDecoder 的 1+1+1 / 1+2 / 2+1 / 3+1 四种切分组合；
    // 2. strip_ansi 的 OSC-ST / 两字节 / 连续序列 / 不误伤普通方括号；
    // 3. cli_login_error_message 三态 + 双空流 + 300 字符多字节边界；
    // 4. parse_login_output 纯 CRLF；
    // 5. 管道背压：超过 MAX_CAPTURE_BYTES 后仍必须消费管道（否则子进程写阻塞死锁）；
    // 6. 无换行结尾的链接（证明用 fill_buf 而不是 read_until 是正确的）；
    // 7. pump_reader 遇 EINTR 的行为（Q-1 已修复，现为回归锁，不再 ignore）。
    // =======================================================================
    mod qa_round2 {
        use super::*;
        use std::sync::atomic::{AtomicBool, Ordering};

        // —— 1. Utf8ChunkDecoder 的切分组合 ——

        /// 按给定切分点喂入字节，返回累计文本（模拟任意分块边界）
        fn decode_with_splits(bytes: &[u8], cuts: &[usize]) -> String {
            let mut decoder = Utf8ChunkDecoder::default();
            let mut out = String::new();
            let mut prev = 0usize;
            for &cut in cuts {
                out.push_str(&decoder.push(&bytes[prev..cut]));
                prev = cut;
            }
            out.push_str(&decoder.push(&bytes[prev..]));
            out.push_str(&decoder.finish());
            out
        }

        #[test]
        fn test_qa_utf8_decoder_three_byte_split_1_1_1() {
            // "权" = E6 9D 83，按 1+1+1 逐字节到达
            let bytes = "权".as_bytes();
            assert_eq!(bytes.len(), 3);
            let text = decode_with_splits(bytes, &[1, 2]);
            assert_eq!(text, "权");
            assert!(!text.contains('\u{fffd}'), "逐字节到达不得产生替换字符");
        }

        #[test]
        fn test_qa_utf8_decoder_three_byte_split_1_2() {
            let bytes = "权".as_bytes();
            assert_eq!(decode_with_splits(bytes, &[1]), "权");
        }

        #[test]
        fn test_qa_utf8_decoder_three_byte_split_2_1() {
            let bytes = "权".as_bytes();
            assert_eq!(decode_with_splits(bytes, &[2]), "权");
        }

        #[test]
        fn test_qa_utf8_decoder_four_byte_emoji_split_3_1() {
            // "🎉" = F0 9F 8E 89（4 字节），按 3+1 切在最后一个字节前
            let bytes = "🎉".as_bytes();
            assert_eq!(bytes.len(), 4);
            let text = decode_with_splits(bytes, &[3]);
            assert_eq!(text, "🎉");
            assert!(!text.contains('\u{fffd}'), "4 字节 emoji 拆分不得产生替换字符");
        }

        #[test]
        fn test_qa_utf8_decoder_recovers_after_invalid_byte() {
            // 非法字节夹在中间：后续正常文本（含中文）必须继续解出
            let mut decoder = Utf8ChunkDecoder::default();
            let mut out = decoder.push(b"ok\xff");
            out.push_str(&decoder.push("授权".as_bytes()));
            out.push_str(&decoder.finish());
            assert!(out.starts_with("ok"), "非法字节前的正常文本必须保留");
            assert!(out.contains('\u{fffd}'), "非法字节应被替换而不是静默丢弃");
            assert!(out.ends_with("授权"), "非法字节之后的文本必须继续解出");
        }

        // —— 2. strip_ansi ——

        #[test]
        fn test_qa_strip_ansi_osc_st_and_two_byte_and_consecutive() {
            // OSC 以 ESC\ (ST) 结束
            assert_eq!(strip_ansi("\u{1b}]8;;https://x\u{1b}\\正文"), "正文");
            // 两字节序列 ESC M（反向索引）
            assert_eq!(strip_ansi("a\u{1b}Mb"), "ab");
            // 连续 CSI 序列（连续 2 个）
            assert_eq!(
                strip_ansi("\u{1b}[1m\u{1b}[36mhttps://ok\u{1b}[0m\u{1b}[m"),
                "https://ok"
            );
            // 不误伤普通方括号文本（日志级别前缀这类真实形态）
            assert_eq!(strip_ansi("[INFO] https://ok"), "[INFO] https://ok");
            // 裸 ESC 结尾：吞掉，不 panic、不吐出乱码
            assert_eq!(strip_ansi("tail\u{1b}"), "tail");
        }

        #[test]
        fn test_qa_parse_login_output_after_ansi_in_error_stream() {
            // 带 ANSI 的错误信息摘录：describe_stream 必须先把序列剥净
            let raw = "\u{1b}[31mError: device flow failed\u{1b}[0m\n";
            assert_eq!(describe_stream(raw), "Error: device flow failed");
        }

        // —— 3. cli_login_error_message：三态 + 双空流 + 截断边界 ——

        #[test]
        fn test_qa_cli_login_error_message_three_states_and_both_streams_empty() {
            // 三态齐全：Running / Exited(code) / Exited(signal)，且双空流都标 <空>
            for (state, expect) in [
                (ProcessState::Running, "进程仍在运行"),
                (
                    ProcessState::Exited {
                        code: Some(127),
                        signal: None,
                    },
                    "exit code=127",
                ),
                (
                    ProcessState::Exited {
                        code: None,
                        signal: Some(15),
                    },
                    "signal=15",
                ),
            ] {
                let message = cli_login_error_message("原因", "/p/cnb", "1.18.3", state, "", "");
                assert!(message.contains(expect), "缺少状态描述 {expect}: {message}");
                assert!(message.contains("CLI: /p/cnb"), "缺少 CLI 路径: {message}");
                assert!(message.contains("版本: 1.18.3"), "缺少版本号: {message}");
                // 双空流：stdout 与 stderr 各自独立标注 <空>（不是只标一个）
                assert_eq!(
                    message.matches("stdout: <空>").count(),
                    1,
                    "stdout 空流应标注 <空>: {message}"
                );
                assert_eq!(
                    message.matches("stderr: <空>").count(),
                    1,
                    "stderr 空流应标注 <空>: {message}"
                );
            }
        }

        #[test]
        fn test_qa_cli_login_error_message_truncation_multibyte_boundary() {
            // 350 个汉字（每个 3 字节）：按字符截断到 300，不得切出半个字符
            let long: String = "请".repeat(350);
            let message = cli_login_error_message(
                "原因",
                "/p",
                "v",
                ProcessState::Running,
                &long,
                &long,
            );
            assert!(!message.contains('\u{fffd}'), "多字节截断不得产生替换字符");
            assert!(message.contains('…'), "超长输出应带省略号");
            // 摘录正文恰为 300 字符（+ 省略号）
            let excerpt = message
                .split("stdout: ")
                .nth(1)
                .and_then(|rest| rest.split("，stderr: ").next())
                .expect("应能取到 stdout 摘录");
            assert_eq!(
                excerpt.chars().count(),
                301,
                "应为 300 字符 + 省略号，实际 {} 字符",
                excerpt.chars().count()
            );
            assert!(
                excerpt.chars().take(300).all(|c| c == '请'),
                "截断后每个字符都应是完整汉字"
            );
        }

        // —— 4. parse_login_output：纯 CRLF ——

        #[test]
        fn test_qa_parse_login_output_crlf_only() {
            let output = "标题行\r\nhttps://cnb.cool/oauth2/device/verify?user_code=CRLF99\r\n尾行\r\n";
            let (url, code) = parse_login_output(output).expect("CRLF 输出应能解析");
            assert_eq!(url, "https://cnb.cool/oauth2/device/verify?user_code=CRLF99");
            assert_eq!(code, "CRLF99");
            assert!(!url.contains('\r'), "解析结果不得带行尾 \\r");
        }

        // —— 5. 管道背压：超过捕获上限后仍必须消费管道 ——

        /// 造一个临时假 cnb 脚本（只 printf/sleep，绝不碰任何文件）
        #[cfg(unix)]
        fn write_fake_cli(tag: &str, script: &str) -> std::path::PathBuf {
            use std::os::unix::fs::OpenOptionsExt;
            let dir = std::env::temp_dir().join(format!(
                "wocnb-qa-{tag}-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("创建临时目录");
            let path = dir.join("cnb");
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o755)
                .open(&path)
                .expect("写入假 cnb 脚本");
            file.write_all(script.as_bytes()).expect("写入脚本内容");
            drop(file);
            path
        }

        #[cfg(unix)]
        #[test]
        fn test_qa_capture_beyond_limit_still_drains_pipe() {
            // 关键点：捕获缓冲到 64KiB 上限后仍必须继续 read（丢弃内容），
            // 否则子进程写 200KB 时会阻塞在 write → 永远不退出（死锁）。
            // 断言"子进程能正常退出"即证明管道被持续消费。
            let script = "#!/bin/sh\n\
                 printf '  https://cnb.cool/oauth2/device/verify?user_code=BULK01\\n'\n\
                 i=0\n\
                 while [ $i -lt 4000 ]; do\n\
                 printf '0123456789012345678901234567890123456789012345678'\n\
                 i=$((i+1))\n\
                 done\n\
                 printf '\\nDONE\\n'\n";
            let path = write_fake_cli("bulk", script);

            let mut child = Command::new(&path)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .expect("spawn 假 cnb 脚本");
            let stdout_buf = Arc::new(Mutex::new(String::new()));
            if let Some(stdout) = child.stdout.take() {
                spawn_output_reader(stdout, stdout_buf.clone());
            }
            let stderr_buf = Arc::new(Mutex::new(String::new()));
            if let Some(stderr) = child.stderr.take() {
                spawn_output_reader(stderr, stderr_buf.clone());
            }

            // 最多等 8s 让子进程自然退出（若管道未被消费，它会永久阻塞在 write）
            let deadline = std::time::Instant::now() + Duration::from_secs(8);
            let mut exited = None;
            while std::time::Instant::now() < deadline {
                exited = child.try_wait().expect("try_wait 不应失败");
                if exited.is_some() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            let _ = child.kill();
            let _ = child.wait();
            let _ = std::fs::remove_dir_all(path.parent().unwrap());

            assert!(
                exited.is_some(),
                "子进程写出 ~200KB 后仍未退出：捕获上限后的管道未被消费（写阻塞/死锁）"
            );
            assert!(exited.unwrap().success(), "假脚本应正常退出");

            // 让读线程把 EOF 前的最后一段落盘，再取快照
            std::thread::sleep(Duration::from_millis(100));
            let captured = snapshot(&stdout_buf);
            assert!(
                parse_login_output(&captured).is_some(),
                "链接在首批输出中，必须仍可解析"
            );
            assert!(
                captured.len() <= MAX_CAPTURE_BYTES + 8192,
                "捕获缓冲必须受上限约束，实际 {} 字节",
                captured.len()
            );
            assert!(
                !captured.contains("DONE"),
                "上限之后的尾部内容应被丢弃而不是继续累积"
            );
        }

        // —— 6. 无换行结尾的链接（证明 fill_buf 而非 read_until） ——

        #[cfg(unix)]
        #[test]
        fn test_qa_link_without_trailing_newline_found_while_child_alive() {
            // `cnb login` 若把链接写在无换行的一行里（进度条式输出），
            // read_until 会阻塞到换行/EOF；fill_buf 必须能立刻交付。
            let script = "#!/bin/sh\n\
                 printf '  https://cnb.cool/oauth2/device/verify?user_code=NONL01'\n\
                 sleep 5\n";
            let path = write_fake_cli("nonl", script);

            let mut child = Command::new(&path)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .expect("spawn 假 cnb 脚本");
            let stdout_buf = Arc::new(Mutex::new(String::new()));
            if let Some(stdout) = child.stdout.take() {
                spawn_output_reader(stdout, stdout_buf.clone());
            }
            let stderr_buf = Arc::new(Mutex::new(String::new()));

            let started = std::time::Instant::now();
            let child = std::cell::RefCell::new(child);
            let outcome = wait_for_login_link(&stdout_buf, &stderr_buf, &|| {
                child.borrow_mut().try_wait().ok().flatten()
            });
            let elapsed = started.elapsed();

            let (url, code) = outcome.parsed.expect("无换行结尾的链接也必须解析出来");
            assert_eq!(code, "NONL01");
            assert_eq!(url, "https://cnb.cool/oauth2/device/verify?user_code=NONL01");
            assert!(outcome.exit.is_none(), "解析时子进程应仍在运行（sleep 5）");
            assert!(
                elapsed < Duration::from_secs(2),
                "不得等子进程退出才交付，实际耗时 {elapsed:?}"
            );

            let mut child = child.into_inner();
            let _ = child.kill();
            let _ = child.wait();
            let _ = std::fs::remove_dir_all(path.parent().unwrap());
        }

        // —— 7. 已知缺陷 Q-1：pump_reader 遇 EINTR 直接 break ——

        /// 第一次 read 返回 EINTR、之后正常返回数据的桩。
        struct InterruptOnceReader {
            interrupted: AtomicBool,
            payload: Vec<u8>,
            index: usize,
        }

        impl Read for InterruptOnceReader {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                if !self.interrupted.swap(true, Ordering::SeqCst) {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::Interrupted,
                        "EINTR",
                    ));
                }
                if self.index >= self.payload.len() {
                    return Ok(0);
                }
                let n = self.payload.len().min(buf.len());
                buf[..n].copy_from_slice(&self.payload[..n]);
                self.index += n;
                Ok(n)
            }
        }

        /// 回归锁（Q-1 已修复，2026-10 第二轮）：`pump_reader` 的
        /// `Err(e) if e.kind() == ErrorKind::Interrupted => continue`。
        /// 修复前的行为是把 EINTR 当成"管道读到尽头"，一次信号打断就永久停止
        /// 捕获该流，之后所有输出（包括验证链接）全部丢失，错误信息退化为
        /// `stdout: <空>`，与本次 bug 的症状无法区分，排查方向会被带偏。
        #[test]
        fn test_qa_pump_reader_retries_on_interrupted() {
            let mut reader = InterruptOnceReader {
                interrupted: AtomicBool::new(false),
                payload: "  https://cnb.cool/oauth2/device/verify?user_code=EINTR1\n".as_bytes().to_vec(),
                index: 0,
            };
            let mut collected = String::new();
            pump_reader(&mut reader, &mut |text| collected.push_str(text));
            assert!(
                collected.contains("EINTR1"),
                "EINTR 应被重试而不是终止读取，实际捕获: {collected:?}"
            );
        }
    }

    // =========================================================================
    // Round 3 回归锁：旧版 cnb CLI 不支持 --host 的自适应降级
    //
    // 覆盖面：
    // H. is_unknown_option_failure —— 判定函数的 5 类输入（用户实测报错原文、
    //    大小写变体、网络错误、空 stderr、成功输出）；
    // I. login_can_retry_without_host —— 三条件合取的边界（存活中/零退出码/
    //    已解析到链接时都绝不降级）；
    // J. 假 cnb 脚本端到端 —— 同一脚本模拟两种行为：带 --host 报错秒退、
    //    不带 --host 正常打印验证链接，走真实的 spawn_login_session →
    //    wait_for_login_link → 降级判定 → 二次 spawn → 二次解析全链路。
    //
    // 红线：绝不 spawn 真实 `cnb login`（会覆盖用户 ~/.cnb/token）；
    // 假脚本只 echo/printf/sleep/exit，不碰任何文件，测试结束即删除。
    // =========================================================================
    mod host_fallback {
        use super::*;

        // —— H. is_unknown_option_failure ——

        // 验证点：用户实测报错原文必须命中（这是本次 bug 的第一现场）
        #[test]
        fn test_is_unknown_option_failure_cnb_1_10_16_error() {
            let stderr =
                "error: unknown option '--host' (Did you mean --short?)";
            assert!(
                is_unknown_option_failure(stderr),
                "实测报错原文必须判定为参数不识别"
            );
        }

        // 验证点：大小写变体也要命中（不区分大小写是放宽匹配的一部分，
        // 防止 CLI 版本更替后报错改大写导致降级失效）
        #[test]
        fn test_is_unknown_option_failure_case_insensitive() {
            assert!(is_unknown_option_failure("UNKNOWN OPTION '--host'"));
            assert!(is_unknown_option_failure("Error: Unknown Option '--host'"));
        }

        // 验证点：网络类错误绝不能命中 —— 这类错误重试也无济于事，
        // 误命中会让用户在真失败上白等一次重试
        #[test]
        fn test_is_unknown_option_failure_rejects_network_errors() {
            assert!(!is_unknown_option_failure(
                "getaddrinfo ENOTFOUND cnb.cool"
            ));
            assert!(!is_unknown_option_failure(
                "Error: connect ETIMEDOUT 1.2.3.4:443"
            ));
        }

        // 验证点：空 stderr 不命中（降级必须有 stderr 证据才启动）
        #[test]
        fn test_is_unknown_option_failure_empty_stderr() {
            assert!(!is_unknown_option_failure(""));
        }

        // 验证点：登录成功输出（含 https 链接）不命中 —— 成功输出里
        // 出现任何"did you mean"式巧合文本也不能触发降级
        #[test]
        fn test_is_unknown_option_failure_rejects_success_output() {
            let success =
                "\n请打开以下链接完成授权：\n  https://cnb.cool/oauth2/device/verify?user_code=OK01\n";
            assert!(!is_unknown_option_failure(success));
        }

        // —— I. login_can_retry_without_host：三条件合取 ——

        /// 构造 LoginWaitOutcome 的测试辅助（parsed/exit 按需填充）
        fn make_outcome(
            parsed: Option<(String, String)>,
            stderr: &str,
            exit_code: Option<i32>,
        ) -> LoginWaitOutcome {
            LoginWaitOutcome {
                parsed,
                stdout: String::new(),
                stderr: stderr.to_string(),
                // 用 /bin/sh 构造指定退出码的 ExitStatus（纯数据，无副作用）
                exit: exit_code.map(|code| {
                    std::process::Command::new("/bin/sh")
                        .args(["-c", &format!("exit {code}")])
                        .status()
                        .expect("构造 ExitStatus")
                }),
            }
        }

        // 验证点：三条件全满足才降级（用户 1.10.16 的实际情形）
        #[test]
        fn test_retry_gate_all_conditions_met() {
            let outcome = make_outcome(
                None,
                "error: unknown option '--host' (Did you mean --short?)",
                Some(1),
            );
            assert!(login_can_retry_without_host(&outcome));
        }

        // 验证点：子进程仍在运行（exit=None）绝不降级 —— 不能对存活中的
        // 正常登录流贸然 kill 重来
        #[test]
        fn test_retry_gate_rejects_running_child() {
            let outcome = make_outcome(
                None,
                "error: unknown option '--host'",
                None,
            );
            assert!(!login_can_retry_without_host(&outcome));
        }

        // 验证点：零退出码却无链接（输出格式类问题）不降级 —— 重试无效
        #[test]
        fn test_retry_gate_rejects_zero_exit() {
            let outcome = make_outcome(None, "unknown option-ish noise", Some(0));
            assert!(!login_can_retry_without_host(&outcome));
        }

        // 验证点：已解析到链接绝不降级 —— 会丢弃一个可能已被用户授权的设备码
        #[test]
        fn test_retry_gate_rejects_parsed_link() {
            let outcome = make_outcome(
                Some((
                    "https://cnb.cool/oauth2/device/verify?user_code=OK02".into(),
                    "OK02".into(),
                )),
                "error: unknown option '--host'",
                Some(1),
            );
            assert!(!login_can_retry_without_host(&outcome));
        }

        // —— J. 假 cnb 脚本端到端降级验证 ——

        /// 写一个模拟 cnb 1.10.16 行为的假脚本（临时目录，测试完删除）：
        /// - 参数里出现 --host → 往 stderr 打用户实测报错原文并 exit 1；
        /// - 不带 --host → 打印标题行 + 验证链接，然后挂住等"授权"。
        #[cfg(unix)]
        fn write_two_mode_fake_cli(tag: &str) -> std::path::PathBuf {
            use std::os::unix::fs::OpenOptionsExt;
            let dir = std::env::temp_dir().join(format!(
                "wocnb-hostfallback-{tag}-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("创建临时目录");
            let path = dir.join("cnb");
            let script = "#!/bin/sh\n\
                 for a in \"$@\"; do\n\
                 if [ \"$a\" = \"--host\" ]; then\n\
                 echo \"error: unknown option '--host' (Did you mean --short?)\" >&2\n\
                 exit 1\n\
                 fi\n\
                 done\n\
                 printf '\\n请打开以下链接完成授权：\\n'\n\
                 printf '  https://cnb.cool/oauth2/device/verify?user_code=TESTCODE\\n'\n\
                 sleep 5\n";
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o755)
                .open(&path)
                .expect("写入假 cnb 脚本");
            file.write_all(script.as_bytes()).expect("写入脚本内容");
            drop(file);
            path
        }

        /// 端到端：首次带 --host spawn → 秒退且 stderr 报 unknown option →
        /// 判定可降级 → 清理会话 → 不带 --host 重试 → 解析到验证链接。
        /// 走的全是生产代码路径（spawn_login_session / session_exit_status /
        /// cleanup_login_session），只是不经过需要 AppHandle 的 Tauri 命令层。
        #[cfg(unix)]
        #[test]
        fn test_login_degrades_to_no_host_on_unknown_option() {
            let cli_path = write_two_mode_fake_cli("e2e");
            let cli_path_text = cli_path.to_string_lossy().into_owned();

            // 第一次：带 --host（旧版假 CLI 会报错秒退）
            let first = spawn_login_session(
                &cli_path,
                true,
                None,
                &cli_path_text,
                "0.0.0-fake",
            )
            .expect("首次 spawn 应成功");
            let (first_handle, first_outcome) = wait_login_outcome_blocking(first);

            // --nocapture 时打印实测数据，供人工核对降级证据链
            eprintln!(
                "[降级 e2e] 首次（带 --host）: exit={:?}, stderr={:?}",
                first_outcome.exit.map(|s| s.code()),
                first_outcome.stderr
            );

            assert!(
                first_outcome.parsed.is_none(),
                "带 --host 的旧版 CLI 不可能解析到链接"
            );
            assert_eq!(
                first_outcome.exit.and_then(|s| s.code()),
                Some(1),
                "假 CLI 应以 exit 1 秒退（模拟 1.10.16 的参数拒绝）"
            );
            assert!(
                login_can_retry_without_host(&first_outcome),
                "首次失败应被判定为可降级重试"
            );

            // 清理首次会话（与 cnb_cli_login 降级分支同一函数）
            cleanup_login_session(first_handle);
            assert!(
                lock_sessions().get(&first_handle).is_none(),
                "首次会话应已被清理移除"
            );

            // 第二次：不带 --host（假 CLI 走正常分支打印链接后挂住）
            let retry = spawn_login_session(
                &cli_path,
                false,
                None,
                &cli_path_text,
                "0.0.0-fake",
            )
            .expect("降级 spawn 应成功");
            let (retry_handle, retry_outcome) = wait_login_outcome_blocking(retry);

            eprintln!(
                "[降级 e2e] 重试（不带 --host）: parsed={:?}, 子进程存活={}",
                retry_outcome.parsed,
                retry_outcome.exit.is_none()
            );

            // 先做"成功结果绝不再触发降级"断言（借用），再取走 parsed
            assert!(
                !login_can_retry_without_host(&retry_outcome),
                "成功结果绝不能再触发降级"
            );
            let (url, code) = retry_outcome
                .parsed
                .expect("降级重试应解析到验证链接");
            assert_eq!(code, "TESTCODE");
            assert_eq!(
                url,
                "https://cnb.cool/oauth2/device/verify?user_code=TESTCODE"
            );
            assert!(
                retry_outcome.exit.is_none(),
                "解析成功时假 CLI 应仍挂住等授权（sleep 5）"
            );

            // 收尾：kill 会话 + 删除临时假脚本
            cleanup_login_session(retry_handle);
            let _ = std::fs::remove_dir_all(cli_path.parent().unwrap());
        }

        /// 反向端到端：网络类失败（stderr 不含 unknown option）**绝不**降级，
        /// 防止在真失败上拖一次无意义的重试。
        #[cfg(unix)]
        #[test]
        fn test_login_does_not_degrade_on_other_failures() {
            use std::os::unix::fs::OpenOptionsExt;
            let dir = std::env::temp_dir().join(format!(
                "wocnb-hostfallback-net-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("创建临时目录");
            let cli_path = dir.join("cnb");
            // 模拟网络故障：往 stderr 打 DNS 错误后 exit 1（无 --host 语义）
            let script = "#!/bin/sh\n\
                 echo 'getaddrinfo ENOTFOUND cnb.cool' >&2\n\
                 exit 1\n";
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o755)
                .open(&cli_path)
                .expect("写入网络故障假脚本");
            file.write_all(script.as_bytes()).expect("写入脚本内容");
            drop(file);

            let first = spawn_login_session(
                &cli_path,
                true,
                None,
                &cli_path.to_string_lossy(),
                "0.0.0-fake",
            )
            .expect("spawn 应成功");
            let (handle, outcome) = wait_login_outcome_blocking(first);

            assert!(outcome.parsed.is_none());
            assert!(
                !login_can_retry_without_host(&outcome),
                "网络类失败绝不能触发降级重试"
            );

            cleanup_login_session(handle);
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
}
