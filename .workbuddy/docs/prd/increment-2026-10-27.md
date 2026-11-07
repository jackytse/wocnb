# WOCNB 增量 PRD（2026-10-27）— 仓库详情 / Issue / PR / 流水线 + 模板残留清理

> 本文只描述**本次新增与变更**。已完成部分（Tauri 外壳、PAT 登录、三语 i18n、首页、组织页、仓库列表、个人资料页、`cnb_http_request` 通道）不重写。
> 交付对象：架构师（software-architect）作为设计输入；实现者（software-engineer）作为验收依据。

---

## 1. 项目信息

| 项 | 内容 |
| --- | --- |
| Language | 中文（界面文案 zh-CN / zh-TW / en 三语，与现状一致） |
| Programming Language | 现状即目标：Tauri 2 + Vue 3 + Vite + Nuxt UI v4 + Tailwind CSS + vue-i18n + pnpm（不引入新框架） |
| Project Name | `wocnb` |
| 代码库 | /Users/megadron/Projects/wocnb |
| 接口事实来源 | `/tmp/cnb-swagger.json`（199 端点，已逐项核对）；**禁止臆造端点** |

### 原始需求复述

在现有 WOCNB 桌面客户端中补齐"深层使用"能力：用户不再需要跳浏览器，即可在应用内看代码、读 Issue、看 PR、看构建；同时清掉 Nuxt UI 模板遗留的假数据页面，把设置页做成真实可用的设置。

---

## 2. 本次范围

### 2.1 In Scope（四块功能 + 清理）

| 模块 | 内容 |
| --- | --- |
| A 仓库详情 + 代码浏览 | README 渲染、目录树逐级浏览、文件内容（语法高亮）、分支/标签切换、提交历史与提交详情 |
| B Issue | 仓库 Issue 列表、详情（Markdown 正文）、评论列表与发表、关闭/重开、新建 Issue |
| C PR | 列表（状态筛选）、详情（描述/提交/变更 diff/评审/状态检查）、发表评论、合并 |
| D 流水线 | 构建历史列表、构建详情（阶段/步骤）、阶段日志查看 |
| E 清理与替换 | 删除 `/inbox`、`/customers`（含组件与假数据）；新增真实组织成员页；Settings 重构为通用/外观/语言/快捷键/令牌/关于 |

### 2.2 Out of Scope（本次明确不做）

- 代码编辑、提交、建分支 / 建标签（只读浏览）
- PR 创建（仅列表 + 详情 + 评论 + 合并）
- Issue 里程碑 / 看板 / 自定义属性编辑（`properties` 只读展示优先级）
- 行内 diff 评论、评审提交（approve / request changes）
- 实时构建日志（SSE / 长轮询）、构建取消外的高级流水线操作
- 制品库、任务集（mission）、密钥、Webhook 等其余 CNB 模块
- 全局搜索升级（Cmd+K 现有行为不变）

---

## 3. 产品目标（3 个，正交）

1. **减少跳出**：查看代码 / Issue / PR / 构建这四类最高频动作，100% 可在应用内完成，不再默认弹系统浏览器。
2. **可信**：页面上每个数字与状态都来自 CNB Open API 真实响应；应用内不再存在任何假数据页（模板残留清零）。
3. **不失控**：新增页面只读优先，写操作（评论、建 Issue、合并、触发构建）每个都具备确认、乐观反馈与失败可恢复路径；令牌权限不足时给出可操作的降级提示而不是空白页。

---

## 4. 用户故事

1. **As a 开发者（已用 PAT 登录）**，I want 从仓库列表点进仓库并像在 CNB 网站一样浏览目录和文件，so that 我能快速确认代码内容而不必切到浏览器、也不必重新登录。
2. **As a 被分配 Issue 的开发者**，I want 在首页「待办」点一条 Issue 直接看到正文和历史评论并回复，so that 我能当场处理掉这条待办，不用来回切窗口。
3. **As a 代码评审者**，I want 在 PR 详情里看变更文件的 diff、评审记录与状态检查，并能发表评论，so that 我能对别人的合并请求给出反馈。
4. **As a 提交者**，I want 看到自己刚推的提交触发了哪次构建、跑到哪个阶段、日志报了什么错，so that 我能判断是重新推一次还是改配置。
5. **As a 团队负责人**，I want 查看当前组织的成员与外部贡献者，并在设置里管理外观、语言与令牌，so that 客户端用起来像"我的工具"，而不是一个 demo 壳子。

---

## 5. 信息架构与路由

### 5.1 路由方案（关键决策）

