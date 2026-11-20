# WOCNB

**CNB.cool 的桌面客户端**——把 cnb.cool 的组织、仓库、议题与构建流水线搬进一个原生桌面窗口。

## 简介

WOCNB 是基于 Tauri 2 打包的 macOS 桌面应用（`productName` 为 `WOCNB`，标识符 `me.jackytse.wocnb`），前端为 Vue 3 + Vite + Nuxt UI 的单页应用，通过 CNB 开放 API 与 CNB CLI 拉取数据。

它解决的问题很具体：在浏览器里管理 CNB 时，标签页来回切换、构建日志需要反复刷新、离开页面就丢失上下文。WOCNB 把这些流程收敛到一个常驻桌面应用里——侧边栏做组织与仓库导航，仓库页用选项卡组织代码、提交、议题、合并请求、构建、Releases、制品库与社区，构建状态由后台轮询并在结束时推送系统通知，托盘常驻让应用随开随用。

## 功能特性

- **首页仪表盘**：三组选项卡——「动态」（本月个人活动）、「待办」（指派给我的开启中议题）、「我创建的」（我创建的开启中议题），按需懒加载，切换不重复请求。
- **组织概览与切换**：侧边栏组织菜单列出账号可见的组织，支持在当前组织维度下浏览仓库；旧版组织路由自动重定向到新路由。
- **仓库列表与详情**：仓库页列出当前组织（含子组织）的仓库，支持应用内新建仓库；详情页八个选项卡——代码（浏览 / 文件查看 / 分支切换 / 源码包下载）、提交（列表 / 详情 / 两分支 compare）、议题（列表 / 详情 / 时间线 / 新建 / 评论）、合并请求（列表 / 新建 / 详情 / Diff / 合并）、构建（列表 / 手动触发 / 详情 / 日志抽屉）、Releases（发布管理）、制品库（包列表与 tag 详情）、社区（贡献者墙 / 趋势 / Star 用户）。
- **Git 分支与标签管理**：代码浏览与提交页的分支选择器支持新建 / 删除 / 锁定分支，Git 标签支持创建 / 删除 / 详情查看（区分附注与轻量标签）。
- **仓库标签字典**：Issue 列表页增删改仓库标签（名称 / 配色 / 描述），与 Issue、PR 的标签编辑共用同一数据源。
- **Issue 属性与评论编辑**：Issue 详情面板可编辑处理人、标签与自定义属性；评论区支持编辑自己发表的 Issue 评论（保存前先拉取服务端最新正文）。
- **PR 评审**：PR 详情评审面板支持批准 / 请求修改 / 评论三档评审、评审人增删、评论树与回复；`?review=` / `?rcomment=` 深链可直达指定评审与评论；PR 标签支持整体覆盖编辑。
- **CI 状态徽标**：提交列表与 PR 详情展示 commit-status 六态徽标（success / failed / running / pending / canceled / skipped，未知值中性兜底）。
- **AI 用量面板**：构建详情内按流水线查看 AI 用量，模型汇总 → 分页明细 → 单条请求三级下钻，权限缺失时自动降级为提示。
- **提交与发布注解**：提交列表与 Releases 页可查看 / 编辑提交与 Release 的注解元数据。
- **分支保护规则**：组织页与仓库设置抽屉共用同一面板，分别按组织 / 仓库两种 scope 维护保护分支规则。
- **仓库成员管理**：成员页第四页签先选定完整仓库路径，再批量调整成员权限，并展示继承来源与有效成员。
- **探索页**：全局仓库搜索与排行榜，支持「全部 / 仅关注」切换，在桌面端完成「逛 CNB」。
- **成员列表**：成员 / 外部贡献者 / 继承成员 / 仓库成员四页签，支持关键词检索（页码经 URL `?page=` 传递，界面暂无翻页控件）与成员增删；权限不足（403）时展示缺失的 scope 并提供外跳管理页的降级路径。
- **登录与会话**：支持 CNB 访问令牌（PAT）与 CNB CLI 设备授权（OAuth）两种登录方式，会话启动时自动恢复；令牌页展示脱敏令牌、登录方式与到期时间，可一键退出并在 CLI 侧同步登出。
- **构建通知**：后台轮询关注的构建状态，结束（成功 / 失败）时向系统通知中心投递通知，未读数在铃铛徽标上体现。
- **深浅色主题**：跟随系统 / 手动切换，首屏内联脚本消除闪白，与 Nuxt UI 深色模式保持一致。
- **三语界面**：简体中文、繁體中文、English，运行时热切换，缺失键自动回退英文。
- **快捷键与命令面板**：`⌘K` 全局搜索、`G H` / `G S` 跳首页与设置、`N` 通知面板、`Esc` 关闭浮层。
- **系统托盘**：左键单击弹出快捷面板（最近仓库直达，附检测更新与退出），右键按光标位置弹出菜单（打开 / 退出），多显示器下不会弹错屏。
- **外链走系统浏览器**：Tauri Webview 内拦截外部 http(s) 链接交给系统默认浏览器打开，站内路由不受影响。
- **Markdown 与代码高亮**：议题 / 评论 / README 使用 marked + DOMPurify 渲染，代码用 Shiki 高亮。

