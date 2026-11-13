# 参与贡献 WOCNB

感谢你考虑为 WOCNB 贡献代码！WOCNB 是 [CNB.cool](https://cnb.cool) 的桌面客户端（Tauri 2 + Vue 3），本指南帮你完成从环境搭建到 PR 合并的完整流程。

> 分支模型、版本与 tag 规范、发布操作手册的**完整细节**见 [`docs/BRANCHING.md`](docs/BRANCHING.md)；本文是贡献者视角的速查与入口，两处不一致时以 `docs/BRANCHING.md` 与代码评审结论为准。

## 目录

- [开发环境搭建](#开发环境搭建)
- [常用命令](#常用命令)
- [提交前自检](#提交前自检)
- [代码规范](#代码规范)
- [分支与提交规范](#分支与提交规范)
- [提交 PR](#提交-pr)
- [CI 门禁说明](#ci-门禁说明)
- [审核标准](#审核标准)
- [文档地图](#文档地图)

---

## 开发环境搭建

### 前置要求

| 工具 | 版本要求 | 说明 |
| --- | --- | --- |
| Node.js | **≥ 22.12** | rolldown（Vite 构建链）的 engines 要求为 `^20.19 \|\| >=22.12`；版本不满足时 pnpm 会**静默跳过**平台原生依赖，直到 build 阶段才报 "Cannot find native binding"，很难指向根因 |
| pnpm | 12.14.0 | 由 `package.json` 的 `packageManager` 声明，推荐用 corepack 启用（见下） |
| Rust | stable | Tauri 2 后端；macOS 装 Xcode Command Line Tools 即可，Windows 需 [VS 2022 Build Tools](https://visualstudio.microsoft.com/zh-hans/downloads/) 并勾选「使用 C++ 的桌面开发」（MSVC），否则 cargo 链接阶段失败 |
| git | 任意近期版本 | — |

```bash
# 启用 corepack（Node 22 自带），自动按 packageManager 使用 pnpm 12.14.0
corepack enable

# 克隆并安装依赖
git clone https://cnb.cool/jackytse/wocnb.git
cd wocnb
pnpm install --frozen-lockfile
```

### 启动开发

```bash
pnpm tauri dev    # 完整桌面端：启动 Vite 后拉起 Tauri 窗口（托盘/通知等能力可用）
pnpm dev          # 纯浏览器调试：无 Tauri 能力，应用按 __TAURI_INTERNALS__ 自动降级
```

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | Vite 开发服务器（浏览器） |
| `pnpm tauri dev` | Tauri 开发模式（桌面窗口） |
| `pnpm build` | 生产构建（**同时生成** `auto-imports.d.ts` / `components.d.ts`） |
| `pnpm typecheck` | vue-tsc 类型检查 |
| `pnpm lint` | ESLint（src 目录，零告警要求） |
| `pnpm test` | Vitest 单元测试 |
| `pnpm tauri build` | 桌面端生产打包 |

## 提交前自检

本地依次执行以下命令，全绿再 push：

```bash
pnpm build       # ① 必须最先跑！
pnpm typecheck   # ②
pnpm lint        # ③
pnpm test        # ④
```

> ⚠️ **`build` 必须在 `typecheck` 之前**，这与直觉相反：`auto-imports.d.ts` 和 `components.d.ts` 被 `.gitignore` 忽略，干净克隆里不存在，跳过 build 直接 typecheck 必报 TS2304/TS2552。CI 门禁的 stage 顺序就是按此设计的（`install → build → typecheck → lint → test`）。

另外注意：`dev` 与 `build` **不要并发运行**，两者会并发写构建期生成物，产出语法损坏的文件。

## 代码规范

以下是本项目的硬性约定（评审会检查，CI 部分有常驻测试守护）：

1. **中文注释，覆盖率 ≥ 30%**：类/函数写「业务语义」，关键分支写「为什么这样做」，魔法值与状态枚举注明取值含义。简单 getter/setter 不必强行堆注释。
2. **i18n 三语同步**：`src/locales/` 下 `en` / `zh-CN` / `zh-TW` 三份的**键集合必须完全一致**（有常驻测试遍历校验）。⚠️ 消息文案中出现字面量 `@`（邮箱、@提及）必须写成 `{'@'}`，否则 vue-i18n 在**渲染时**抛 `Invalid linked format`，typecheck / lint / build 全都不报错。
3. **CNB API 单一通道**：所有 CNB 请求走 `useCnbAuth` 的 `cnbFetch`；返回 200 + 空 body 的写端点必须用 `cnbFetchVoid`（`cnbFetch` 会在 `response.json()` 把成功报成失败）。资源路径逐段编码，不要整段 `encodeURIComponent`（会把 `a/b` 压平导致路由不到）。
4. **403 绝不登出**：权限不足一律降级为提示（StateAlert / toast）并保留登录态，**只有 401 才**清除登录态跳登录页；写入口按权限**事前隐藏**而非事后报错。
5. **页面单根**：`src/pages/*.vue` 必须是单根 `<UDashboardPanel>`，弹窗放在 `<template #body>` 内 —— 多根节点会整体丢弃命名插槽，表现为弹窗/插槽失效。
6. **权限判定单点**：Master/Owner 判定只允许用 `useCnbAuth` 的 `canManageRole()`，禁止内联副本。
7. **依赖纪律**：不随手升级 / 删除依赖。`futures-util`、`tokio` 等在 `Cargo.toml` 有注释说明存在原因，动之前先读懂。
8. **UI 双主题**：所有颜色用 Nuxt UI 语义类（`text-highlighted` / `text-muted` 等），禁止硬编码颜色，保证深浅色都可用。

## 分支与提交规范

速查如下，完整规则（含每条规则的「为什么」与平台侧配置）见 [`docs/BRANCHING.md`](docs/BRANCHING.md)：

- **分支命名**：小写 kebab-case，`<type>/<slug>`（如 `feat/tray-menu-i18n`、`fix/build-log-scroll`）；只用一层斜杠；⚠️ **禁止以 `v` 开头** —— `v*` 是 tag 的 glob 键，分支命中它后 CI 一条流水线都不会跑且不报错。
- **提交信息**：[Conventional Commits](https://www.conventionalcommits.org/) + 中文描述，类型白名单 `feat` / `fix` / `chore` / `refactor` / `docs` / `perf` / `test` / `ci`。
- **版本与 tag**：只有 `v*` tag 触发发布；tag 必须与 `src-tauri/tauri.conf.json` 的 `version` 严格一致（CI 有 `version-check` 门禁）。贡献者一般**不需要**打 tag。

## 提交 PR

1. 从 `main` 切出分支，一个分支只做一件事。
2. 本地自检四连全绿（见[提交前自检](#提交前自检)）。
3. push 分支（任意分支 push 会自动触发 `ci-branch` 门禁）。
4. 向 **`main`** 发起 PR：
   - PR 标题必须符合 Conventional Commits（主干只允许 Squash 合并，PR 标题就是最终落库的 commit message，也是 changelog 的一行）；
   - 描述写清三件事：**改了什么 / 为什么改 / 怎么验证**；涉及 UI 的附截图（深浅色各一张更好）；建议配合仓库的 PR 模板（`.github/PULL_REQUEST_TEMPLATE.md`）；
   - 涉及 Tauri 平台能力（托盘、系统通知、窗口行为、IPC 命令、文件下载）的改动，请在描述中写明真机验证方式与结果 —— 这些行为 CI 覆盖不到。
5. CI 通过（状态检查名为 `ci-pr`）+ 至少 1 位评审通过 + 无冲突后，由维护者 Squash 合并。
6. 一个 PR 只做一件事；diff 超过约 400 行建议拆分。

## CI 门禁说明

本仓库的 CI 由 **CNB 云原生构建**驱动，配置在 [`.cnb.yml`](.cnb.yml)（其头部注释记录了大量真实踩坑与设计取舍，改动前务必先读）：

| 触发 | 流水线 | 内容 |
| --- | --- | --- |
| 任意分支 push | `ci-branch` | install → build → typecheck → lint → test |
| **任意 PR** | **`ci-pr`** | 同上（状态检查名即 `ci-pr`，分支保护勾选它即可） |
| 合并进 main | `ci-main` | 同上 |
| `v*` tag | `release-meta` 等 | 门禁 → 版本一致性 → 打包 → 创建 Release → 上传附件 |

- 门禁跑在官方 Linux 节点（`node:22` 容器），不需要本地有 Rust —— **前端质量检查已全自动，PR 无需任何手工触发**。
- PR 流水线刻意**不设按路径跳过**：纯文档 PR 也会跑完整门禁，避免「需要通过状态检查」的保护规则把 PR 永久卡住。
- 失败排查：先看 stage 名定位阶段，`install` 失败多为 pnpm/corepack 环境问题；`build-generate` 前置是本仓库特有设计（见[提交前自检](#提交前自检)）。更详细的排错记录见 `.cnb.yml` 头部注释与 [`docs/design/cnb-pipeline-design.md`](docs/design/cnb-pipeline-design.md)。

### GitHub 镜像门禁

代码同时镜像到 GitHub（`jackytse/wocnb`），那里有一份**同口径的镜像 CI**：[`.github/workflows/ci.yml`](.github/workflows/ci.yml)，在 push 到 `main`、任意 PR、以及手动触发时运行两个并行任务：

| 任务 | 内容 |
| --- | --- |
| 前端门禁 | install → build → typecheck → lint → test（顺序与 CNB 一致） |
| Rust 测试 | 装 Tauri Linux 系统库 → `cargo test --locked`（编译期需要 `dist/`，故先跑一次 `pnpm build`） |

两点注意：

- **CNB 仍是唯一的主门禁**：分支保护、发布与 Release 都挂在 CNB 上；GitHub 这份只提供 PR 检查结果，不作合并依据。
- 两份顺序必须同步修改。若你在本地跑 Rust 测试失败并提示 `frontendDist` 路径不存在，就是漏了先 `pnpm build`。

### GitHub 发版流水线

[`release.yml`](.github/workflows/release.yml) 在 GitHub 侧提供一条独立的发版链路（与 CNB 发版互不影响），流程为：**版本一致性校验 → 质量门禁（复用 `ci.yml`）→ 四平台打包 → Release 上传**。

| 触发方式 | 行为 |
| --- | --- |
| 推送 `v*` tag | 完整发版：`check-version.sh` 校验 tag ≡ `tauri.conf.json` 的 version → 跑门禁 → 打包 → 创建 GitHub Release 并上传安装包 |
| Actions 页面手动触发 | 打包验证（dry-run）：全矩阵构建并产出 Artifact，**不**创建 Release、不校验 tag，用于随时验证各平台能否正常出包 |

构建矩阵（`fail-fast` 关闭，单平台失败不影响其他平台产物）：

| 平台 | Runner | 产物 |
| --- | --- | --- |
| macOS arm64 | `macos-latest`（原生） | `.app` + `.dmg` |
| macOS x64 | `macos-latest`（交叉编译 `x86_64-apple-darwin`） | `.app` + `.dmg` |
| Windows x64 | `windows-latest` | `.exe`（NSIS；**预发布版仅 NSIS**，正式版加 `.msi`，见下方要点） |
| Linux x64 | `ubuntu-22.04` | `.deb` + `.AppImage` |

实现要点（改前必读）：

- 打包用 `--bundles` 显式覆盖 `tauri.conf.json` 的 `targets: "app"`（该值只对 macOS 有意义，是本机打包脚本的历史遗留约定）。
- macOS **无签名证书**：`signingIdentity: "-"` 为 adhoc 签名，产物可用但未公证，用户首次打开需「右键 → 打开」绕过 Gatekeeper。
- 预发布 tag（含 `-`，如 `v0.1.0-rc.1`）自动标记为 pre-release，不占 latest。
- **Windows 预发布版不出 MSI**：WiX 硬性要求版本预发布标识纯数字且 ≤65535，`-rc.N` 必被拒收（流水线内按版本动态解析，见 release.yml 的「解析 Windows 打包目标」步骤）。
- 每个平台除上传 Release 外，还会把 `bundle/` 产物上传为 workflow Artifact（保留 7 天），dry-run 验证就靠它取包。


## 审核标准

评审人主要看这几条（也是你的 PR 能否快速合并的关键）：

1. **CI `ci-pr` 绿**，且不是靠注释掉检查"变绿"。
2. **符合[代码规范](#代码规范)**：中文注释质量、三语键同步、API 通道与错误处理口径、页面单根。
3. **测试**：纯函数逻辑有对应单测（放 `src/**/__tests__/`）；修 Bug 的 PR 附回归用例。
4. **无未讨论的依赖变更**：新增依赖需在 PR 描述说明用途与理由。
5. **可维护性**：不引入与既有模式重复的第二份实现（如编码函数、权限判定）；命名与既有风格一致。
6. **UI 改动**：深浅色截图、三语文案完整、快捷键与弹层行为不回归。

## 文档地图

| 文档 | 内容 |
| --- | --- |
| [`README.md`](README.md) | 项目简介、快速开始、技术栈 |
| [`docs/BRANCHING.md`](docs/BRANCHING.md) | 分支模型、版本与 tag、发布操作手册、平台侧配置 |
| [`docs/design/cnb-pipeline-design.md`](docs/design/cnb-pipeline-design.md) | CI/CD 流水线设计与取舍依据 |
| [`.cnb.yml`](.cnb.yml) | CI 配置本体（头部注释是排错第一手资料） |

## License

贡献的代码将随项目以 [MIT](LICENSE) 协议发布。提交即表示你同意这一点。