**仓库路径必须用 catch-all 参数**：CNB 仓库路径可含多级子组织（如 `org/sub/api`），固定两段路由（`/:owner/:repo`）会失效。因此：

- 仓库身份 → 路径：`/repos/<repoPath 全路径>`（catch-all，`repoPath` 以 `/` 连接）
- 视图定位（页签 / 文件 / 编号 / 构建号）→ **query**，因为 catch-all 之后无法再挂静态子路由
- 页签切换用 `router.replace`（不污染历史），下钻到详情（文件、Issue、PR、构建）用 `router.push`（返回键可用）

> 文件命名：现有 `src/pages/repos.vue` **移到** `src/pages/repos/index.vue`（列表不变），新增 `src/pages/repos/[...repoPath].vue`（详情容器）。

### 5.2 路由表

| # | 页面 | 路由 | 入口位置 |
| --- | --- | --- | --- |
| 1 | 仓库列表（已有，改跳转） | `/repos` | 侧边栏「仓库」 |
| 2 | 仓库详情 · 代码（默认页签） | `/repos/:repoPath+?tab=code&ref=<ref>&path=<file>` | 仓库列表卡片点击（改：不再 `openUrl`） |
| 3 | 仓库详情 · 提交历史 | `/repos/:repoPath+?tab=commits&sha=<sha>` | 详情页顶部页签 |
| 4 | 仓库详情 · Issue | `/repos/:repoPath+?tab=issues&state=open&keyword=&page=` | 详情页顶部页签 |
| 5 | Issue 详情 | `/repos/:repoPath+?tab=issues&number=<n>` | Issue 列表条目；**首页「待办 / 我创建的」条目（改：不再 `openUrl`）** |
| 6 | 仓库详情 · PR | `/repos/:repoPath+?tab=pulls&state=open&page=` | 详情页顶部页签 |
| 7 | PR 详情 | `/repos/:repoPath+?tab=pulls&number=<n>` | PR 列表条目 |
| 8 | 仓库详情 · 流水线 | `/repos/:repoPath+?tab=builds&status=&page=` | 详情页顶部页签 |
| 9 | 构建详情 | `/repos/:repoPath+?tab=builds&sn=<sn>` | 流水线列表条目 |
| 10 | 组织成员 | `/members?tab=members\|outsiders&keyword=&page=` | 侧边栏「成员」（占用原「客户」位置，图标 `i-lucide-users`） |
| 11 | 设置 root | `/settings`（重定向到 `/settings/general`） | 侧边栏 Settings 组 |
| 12 | 设置 · 通用 | `/settings/general` | Settings 子项 |
| 13 | 设置 · 外观 | `/settings/appearance` | Settings 子项 |
| 14 | 设置 · 语言 | `/settings/language` | Settings 子项 |
| 15 | 设置 · 快捷键 | `/settings/shortcuts` | Settings 子项 |
| 16 | 设置 · 令牌 | `/settings/token` | Settings 子项 |
| 17 | 设置 · 关于 | `/settings/about` | Settings 子项 |
| — | 删除 | `/inbox`、`/customers`、`/settings/members`、`/settings/notifications`、`/settings/security` | — |

> 侧边栏最终结构：首页 / 组织 / 仓库 / 成员 / 设置（子项 6 个）+ 底部官方资源外链（不变）。

### 5.3 界面结构树（文字版）

```
应用壳（已存在：侧边栏 + 组织切换 + 用户菜单 + 通知面板）
├── /repos  仓库列表（已有组件 HomeRepos，改点击行为）
└── /repos/:repoPath  仓库详情容器  ← 本次核心
    ├── 头部区
    │   ├── 返回按钮（→ /repos）
    │   ├── repo.path 面包屑 + 可见性徽标 + 语言色点
    │   ├── 元信息条：star / fork / open issues / open PRs / license / 最近更新
    │   └── 右侧操作：「在浏览器打开」（openUrl，兜底出口）
    ├── 页签：代码 | 提交 | Issue | 合并请求 | 流水线
    ├── 代码页签
    │   ├── ref 选择器（head.name 默认，分支 / 标签分组下拉）
    │   ├── 面包屑路径（repo / dir … / file）+ 目录优先的条目列表
    │   ├── 文件视图（行号 + 语法高亮 + 复制 / 原始内容 + 大小与降级提示）
    │   └── 目录根下若存在 README.md → 渲染在列表下方
    ├── 提交页签：提交列表（分页）→ 提交详情（message / 作者 / 父提交 / 变更文件 P1）
    ├── Issue 页签：筛选条（状态 / 关键词）→ 列表 → Issue 详情
    │   └── Issue 详情：标题+状态+编号 / 正文 Markdown / 标签+处理人+优先级 / 评论列表 / 评论输入 / 关闭·重开
    ├── 合并请求页签：状态筛选 → 列表 → PR 详情
    │   └── PR 详情：标题+状态+base←head / 描述 Markdown / 提交列表 / 变更文件 diff / 评审 / 状态检查 / 评论 / 合并
    └── 流水线页签：构建历史列表 → 构建详情（pipeline 与阶段树 + 阶段日志抽屉）
```