## 技术栈

| 类别 | 选型 |
| --- | --- |
| 桌面框架 | Tauri 2（`tauri-plugin-opener`、`tauri-plugin-notification`、`tray-icon`） |
| 前端框架 | Vue 3（`<script setup>` + Composition API） |
| 构建工具 | Vite 8 |
| 组件库 | Nuxt UI v4（`@nuxt/ui` Vue 插件形态） |
| 样式 | Tailwind CSS 4 |
| 路由 | vue-router 5（文件路由 + `vite-plugin-vue-layouts`） |
| 国际化 | vue-i18n 11 |
| 单元测试 | Vitest 5（纯函数单测，node 环境） |
| 语言检查 | TypeScript 6 + vue-tsc |
| 代码规范 | ESLint 10 + eslint-plugin-vue + better-tailwindcss |
| 包管理器 | pnpm |

## 快速开始

```bash
# 安装依赖
pnpm install

# 启动 Web 开发服务器（浏览器内调试，无 Tauri 能力）
pnpm dev
```

打开 `http://localhost:5173`。纯浏览器模式下托盘、系统通知、外链转交系统浏览器等能力不可用（应用会按 `__TAURI_INTERNALS__` 是否存在自动降级）。

## 桌面端构建

```bash
# 开发模式（启动 Vite 后拉起 Tauri 窗口）
pnpm tauri dev

# 生产打包
pnpm tauri build
```

产物位于 `src-tauri/target/`，当前仅在 `src-tauri/tauri.conf.json` 的 `bundle.targets` 中打包 `app`（macOS 应用包，不产出 dmg）。

## 质量门禁

```bash
pnpm typecheck   # vue-tsc -p ./tsconfig.app.json
pnpm lint        # eslint src
pnpm test        # vitest run
pnpm build       # vite build
```

提交前建议四项全绿。注意 `components.d.ts` / `auto-imports.d.ts` / `src/route-map.d.ts` 为构建期自动生成物，`dev` 与 `build` 不要并发运行。

CI 有两份，口径一致：CNB（[`.cnb.yml`](.cnb.yml)，主门禁 + 发布）与 GitHub 镜像（[`.github/workflows/ci.yml`](.github/workflows/ci.yml)，PR 检查 + `cargo test`）。

## 分支与发布

主干为 `main`，日常开发一律从 `main` 切短生命周期分支（`feat/*`、`fix/*`、`chore/*`、`hotfix/*` …）后提 PR，主干只接受 Squash 合并；合并前必须通过 `ci-pr` 状态检查（`install → build → typecheck → lint → test`，`build` 前置是因为它负责生成构建期的 `*.d.ts`，缺了它们 `typecheck` 在干净克隆上会红）。

推送分支或 PR 只做校验、不发版；**只有推送 `v*` tag 才会发版**：`.cnb.yml` 先跑完整门禁，再校验 tag 与 `src-tauri/tauri.conf.json` 的 `version` 严格一致，然后打源码包 / Web 包、创建 Release 并上传附件。自托管节点已接入：macOS 出 arm64 `.dmg`（ad-hoc 签名），Windows 出 x64 `.exe`（`makensis` 不可用时降级为 portable 单文件）。

详见 [`docs/BRANCHING.md`](docs/BRANCHING.md)（分支规范、tag 与发布操作手册、需要人工在平台侧完成的设置）与 [`docs/design/cnb-pipeline-design.md`](docs/design/cnb-pipeline-design.md)（流水线设计与取舍依据）。

## 目录结构

```
wocnb/
├── src/
│   ├── pages/            # 文件路由页面：index / explore / login / group / members / profile / repos / settings
│   │   ├── repos/        # 仓库列表与仓库详情（[...repoPath]，详情页八页签）
│   │   └── settings/     # about / appearance / language / shortcuts / token
│   ├── components/       # 仪表盘卡片、组织菜单、用户菜单、通知抽屉、explore/* 探索、org/* 组织、repo/* 仓库子组件
│   ├── composables/      # 数据与业务逻辑：useCnbAuth / useCnbRepo / useCnbBuildWatch 等
│   ├── layouts/          # default（侧边栏 + 顶栏）/ blank（登录页）
│   ├── locales/          # en.ts / zh-CN.ts / zh-TW.ts
│   ├── router/           # 旧路由重定向等路由辅助
│   └── main.ts           # 应用入口：路由、i18n、外链处理、构建轮询
├── src-tauri/            # Rust 侧：窗口、托盘、CLI 调用、Tauri 配置与图标
├── docs/                 # 需求与设计文档
├── public/               # 静态资源
└── index.html            # 页面模板（含首屏主题内联脚本）
```

