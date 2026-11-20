# 项目长期记忆（wocnb）

## 应用定位（核心约定）

- 本应用是 **CNB.cool 的客户端**（Tauri 2 桌面应用，WOCNB.app），一切需求按 CNB 官方文档与 Open API 实现，不凭空猜接口。
- 文档：https://docs.cnb.cool/zh/ ；Open API：https://docs.cnb.cool/zh/develops/openapi.html ；Swagger：https://api.cnb.cool/swagger.json
- 认证：`Authorization: Bearer ${token}`；API 请求统一走自建 `cnb_http_request` 命令（native-tls + no_proxy 直连）——CNB 网关风控拦截 rustls 指纹（403），勿用 tauri-plugin-http 或原生 fetch。

## API 能力边界（踩过的坑）

- 外部贡献者只能按仓库查（组织路径 400）；资源路径必须逐段编码（encodeSlugPath）；创建仓库入参 visibility 小写 `public|private|secret`，详情返回首字母大写，禁止透传。
- 空 body 写端点必须用 `cnbFetchVoid`（cnbFetch 对空 body 会 JSON 解析炸）。
- 权限判定单点 `canManageRole()`（useCnbAuth.ts）；403 一律降级提示保留登录态，仅 401 才 handleUnauthorized。
- Open API 无 star 写接口；`GET /{group}` 返回 OrganizationAccess 含 access_role（勿误判字段缺失致子组织不可治理——曾出 P1）。
- 编码两口径：repo slug 逐段编码；制品名/tag/compare 整段 encodeURIComponent。

## 技术栈与约定

- Vue 3 + Vite + Nuxt UI v4，pnpm；Tauri 2（identifier com.wocnb.dashboard）；bundle targets 仅 "app"。
- 布局文件必须用 `<RouterView />` 不能 `<slot />`；外链经 opener 插件系统浏览器打开（main.ts 捕获拦截）。
- 新改代码写详细中文注释（覆盖率 ≥30%）；改动后跑 cargo test + tauri build 验证。
- vue-i18n message 里字面量 `@` 必须写 `{'@'}`（否则渲染时炸 Invalid linked format，typecheck 不报）。
- 切组织清 slug 不能复用 buildQuery（会把旧 slug 写回变 no-op）。
- 路由下钻键 `?tab=` 8 值 + 下钻键，`switchTab` 必须全清（仅 ptype 保留）；⌘K 只放静态链接（远程搜索破坏弹层生命周期）。

## CI 节点标签（关键，勿写错）

- Mac：`mac`+`arm64`；Windows：`win`+`amd64`（注意不对称：Windows 是 `win` 不是 `windows`）。runner.tags 必须是节点标签子集（与关系），写错派单失败且无 runner 日志。
- 无 mac x64 / win arm64 节点 → macos 只出 arm64 dmg、windows 只出 x64 nsis。
- **release-windows 勿加 allowFailure**（曾导致失败被吞成假 success；已移除）；验收发版必须逐 pipeline 查。
- 重发只能升版本号：CNB tag 保护 hook 拒删已推 tag。

## Windows runner / NSIS 精要（细节看每日日志归档）

- Windows runner 是容器化 SYSTEM 账户：PATH 无 npm/cargo/node，install/build 要自己探测补 PATH；PowerShell 探测命令一律包 `cmd /c "pnpm -v >nul 2>&1"` 看退出码（缺失=9009，CommandNotFoundException 是终止性错误）。
- .ps1 必须带 UTF-8 BOM（否则中文注释按 GBK 解码炸语法）。
- NSIS 只能 amd64-unicode（msys2 包无 x86 stub/插件）；rc 版不能用 MSI（WiX 拒非纯数字预发布）；三级降级：makensis→nsis / 正式版→msi / 都不行→--no-bundle。
- `TAURI_BUNDLER_TOOLS_GITHUB_MIRROR=https://ghfast.top/` 解决 bundler 下载工具链超时。
- 清单平台键必须 `windows-x86_64`（OS-ARCH 口径）；signature = .sig 文件原文；latest.json 必须双平台齐全（单平台会让另一端 updater 静默失效）。
- pipefail 下禁 `| head -N` / `tar|grep -q`（SIGPIPE 141 假死/误判），用 `sed -n '1,Np'`。
- Prepare code 0 不代表 clone 成功（节点 DNS 抖动 workspace 空，先怀疑节点网络）。

## 构建监控通知机制（固化，勿再推翻）

- macOS 走 notify-rust 旧后端，靠 `NotificationHandle::drop` 补发；点击上报前提：Rust 注册 ActionType `cnbBuildOpen` + 前端恒带 `actionTypeId`（无按钮通知 ≤2s 清 pending，点击静默丢弃）。
- 点击链路：Rust on_action → emit `cnb://build-notification-action` → useBuildNotificationAction 解析 → 直达构建详情/通知面板（JS 包无 onAction，只能走 Rust）。
- sn 必须 `String()` 收敛；encodeRepoPathForRoute 唯一实现在 utils/index.ts。

## 托盘快捷面板（2026-11-19 完成）

- 托盘左键单击 → 独立 tray-panel 窗口（360x440 无边框，tauri.conf.json 配置 + capabilities windows 加 "tray-panel"），**不复用主窗口**。
- 双 WebView 共享 SPA：main.ts 按 `getCurrentWindow().label === 'tray-panel'` 分支——面板窗口跳过 restoreSession/initBuildWatcher/initNoticeDbSync/通知 handler/401 handler/syncTrayLocale（避免双份轮询与续期竞态）；启动前 router.replace('/tray-panel')；路由守卫豁免 /tray-panel 登录重定向。
- 数据：useRecentRepos 写 localStorage `wocnb.recentRepos`（仓库详情页 loadRepo 成功后 recordRecentRepo；去重置顶、上限 20）；面板每次弹出重读盘刷新（Rust emit `cnb://tray-panel-shown` + focus 双保险）。
- 点击列表项 → `tray_panel_open_target` 命令：隐藏面板 + show_main_window + emit_to("main", `cnb://panel-navigate`, path) → 主窗口 router.push 跳对应仓库页。
- Rust 侧要点：rect 的 Position/Size 枚举需归一；防抖 300ms；失焦隐藏有 250ms 判定窗（防「失焦先隐藏→点击复弹」死循环）。

## 组织域速查

- `cnbGroups`（useCnbAuth.ts）是组织列表唯一共享状态，增删组织后须重新 fetch。
- 不做项：Logo 上传、删除组织、贡献者趋势（仓库级端点传组织路径 400）。

## 发版约定（2026-11-20 用户明确要求）

- **每次发版都必须创建 Release 并作为 Latest 可见**（含 rc 版）。GitHub 侧：tag 要单独一次 push 且 ≤3 个（超 3 个 workflow 静默不触发）；tauri-action 对含 `-` 的 tag 建成 Pre-release → release.yml 已加 publish-release job（gh release edit --prerelease=false --latest）自动转正式。

## 测试基线

- cargo test 109 + vitest 700+；本地 typecheck 口径：`npx vue-tsc -p ./tsconfig.app.json`（CI 用，Array.at 超 ES2020 lib 会报）。
- pre-commit 已挂 typecheck + lint（husky）；commit 后用 `git show --stat` 核对文件清单（df52c29 漏提交 lib.rs 事故教训）。