---

## 6. 需求池

优先级定义：**P0 = 本次必须交付**（缺一即不可发布）；**P1 = 紧随其后**（P0 完成后按剩余工时取舍）；**P2 = 本次不做**（列出以防误解）。

### P0-0 通道与基础设施（前置，阻塞全部写操作）

> 这是本次**最容易被低估**的部分，架构设计必须先解决，否则 B/C/D 的写操作全部不可用。

| ID | 需求 | 验收标准 |
| --- | --- | --- |
| P0-0.1 | `cnb_http_request`（Rust）增加可选 `body: Option<String>` 参数并透传 `Content-Type`；无 body 时行为与现状完全一致 | 前端经 `cnbFetch` 发起 `POST /{repo}/-/issues/{n}/comments` 携带 JSON body，服务端返回 200/201；GET 请求回归正常；URL 白名单与 `no_proxy` 策略不变 |
| P0-0.2 | 前端新增文本通道：`cnbFetchText(path, init)`（不 `response.json()`，返回 `{ status, ok, text }`），`Accept` 可按调用方覆盖 | 调用 `GET /{repo}/-/git/raw/{ref}/{path}` 返回源码文本不抛"JSON 解析失败" |
| P0-0.3 | 统一 API 错误归一化（在 `useCnbAuth` 层）：401 → 现有登出跳登录；403 → 视为"令牌权限不足"，**不登出**，解析 `errmsg` 中形如 `xxx:r` 的 scope 名；404 → "资源不存在或无访问权限" | 用无 `repo-code:r` 的令牌打开代码页签，展示「权限不足：需要 repo-code:r」+「管理令牌」按钮，且不跳登录页 |
| P0-0.4 | 新增 `src/composables/useCnbRepo.ts`（或等价模块）承载 A/B/C/D 全部接口 + snake_case→camelCase 归一化；新增 `src/composables/useMarkdown.ts` 承载 Markdown 渲染与图片本地化 | 所有页面组件不直接拼 URL、不直接 `cnbFetch`；接口路径集中在一处便于审计 |

### A. 仓库详情 + 代码浏览

| ID | 需求（P0） | 验收标准 |
| --- | --- | --- |
| P0-A1 | 仓库卡片点击进入应用内详情（替换现 `openRepo` 外部打开） | 点击任一仓库 → 路由变为 `/repos/<path>?tab=code`；无网络请求落到浏览器；详情头部按钮仍可外跳 |
| P0-A2 | 仓库概览头：`GET /{repo}`（`repo-basic-info:r`）+ `GET /{repo}/-/git/head`（`openapi.HeadRef.name/protected`） | 展示 path、可见性、语言、star/fork/open issue/open PR、license、最近更新、默认分支名；缺失字段以 `-` 占位不报错 |
| P0-A3 | 目录浏览：`GET /{repo}/-/git/contents?ref=` 与 `GET /{repo}/-/git/contents/{file_path}?ref=`，按 `type` 区分 dir/file，目录优先 + 名称升序 | 从根逐级进入 ≥3 层目录、面包屑可点回任意层；空目录显示空态；`entries` 为空/非数组时降级为空态不崩 |
| P0-A4 | 文件内容查看：优先 `contents` 返回的 base64（`encoding=base64`）解码为 UTF-8，行号 + 语法高亮；提供"复制"与"在浏览器打开原始文件" | 打开 1KB / 100KB 的 `.ts` `.vue` `.md` `.json` 文件均正确显示内容与高亮；中文不乱码；二进制文件（含 `\0`）显示"二进制文件不支持预览" |
| P0-A5 | 大文件与 LFS 降级：> 256KB 关闭高亮（纯等宽文本）；> 1MB 不加载内容，仅显示大小 + "在浏览器打开"；`lfs_download_url` 非空时提示"LFS 文件，需外跳下载" | 分别用大文件 / LFS 文件验证三种降级文案与出口可用 |
| P0-A6 | README 渲染：目录根（且仅根）存在 `README.md`/`readme.md` 时在条目列表下方渲染 Markdown（表格、任务列表、代码块、标题锚点） | README 含表格与代码块时渲染正确；无 README 时不显示该区块 |
| P0-A7 | 分支 / 标签切换：`GET /-/git/branches`、`GET /-/git/tags`，下拉分组展示，切换写回 `?ref=` 并刷新目录与文件 | 切到某 `feature/x` 分支后目录与文件内容随之变化；`ref` 中的 `/`、`#` 等字符不破坏路由与请求 |
| P0-A8 | 提交历史：`GET /-/git/commits?sha=&page=`（`sha` 传当前 ref） | 列表展示短 SHA、标题行、作者、时间；分页可前进/后退；空仓库显示空态 |
| P0-A9 | 提交详情：`GET /-/git/commits/{ref}` 展示完整 message、作者/提交者、父提交 SHA（可点击跳到该提交）；变更文件列表延后到 P1 用 `compare` 实现 | 点提交条目展开详情，`parents` 为空（首个提交）时不显示父提交区 |
| P0-A10 | 页签与 query 双向同步：直接输入带 query 的 URL（如 `?tab=pulls&number=7`）能还原到同一视图 | 手改 URL 回车 / 应用内"刷新"后视图一致；`number` 非法时显示"未找到"而非白屏 |

