# 项目长期记忆（wocnb）

## 应用定位（核心约定，2026-10-23 用户明确要求）

- 本应用是 **CNB.cool 的客户端**（Tauri 2 桌面应用，WOCNB.app）。
- **后续所有需求都必须按照 CNB 官方文档与 Open API 实现**，不要凭空猜测接口。
- CNB 文档入口：https://docs.cnb.cool/zh/
- Open API 文档：https://docs.cnb.cool/zh/develops/openapi.html

## CNB Open API 要点（来自官方文档）

- API 服务地址：`https://api.cnb.cool`
- Swagger JSON（可生成类型定义/客户端）：`https://api.cnb.cool/swagger.json`
- 认证：请求头 `Authorization: Bearer ${token}`，token 为 CNB 访问令牌（https://docs.cnb.cool/zh/guide/access-token.html）
- 请求头 `Accept` 按 API 文档的 Response content type 填写（如 `application/json`）
- 能力覆盖：代码托管、组织/成员、流水线、制品库、Issue 等
- 仓库动态（事件）接口另见：https://docs.cnb.cool/zh/develops/openapi-event.html
- CNB 还提供 CLI 与 Skills（https://docs.cnb.cool/zh/develops/cnb-cli.html）

### 已知 API 能力边界（踩过的坑，勿再犯）

- **外部贡献者只能按仓库查**：`GET /{slug}/-/outside-collaborators` 是仓库级端点（`repo-manage:r`），传组织路径返回 `400 This feature is not supported for organizations.`。任何"组织维度"的外部贡献者入口都要先落到一个具体仓库（本项目走 `GET /{group}/-/repos` + 仓库选择器）。
- **资源路径必须逐段编码**：`encodeURIComponent('a/b')` → `a%2Fb` 会把层级压平导致路由不到。统一用 `useCnbMembers` 的 `encodeSlugPath`（split('/') → 每段 encode → join('/')）。
- **两套 visibility 枚举不可透传**：创建入参小写 `public|private|secret`，详情返回首字母大写（`visibility_level`）。

## 技术栈与既有约定

