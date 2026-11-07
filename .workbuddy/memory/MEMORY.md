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

## 技术栈与既有约定

- Vue 3 + Vite + Nuxt UI v4（模板源自 nuxt-ui-templates/dashboard-vue），包管理器 pnpm
- Tauri 2：src-tauri/，identifier com.wocnb.dashboard，productName WOCNB，bundle targets 仅 "app"（本机 DMG 打包脚本与 macOS 新版 hdiutil 不兼容）
- 托盘：W 图标（白底黑 W），左右键均原生弹菜单（打开应用/退出应用）；关窗仅隐藏不退出
- 外链经 tauri-plugin-opener 在系统浏览器打开（main.ts 捕获阶段全局拦截）
- 用户偏好：新改代码要写详细中文注释（覆盖率 ≥30%）；改动后跑 cargo test + tauri build 验证
- 布局文件（layouts/*.vue）必须用 <RouterView /> 渲染页面，不能用 <slot />（vite-plugin-vue-layouts 机制），否则页面白屏
- CNB API 无 CORS 头，Webview 内 fetch 必须走 tauri-plugin-http（已配 capabilities url 白名单），前端统一用 useCnbAuth 的 httpFetch
- CNB 网关风控拦截 rustls TLS 指纹（403 Forbidden）；CNB API 请求必须走自建 cnb_http_request 命令（native-tls + no_proxy 直连），不要用 tauri-plugin-http 或原生 fetch