### B. Issue

| ID | 需求（P0） | 验收标准 |
| --- | --- | --- |
| P0-B1 | 仓库 Issue 列表：`GET /{repo}/-/issues`，`state=open\|closed`（接口只支持两值，界面做 open/closed 分段控件，不提供"全部"）、`keyword` 搜索（回车触发）、`page`/`page_size=30` | 列表展示编号、标题、标签、处理人、评论数、更新时间；切状态与搜索后列表正确刷新；无结果时空态文案区分"无 Issue"与"无搜索结果" |
| P0-B2 | Issue 详情：`GET /{repo}/-/issues/{number}` 渲染标题、`#number`、state、作者、创建时间、正文（Markdown）、`labels`、`assignees`、`priority` | 正文中的代码块、列表、图片（走本地化管线）正常；`body` 为空时显示"暂无描述" |
| P0-B3 | 评论列表 + 发表：`GET/POST /{repo}/-/issues/{number}/comments`（写需 `repo-notes:rw`）；提交后评论出现在列表末尾并清空输入框；提交中禁用按钮 | 发表成功后无需手动刷新即看到新评论；失败保留草稿并 toast 报错；空内容不可提交 |
| P0-B4 | 关闭 / 重开：`PATCH /{repo}/-/issues/{number}` body `{ state: 'closed' \| 'open' }`（写需 `repo-issue:rw`）；操作前二次确认 | 关闭后状态徽标与列表状态同步变化；失败回滚 UI 状态并提示 |
| P0-B5 | 动态时间线（基础）：`GET /{repo}/-/issues/{number}/activities` 按时间展示 `type + actor + created_at`；`payload` 结构未定型，P0 仅做尽力解析，解析失败时只显示类型名 | 时间线与评论分区展示、不因 `payload` 异常而整块失败 |
| P0-B6 | 新建 Issue：`POST /{repo}/-/issues`（写需 `repo-issue:rw`），表单字段 `title`（必填，1–200 字）、`body`、`labels`、`assignees`、`priority`；成功后跳转到新 Issue 详情 | title 为空时按钮禁用；成功后路由变为 `?tab=issues&number=<新编号>`；接口未返回编号时跳列表并 toast 提示 |
| P0-B7 | 入口：仓库 Issue 页签右上「新建 Issue」按钮；**首页「+」按钮移除指向 `/inbox`、`/customers` 的两个假条目**，P0 改为"在浏览器新建 Issue"外跳（应用内跨仓库新建放 P1） | 首页「+」不再出现"New mail / New customer" |

### C. PR