## 配置说明

### CNB 访问令牌

应用与 CNB 通信需要访问令牌，逻辑集中在 `src/composables/useCnbAuth.ts`：

1. 首次启动进入 `login` 页，可选「访问令牌（PAT）」或「CNB CLI 设备授权」登录；
2. 令牌与会话信息持久化在 **localStorage**（桌面单用户场景；后续可升级为系统钥匙串）；
3. 登录后可在 **设置 → 令牌**（`src/pages/settings/token.vue`）查看脱敏令牌、登录方式与到期时间，或退出登录后重新授权——出于安全考虑不提供应用内直接替换令牌的入口。

本地开发如果想免登录，可在 `.env.development` 中提供 `VITE_CNB_TEST_TOKEN`（该文件已被 `.gitignore` 忽略，请勿提交真实令牌）。

### 语言与主题

- 语言偏好、主题偏好均可在 **设置 → 语言 / 外观** 中调整，选择结果持久化到本地，重启后保留。
- 主题在页面加载前由 `index.html` 的内联脚本应用，避免浅色闪屏。

## 参与贡献

欢迎提 Issue 与 PR！开发环境搭建、代码规范、分支与提交规范、PR 流程与审核标准见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

速记版：从 `main` 切分支（kebab-case，**禁止 `v` 开头**）→ 本地 `build → typecheck → lint → test` 四连全绿（build 必须最先，生成 `*.d.ts`）→ push 后向 `main` 提 PR（标题符合 Conventional Commits，描述写清改了什么 / 为什么 / 怎么验证）→ CI 门禁 `ci-pr` 自动运行 → 评审通过后 Squash 合并。任意 PR 都会自动触发代码检查、测试与构建，无需手工触发。

发版：推送 `v*` tag 即自动发版（版本校验 → 门禁 → 打包 → Release）。CNB 与 GitHub 各有一条独立发版流水线——CNB 出 macOS arm64 dmg 与 Windows 包，GitHub 出 macOS（arm64/x64）/ Windows / Linux 全平台安装包；详见 [`CONTRIBUTING.md`](CONTRIBUTING.md) 的「CI 门禁说明」。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | 贡献指南：环境搭建、代码规范、PR 流程与审核标准 |
| [`docs/BRANCHING.md`](docs/BRANCHING.md) | 分支规范、版本与 tag 规范、发布操作手册、需在平台侧手动完成的设置 |
| [`docs/design/cnb-pipeline-design.md`](docs/design/cnb-pipeline-design.md) | `.cnb.yml` 流水线设计与取舍依据（含差异裁决与风险表） |
| [`docs/prd/cnb-api-coverage-prd.md`](docs/prd/cnb-api-coverage-prd.md) | 第一轮 CNB API 覆盖增量 PRD（A/B/C 组 48 端点，仓库 8 页签与探索页） |
| [`docs/design/cnb-api-coverage-design.md`](docs/design/cnb-api-coverage-design.md) | 对应的技术设计与任务分解（D1~D4 决策、5 批次 5 波次） |
| [`docs/design/org-features-design.md`](docs/design/org-features-design.md) | 组织能力扩展设计（组织设置 / 成员写 / 保护分支等范式） |
| [`docs/prd/cnb-api-gap-prd.md`](docs/prd/cnb-api-gap-prd.md) | 第二轮 API 全量差距盘点 PRD（171 条差距全景与 P0/P1/P2 分级） |
| [`docs/design/cnb-api-gap-design.md`](docs/design/cnb-api-gap-design.md) | 对应的技术设计与任务分解（P0 七任务 + P1 十任务，71 端点） |
| [`docs/prd/group-terminology-prd.md`](docs/prd/group-terminology-prd.md) | 组织（Group）术语与相关页面需求 |
| [`docs/design/group-terminology-design.md`](docs/design/group-terminology-design.md) | 对应的技术设计与时序 |
| [`docs/prd/P2-menu-i18n-backlog.md`](docs/prd/P2-menu-i18n-backlog.md) | P2 菜单与国际化待办 |

## 许可证与致谢

本项目以 MIT 协议发布，完整条款见 [`LICENSE`](LICENSE)。

本项目基于 MIT 协议的 Nuxt UI Dashboard（Vue）模板二次开发，原始版权归 Nuxt UI Templates 所有（`Copyright (c) 2025 Nuxt UI Templates`），详见 `LICENSE`。

技术栈致谢：Vue、Vite、Nuxt UI、Tailwind CSS、vue-router、vue-i18n、Vitest，以及 Tauri 及其插件生态。