- Vue 3 + Vite + Nuxt UI v4（模板源自 nuxt-ui-templates/dashboard-vue），包管理器 pnpm
- Tauri 2：src-tauri/，identifier com.wocnb.dashboard，productName WOCNB，bundle targets 仅 "app"（本机 DMG 打包脚本与 macOS 新版 hdiutil 不兼容）
- 托盘：W 图标（白底黑 W），左右键均原生弹菜单（打开应用/退出应用）；关窗仅隐藏不退出
- 外链经 tauri-plugin-opener 在系统浏览器打开（main.ts 捕获阶段全局拦截）
- 用户偏好：新改代码要写详细中文注释（覆盖率 ≥30%）；改动后跑 cargo test + tauri build 验证
- 布局文件（layouts/*.vue）必须用 <RouterView /> 渲染页面，不能用 <slot />（vite-plugin-vue-layouts 机制），否则页面白屏
- CNB API 无 CORS 头，Webview 内 fetch 必须走 tauri-plugin-http（已配 capabilities url 白名单），前端统一用 useCnbAuth 的 httpFetch
- CNB 网关风控拦截 rustls TLS 指纹（403 Forbidden）；CNB API 请求必须走自建 cnb_http_request 命令（native-tls + no_proxy 直连），不要用 tauri-plugin-http 或原生 fetch

## CI 自托管构建节点标签（2026-11-10 用户明确要求记住）

- **Mac 构建节点标签：`mac`、`arm64`**（release-macos 的 runner.tags 必须与此严格一致）
- **Windows 构建节点标签：`win`、`amd64`**（release-windows 的 runner.tags 必须与此严格一致）
- 注意命名不对称：Mac 是 arm64、Windows 是 amd64，且 Windows 是 `win` 不是 `windows`——`.cnb.yml` 里写错标签会导致流水线 Prepare 阶段派单失败（`No runner for namespace: group tags: ...`），且无 runner 日志（2026-11-10 rc.3~rc.7 五次事故的根因）
- 节点标签是「与」关系：runner.tags 必须是节点标签的子集才能被派单
- 暂无 mac x64 与 win arm64 节点 → release-macos 只出 arm64 dmg、release-windows 只出 x64 nsis（2026-11-10 架构裁剪）

## Windows / Mac 自托管 runner 环境事实（2026-11-11 实测）

- **Windows runner 是容器化 SYSTEM 账户**：家目录 `C:\Windows\system32\config\systemprofile`，PATH 里没有 `%APPDATA%\npm` 与 `C:\Users\*\ .cargo\bin` → install/build 阶段必须自己探测补 PATH（.cnb.yml 已内置）
- **32 位程序在该容器里跑不起来**：NSIS 的 makensis.exe 全部依赖（含 SysWOW64 的 MSVCP60.dll）都在，仍报 0xC0000135 → 打包只能三级降级：makensis 可用→nsis；正式版（版本号无预发布后缀）→msi(WiX)；预发布版+makensis 不可用→`--no-bundle` 只出裸 exe
- **WiX(MSI) 拒绝非纯数字预发布标识**：`0.1.0-rc.N` 会被拒（`optional pre-release identifier ... must be numeric-only`），所以 rc 阶段无法用 MSI
- **.ps1 脚本必须带 UTF-8 BOM**：Windows PowerShell 5.1 无 BOM 时按 GBK 解码中文注释，会吃掉后续引号导致「意外的标记」级联语法错误（rc.20 事故）
- tauri bundler 从 GitHub 下载 NSIS/WiX 工具链会超时：设 `TAURI_BUNDLER_TOOLS_GITHUB_MIRROR=https://ghfast.top/` 可走镜像（URL 拼接格式为 `<mirror>/https://github.com/...`）
- 上传附件偶发 TLS 断链（curl 56）：release-upload.sh 已加每文件 3 次重试，每次重新申请上传地址

## CNB API 覆盖增量落地约定（2026-11-11 完成后固化）

- **API 覆盖率口径**：268 个 operation 中本轮落地 81 个（13%→30%）；48 端点范围（B3 附件上传 2 个已裁决延后，创建仓库补入）。PRD：`docs/prd/cnb-api-coverage-prd.md`（v1.3），设计：`docs/design/cnb-api-coverage-design.md`（1555 行，D1~D4 裁决 + R1~R14 风险表 + 附录 A 端点×scope 对照）
- **二进制出口唯一**：archive/附件下载只能走 `src-tauri/src/lib.rs` 的 `cnb_download_archive` 命令（前端封装 `src/utils/tauriDownload.ts`）；安全约束——前缀白名单常量 `https://api.cnb.cool/`、只发 GET、`redirect::Policy::none()`、1 GiB 上限、300s 超时、`sanitize_archive_name` 白名单扩展名（.zip/.tar.gz/.tgz）、独立 `token: Option<String>` 参数只附加 Bearer、token 绝不入日志
- **依赖勿删**：`futures-util`（reqwest 不重导出 StreamExt）+ `tokio` fs/io-util，`Cargo.toml` 注释与设计文档 §2.2 三处写明原因
- **两套 visibility 枚举禁止透传**：创建入参小写 `public|private|secret`（dto.CreateRepoReq），详情返回首字母大写 `Private|Public|Secret`（dto.Repos4User.visibility_level）；`PATCH /{repo}` 无 visibility 字段（只有 description/license/site/topics）
- **权限判定单点**：`canManageRole()` 在 `useCnbAuth.ts`，禁止内联 Master/Owner 判定（曾有 4 份副本已收敛）
- **403 红线**：403 一律降级 StateAlert/toast 并保留登录态，只有 401 才 `handleUnauthorized`；写入口按 `canManage` 事前隐藏而非事后报错
- **commit-statuses 是 GitLab 风格六态**（success/failed/running/pending/canceled/skipped），与构建四态不同族，映射独立维护，未知值中性色；CI 徽标 IntersectionObserver 懒加载 + 并发上限 4
- **编码两口径**：repo slug 逐段编码（encodeSlug）；制品名/tag/compare 的 `base...head` 整段 `encodeURIComponent`；下载 URL 的格式后缀（.zip）在编码段外
- **路由下钻键**：`?tab=` 8 值 + 下钻键 number/sn/sha/path/release/pname/ptag/compare/page，`switchTab` 必须全清（R3，曾是不修必出事的既有缺陷），仅 ptype 保留（用户偏好）
- **⌘K 命令面板**只放静态链接/动作，远程搜索禁入（R14，破坏 useOverlayUnlockGuard 弹层生命周期）
- **Open API 无 star 写接口**（只有 3 个读接口），UI 永远不做"点 Star"按钮
- **待用户真机验证**：`pnpm tauri dev` 下验证 zip 下载落盘 ~/Downloads、重名生成 ` (2)`、403 中文 toast；扩展名判定优先级 Content-Disposition filename > Content-Type > 请求格式（设计文档 §10 Q5）

## 系统通知（构建监控）机制事实（2026-11-12 固化，勿再推翻）

- macOS 实际走 notify-rust 的 **NSUserNotificationCenter 旧后端**（tauri-plugin-notification 未暴露 `preview-macos-un`）；通知能弹出靠 `NotificationHandle::drop` 异步补发（`show()` 在旧后端只造 handle 不发送）。
- **点击上报前提（反直觉）**：必须 Rust 注册 ActionType `cnbBuildOpen`（lib.rs）+ 前端恒带 `actionTypeId`（useCnbBuildWatch.ts）—— 无按钮通知发送后 ≤2s 清 pending map，点击被系统丢弃（静默 no-op，测试全绿也测不出）。两端常量已双向字面量锁定（TS + Rust 用例）。
- 点击链路：Rust `on_action` → emit `cnb://build-notification-action`（extra 带 repoPath/sn）→ 前端 `useBuildNotificationAction.ts` 纯函数解析意图 → 直达构建详情 / 打开通知面板。JS 包 2.7.0 无 onAction 导出，只能走 Rust。
- sn 进 extra 必须 `String()` 收敛（fetchBuildLogs/triggerBuild/组装层三道）；`isNotificationsSlideoverOpen` 是模块级单例；`encodeRepoPathForRoute` 唯一实现在 `utils/index.ts`。
- 设置页有「发送测试通知」按钮（浏览器 dev 禁用）。回退开关：注释掉 lib.rs 里 on_action 注册块即整体回退旧路径。

## 组织域事实与陷阱（2026-11-11 组织能力扩展后固化）

- **`GET /{group}` 返回 `dto.OrganizationAccess`**，含 `access_role` + `description/site/email/domain/remark/wechat_mp/readme_repo_path` 7 个可编辑字段。**任何"该接口不返回某字段"的判断必须先看 swagger 的 200 schema 指向哪个 definition** —— 曾因误信「不返回 access_role」把子组织角色置空串，导致子组织在桌面端完全不可治理（QA 抓到的 P1）。子组织只能靠 `?slug=` 下钻到达，这条错误影响面是"整棵子树"。
- **空 body 写端点必须用 `cnbFetchVoid`**（`useCnbAuth.ts` 导出，与 `cnbFetch` 共用同一 `cnbRequest` 错误归一）：CNB 多数 POST/PUT/DELETE 返回 200 + 空 body，`cnbFetch` 会在 `response.json()` 抛 "Unexpected end of JSON input"，把成功报成失败。
- **`cnbGroups` 是组织列表的唯一共享状态**（`useCnbAuth.ts`），`fetchCnbGroups()` 写入；侧边栏 GroupsMenu 读它 —— 创建/转移组织后必须重新拉一次才能即时刷新。
- **vue-i18n message 里字面量 `@` 会炸**（邮箱、@提及）：必须写 `{'@'}` 或换词。这类错误 typecheck/键一致性/构建全不报错，只在渲染时抛 `Invalid linked format`。`locales.test.ts` 已加「消息可编译」常驻用例（遍历三语全部消息编译，负向验证过有效）。
- **切组织清 slug 不能复用 buildQuery**：会把旧 slug 原样写回，`router.replace` 变 no-op，URL 与状态不一致（刷新/分享会回到旧组织）。
- **组织域不做项**：Logo 上传（`upload_url` 域名动态 + 需 PUT 二进制流）、删除组织（需微信身份票据扫码）、贡献者趋势（`/{slug}/-/contributor/trend` 是 `repo-code:r` 的仓库级端点，组织路径 400）。
- **枚举实测量**：`organization.SettingValue` 33 个；`api.BranchProtection` 22 字段（id + rule + 21 可写）。设计文档 `docs/design/org-features-design.md` 已勘误。