| ID | 需求（P0） | 验收标准 |
| --- | --- | --- |
| P0-C1 | PR 列表：`GET /{repo}/-/pulls`，`state=open\|closed\|all`、`page`/`page_size=30` | 展示编号、标题、作者、base←head、评审数、评论数、更新时间；状态与分页切换正确 |
| P0-C2 | PR 详情：`GET /{repo}/-/pulls/{number}` 展示标题、state、`is_wip`/`is_merged`、`mergeable_state`、描述 Markdown、评审人及其 `review_state`、标签 | `is_wip` 显示草稿徽标；`mergeable_state` 为非干净态时给出文字说明（如冲突） |
| P0-C3 | 提交列表：`GET /{repo}/-/pulls/{number}/commits`（分页） | 与代码页签的提交条目样式一致；分页可用 |
| P0-C4 | 变更文件与 diff：`GET /{repo}/-/pulls/{number}/files`，展示 `filename`、`status`、`+additions/-deletions`、`patch`（unified diff 着色：新增绿/删除红/hunk 头灰）；单文件可折叠 | 打开含 ≥3 个文件的 PR，diff 着色与行号方向正确；`patch` 为空（二进制/大文件）时显示"无文本差异" |
| P0-C5 | 发表评论：`POST /{repo}/-/pulls/{number}/comments`（写需 `repo-notes:rw`），body `{ body }` | 与 Issue 评论一致的成功/失败/禁用态 |
| P0-C6 | 合并：`PUT /{repo}/-/pulls/{number}/merge`（写需 `repo-pr:rw`），表单含 `merge_style`、`commit_title`、`commit_message`；二次确认弹窗明示目标分支 | 成功展示返回 `sha`；失败（不可合并/权限不足）展示服务端 `message` 并保持详情页 |

> 说明：C6 虽属"合并操作"，但因无副作用的列表/详情已覆盖主要价值，**若工期紧张可整体后移至 P1**，由架构师在任务分解时决定。

### D. 流水线构建

| ID | 需求（P0） | 验收标准 |
| --- | --- | --- |
| P0-D1 | 构建历史：`GET /{repo}/-/build/logs`（`repo-cnb-history:r`），`page`/`page_size=30`、`status` 筛选（pending/success/error/cancel） | 列表展示状态徽标、`sn` 短号、提交标题、触发人 `nickName`、`sourceRef`、`event`、`duration`（人类可读）、`createTime`；无构建设置空态（含"暂无构建记录，推送代码后会出现在这里"） |
| P0-D2 | 构建详情：`GET /{repo}/-/build/status/{sn}`（`repo-cnb-trigger:r`），渲染 `status` 与 `pipelinesStatus` 的 pipeline→阶段两级树（`dto.BuildPipelineInfo`: `id/status/duration/createTime`） | 能展示至少一次真实构建的 pipeline 与阶段层级；`pipelinesStatus` 结构异常时不崩，降级为"仅显示流水线列表 + 外跳日志" |
| P0-D3 | 阶段日志：`GET /{repo}/-/build/logs/stage/{sn}/{pipelineId}/{stageId}` 返回 `content: string[]` + `status/duration`，在**右侧抽屉**内按行渲染（等宽、保留空白、自动滚到末尾、可复制全文、可"加载全部"） | 打开某阶段能读到真实日志文本；行数 > 2000 时默认渲染尾部 2000 行并可展开全部；任何阶段日志不可用时仍提供"在浏览器打开日志"（`buildLogUrl`/`eventUrl`）按钮 |
| P0-D4 | 日志查看方案取舍：**采用"内嵌阶段日志 + 浏览器兜底外跳"混合**，不做整份日志的 iframe 嵌入 | 每个阶段抽屉内都有"在浏览器打开"出口；错误态下该出口仍可用 |

### E. 模板残留清理 + 成员 + 设置

| ID | 需求（P0） | 验收标准 |
| --- | --- | --- |
| P0-E1 | 删除 `/inbox`、`/customers`：页面、`components/inbox/*`、`components/customers/*`、`types` 中仅供其使用的假类型、`useDashboard` 里仅服务于它们的字段（若有）、`locales` 对应键 | `pnpm build` 与 `pnpm typecheck` 通过；侧边栏、命令面板、`/` 页「+」下拉均不再出现收件箱/客户；全仓搜索 `dashboard-template.nuxt.dev`、`New mail`、`New customer` 无结果 |
| P0-E2 | 组织成员页 `/members`：`GET /{group}/-/members`（`group-manage:r`）+ `GET /{slug}/-/outside-collaborators`（`repo-manage:r`），两个页签；`search` 与 `role` 透传；展示头像、昵称、用户名、角色、加入时间 | 切换组织后成员列表联动刷新；403 时显示"权限不足（需要 group-manage:r）"+ 外跳 CNB 成员管理页；列表空态区分"无成员"与"无搜索结果" |
| P0-E3 | 设置重构（6 项，见 5.2）：<br>· 通用：当前登录用户（只读摘要）+ 当前组织（只读摘要）+ 链接到「个人资料」页与 CNB 令牌管理页<br>· 外观：系统/浅色/深色（复用 `useColorMode`，持久化）<br>· 语言：系统/简中/繁中/英文（复用 `localePref`），与用户菜单里的切换同源<br>· 快捷键：列出**真实已注册**的快捷键（Cmd/Ctrl+K 搜索、Cmd/Ctrl+R 刷新当前列表、Esc 关闭抽屉/弹窗、Cmd/Ctrl+, 打开设置）<br>· 令牌：当前令牌状态、替换令牌（弹窗内复用 `loginWithPat`）、退出登录、外跳管理页<br>· 关于：应用版本（Tauri `getVersion()`）、开源仓库地址、CNB 反馈、许可证 | 6 个子页均可访问且不出现英文模板文案；切换外观/语言立即生效并重启后保留；快捷键页列出的键位与实际行为一致（逐条手动验证）；`/settings` 访问时重定向到 `/settings/general` |
| P0-E4 | 删除 `/settings/members`、`/settings/notifications`、`/settings/security`（假数据/无用表单），侧边栏 Settings 子项同步为 6 项 | 直达上述旧 URL 显示 404/空态或重定向到 `/settings/general`，不出现假表单 |
| P0-E5 | 文案三语齐备：所有新增文案进 `src/locales/{zh-CN,zh-TW,en}.ts`，键结构一致 | 三语逐页切换走查，页面无中文硬编码残留（文案文件外） |
| P0-E6 | 首页 `/` 的演示性质控件清理：确认模板遗留的工具栏（已注释）与假数据组件不再被引用，未被引用的模板组件一并删除 | 全仓无未被引用的 demo 组件；首页功能与现状一致（三选项卡正常） |

### P1（P0 完成后按剩余工期取舍）

| ID | 需求 | 验收标准 |
| --- | --- | --- |
| P1-1 | 提交详情的变更文件列表（`GET /-/git/compare/{base...head}`，`base=parents[0].sha`） | 单条提交能看到增删文件与 diff；合并提交提示"合并提交暂不展示变更" |
| P1-2 | Issue 列表筛选增强：标签 / 处理人 / 优先级筛选（`labels`、`assignees`、`priority`） | 多选标签 `contains_any` 生效；筛选条件写入 query 可复现 |
| P1-3 | Issue 标签与处理人编辑：`PUT/POST/DELETE /{number}/labels`、`POST/DELETE /{number}/assignees`（`repo-issue:rw`） | 加/删标签即时生效并 toast；失败回滚 |
| P1-4 | PR 状态检查 `GET /{number}/commit-statuses` 与评审列表 `GET /{number}/reviews` 独立分区展示 | context/state/target_url 可点外跳；无检查项显示"未配置状态检查" |
| P1-5 | 流水线操作：触发构建 `POST /-/build/start`（branch/title）、停止构建 `POST /-/build/stop/{sn}`（均需 `repo-cnb-trigger:rw`），均二次确认 | 触发后 toast + 列表刷新出现新记录；停止后状态变为 cancel |
| P1-6 | 应用内跨仓库新建 Issue（首页「+」→ 选择仓库 → 新建表单） | 组织下仓库可搜索选择；创建成功跳对应详情 |
| P1-7 | 目录大列表优化：条目 > 300 时虚拟滚动或"显示更多"分段渲染 | 2000 条目目录滚动不掉帧（主观流畅、无明显卡顿） |
| P1-8 | 页签状态记忆：同一仓库内切换页签保留筛选条件与滚动位置 | 代码 → Issue → 代码切换后目录路径与展开状态不丢 |

### P2（本次明确不做）

- 行内 diff 评论、评审 approve/request changes、PR 创建
- 构建日志实时刷新（SSE / 轮询）、构建配置编辑
- 代码编辑/提交/建分支/建标签
- 制品库、任务集、密钥、成员权限变更（增删成员、改角色）
- Markdown 编辑器的可视化工具栏、图片上传（`asset-groups` 系列端点）
- 多窗口 / 深链接协议 / 离线缓存

---

## 7. 关键交互与状态处理

### 7.1 统一状态矩阵（每个数据区块都必须实现）

| 状态 | 表现 |
| --- | --- |
| Loading | 与内容形状一致的骨架屏（列表 5 行 / 详情 3 段 / diff 2 块），不整页 spinner |
| Empty | 图标 + 一句主文案 + 一句说明；区分"确实没有数据"与"筛选无结果" |
| Error（网络） | `UAlert` error + 重试按钮；错误文案带可读原因，不透出原始堆栈 |
| 403（权限） | `UAlert` warning：「令牌缺少 `xxx:r` 权限」+「管理令牌」（外跳 `cnb.cool/profile/token`）+「在浏览器打开」；**不登出** |
| 404（不存在/私有） | 「资源不存在，或当前令牌无权访问该私有仓库」+ 返回列表按钮 |
| 401（令牌失效） | 沿用现有全局拦截：清登录态 + 跳登录页 + 登录后原路返回 |

### 7.2 关键交互约定

1. **滚动与返回**：详情页顶部固定返回按钮；浏览器/键盘返回（`Cmd+[` 不要求，仅页面内返回）回到上一级列表。
2. **页签切换**：`router.replace`，仅换 query，不新增历史；切换时若目标页签已有数据则直接展示（内存缓存），提供"刷新"图标强制重取。
3. **文件导航**：目录条目点击 `push`；面包屑任意层级 `push`；`ref` 切换 `replace` 并重置 `path` 到根。
4. **写操作（评论/建 Issue/合并/关闭）**：按钮 loading + 禁用防重复提交；成功后 toast（成功色）+ 局部数据更新（不整页 reload）；失败保留用户输入 + toast（错误色）+ 透出 `errmsg`。
5. **危险动作**（关闭 Issue、合并 PR、停止构建）：`UModal` 二次确认，确认按钮文案明确动词（"关闭 Issue"/"合并到 `main`"）。
6. **外跳兜底**：每个深度页面右上角保留"在浏览器打开"（`openUrl`），URL 规则 `https://cnb.cool/{repoPath}/-/...`。
7. **Markdown 安全**：禁用原始 HTML（`html: false`），链接强制 `rel="noopener"`，非 `http(s)` 协议链接丢弃；所有外链走全局 opener 拦截器。
8. **Markdown 图片本地化**：`![](相对路径)` → 解析为 `https://cnb.cool/{repo}/-/raw/{ref}/{dir}/{img}`（或 `-/imgs/...`）后经 `cnb_fetch_image` 转 data URL；失败时显示灰块占位，不弹系统浏览器。
9. **键盘**：`Cmd/Ctrl+K` 保持现有搜索；新增 `Esc` 关闭抽屉/弹窗；`Cmd/Ctrl+R` 刷新当前列表（需在设置页如实列出）。
10. **组织切换联动**：`/members` 跟随 `selectedGroup`；仓库详情页的 repoPath 与组织无关（跨组织也能打开），但面包屑首段若等于当前组织则高亮。

---

## 8. 非功能要求

| 维度 | 要求 |
| --- | --- |
| 性能 | 单页首屏（骨架 → 内容）在正常网络下 < 1.5s；文件 > 256KB 关闭高亮；目录 > 300 条目分段渲染；日志 > 2000 行分片；PR diff 单文件 > 2000 行默认折叠 |
| 内存 | 页面切换后释放大对象（文件内容、diff、日志），保留的只有列表数据与滚动位置（P1） |
| i18n | 三语齐备，文案键与 `en.ts` 对齐；不出现中英混排 |
| 可访问性 | 所有交互可 Tab 到达；图标按钮带 `aria-label`（沿用现有组件） |
| 可观测 | 请求失败在开发期 `console.error` 带端点与状态；生产不打印令牌 |
| 安全 | 令牌仍只存 localStorage、只在 `Authorization` 头出现；Markdown 禁 HTML；Rust 白名单不变（仅 `api.cnb.cool`） |

---

## 9. 风险与依赖

| # | 风险 / 依赖 | 影响 | 应对 |
| --- | --- | --- | --- |
| R1 | **`cnb_http_request` 无 body 参数**（现状仅 `method/url/headers`） | 新建 Issue / 评论 / 合并 / 触发构建 **全部不可用** | P0-0.1 作为第一优先改造；Rust 侧加 `body: Option<String>` + `Content-Type` 透传，保持 GET 回归 |
| R2 | `cnbFetch` 强制 `response.json()`，且 Rust 侧固定 `Accept: application/json` | 无法读取 raw 文本文件 | P0-0.2 新增 `cnbFetchText`；`Accept` 允许覆盖（Rust 侧不得强写死） |
| R3 | 新增 Markdown 与代码高亮依赖 | 体积、渲染性能、XSS | 建议 `markdown-it`（`html:false`）+ `shiki`（懒加载、仅注册常用语言，或用 `highlight.js` 折中体积）；不引入重型框架；渲染结果按 repo+ref+path 缓存 |
| R4 | `ref` 含 `/`（如 `feature/x`）时 `GET /git/raw/{ref_with_path}` 的切分规则不明 | 分支文件可能 404 | 优先用 `contents?ref=`（base64 解码，无歧义）；raw 仅用于超大文件；无法确认分支时给"在浏览器打开"出口 |
| R5 | Secret（加密）仓库禁止 raw 接口 | 文件页签可能空白 | 统一走 `contents` 获取内容；命中 Secret 仓库时隐藏 raw 相关入口 |
| R6 | `build/status/{sn}` 的 `pipelinesStatus` 在 swagger 中是 free-form `object` | 阶段树可能拿不到 `pipelineId/stageId`，日志不可用 | A+ 用真实响应校对；无法解析时降级为"流水线列表 + 外跳 `eventUrl`"（P0-D3 的兜底必须实现） |
| R7 | 权限 scope 普遍不足（`repo-code:r`、`repo-issue:rw`、`repo-notes:rw`、`repo-pr:rw`、`repo-cnb-history:r`、`repo-cnb-trigger:r`、`group-manage:r`、`repo-manage:r`） | 大面积 403 | P0-0.3 统一 403 体验：提示缺失 scope + 管理令牌入口 + 外跳兜底；登录页/关于页补充"建议勾选的权限清单"文案 |
| R8 | 网关风控与 TLS 指纹（历史坑） | 新端点仍须走 Rust 通道 | 所有请求一律经 `cnbFetch`/`cnbFetchText`，**禁止**任何页面直连 `fetch`/`axios` |
| R9 | 仓库路径多级 + catch-all 路由 | 路由参数解析错误会导致错仓库 | 解析规则单点实现（`repoPath` 数组 join `/` 后再 `encodeURIComponent` 到 API 路径），并加一个"已知仓库列表校验"（来自 `/repos` 缓存）失败时提示而非静默 |
| R10 | 依赖真实响应校对（`pipelinesStatus`、`activities.payload`、`merge_style` 可选值、`postIssue` 返回体） | 部分交互细节可能需微调 | 列为待确认问题，实装前各抓一次真实响应固化类型 |
| R11 | 清理删除面较大（页面/组件/types/locales/useDashboard） | 编译失败风险 | 删除后必须跑 `pnpm typecheck` + `pnpm build` + `cargo test`；旧 URL 保留 404 兜底而非白屏 |

---

## 10. 待确认问题（需主理人/用户拍板）

1. **合并操作的优先级**：`PUT /pulls/{n}/merge` 取消/失败态较多（`mergeable_state` 依赖服务端计算，可能滞后），建议整体降为 P1；是否接受？
2. **阶段日志可行性**：`pipelinesStatus` 结构未在 swagger 明确，若真实响应无法给出 `pipelineId`/`stageId` 组合，是否同意直接采用"阶段列表 + 浏览器打开日志"（即 D3 退化为外跳）？
3. **`merge_style` 取值**：需实测确认（`merge` / `squash` / `rebase` 命名与默认值），是否是本次必须由用户可选，还是固定用服务端默认？
4. **设置里"令牌"页**：是否允许"替换令牌"（会覆盖当前登录态，存在误操作风险），还是仅提供"退出登录"+"外跳管理页"？
5. **快捷键**：目前应用未定义业务快捷键，P0 是否只做"如实列出真实键位"（Cmd+K / Esc / Cmd+R），不额外造功能？
6. **成员页位置**：放在侧边栏一级（`/members`，替代"客户"位置，推荐）还是放进设置作为子页？
7. **`/profile` 与设置「通用」的职责边界**：是否接受"通用"只做只读摘要 + 跳转，不再重复编辑个人资料？
8. **首页「+」按钮**：P0 直接改为"在浏览器新建 Issue"外跳是否可接受（应用内新建放 P1）？
9. **Issue 列表"全部"状态**：接口仅支持 `open`/`closed`，界面用两段切换（推荐）还是加"全部"由前端两次请求合并？
10. **代码高亮库选型**：`shiki`（质量高、体积大、需懒加载）vs `highlight.js`（体积小、主题少），倾向哪个？（影响打包体积目标）

---

## 11. 交付边界小结（防止膨胀）

**P0 一句话验收**：能用 PAT 登录后，从仓库列表进入任一仓库，在应用内浏览目录与文件（含 README 与高亮）、切换分支、看提交历史；能看 Issue 详情并评论/关闭/新建；能看 PR 列表、详情、diff 并发评论；能看构建历史、构建详情与阶段日志；假数据页面全部消失，设置页六项真实可用。所有网络失败都有明确文案与重试/外跳出口。

**若工期不足的砍单顺序**（架构师可据此裁量）：C6 合并 → P0-D2/D3 降级为外跳 → P0-B5 时间线 → P0-A9 提交详情 → P0-E3 中的快捷键与关于页。
