# PRD · CNB Open API 覆盖增量（A+B+C 组，48 个端点）

| 项目 | 内容 |
|---|---|
| 项目名 | wocnb（CNB.cool macOS/Windows 桌面客户端） |
| 技术栈 | Tauri 2 + Vue 3 + Nuxt UI v4 + vue-i18n（en / zh-CN / zh-TW） |
| 文档类型 | 增量 PRD（基于现有仓库详情页 5 页签的功能扩展） |
| 上游依据 | CNB 官方 swagger（`.workbuddy/context/cnb-swagger.json`）+ 差距分析（`cnb-missing-operations.txt`） |
| 状态 | 待架构师评审 |

---

## 1. 背景与目标

WOCNB 当前仅封装约 34 个 CNB Open API 端点（覆盖率 34/268 ≈ **13%**），客户端只能"看"不能"管"：无法触发构建、无法发布 Release、无法归档/创建仓库，组织与社交维度（排行榜、搜索、粉丝）完全缺失。本轮按用户确认的范围补齐 **A 组（写操作 7 个）/ B 组（仓库新页签 20 个）/ C 组（组织与社交 21 个）共 48 个端点**，使桌面端从"只读浏览器"升级为"可管理的工作台"。

**衡量指标**

| 指标 | 现状 | 目标 |
|---|---|---|
| Open API 覆盖率 | 34/268 ≈ 13% | **81/268 ≈ 30%**（B3 附件上传 2 端点延后 +1 端点新增，口径见 §6-Q1） |
| 仓库详情页签数 | 5 | 8（新增 Releases / 制品库 / 社区） |
| 可执行的关键写操作（触发构建、发版、建仓、归档） | 0 | 4 类全覆盖 |
| 三语 i18n 键 | — | 新增文案 en / zh-CN / zh-TW 全量同步，无缺失键告警 |

---

## 2. 用户故事

### 个人开发者（角色 A）

| # | 故事 | 对应需求 |
|---|---|---|
| A-1 | As a 个人开发者，I want 在流水线页一键触发/停止构建，so that 不用切回网页改代码后重新跑 CI | REQ-A1、REQ-A2 |
| A-2 | As a 个人开发者，I want 在客户端查看并发布 Release（含 changelog），so that 发版不用开浏览器 | REQ-B1、REQ-B2 |
| A-3 | As a 个人开发者，I want 在提交列表看到每个 commit 的 CI 状态徽标并下载源码包，so that 快速判断哪次提交是绿的 | REQ-B8、REQ-B10 |
| A-4 | As a 个人开发者，I want 浏览自己组织下的制品（npm/docker 包）与溯源信息，so that 拉包前确认版本内容 | REQ-B4 |
| A-5 | As a 个人开发者，I want 通过全局搜索与排行榜发现热门公仓，so that 在桌面端完成"逛 CNB" | REQ-C4、REQ-C9 |

### 团队管理员（角色 B）

| # | 故事 | 对应需求 |
|---|---|---|
| B-1 | As a 团队管理员，I want 直接在客户端创建仓库、编辑仓库信息、归档废弃仓库，so that 日常仓库运维不用跳网页 | REQ-A3、REQ-A4、REQ-A5、REQ-A6 |
| B-2 | As a 团队管理员，I want 查看组织/仓库内每个成员的权限等级与继承来源，so that 排查"谁为什么能推代码" | REQ-C2、REQ-C5 |
| B-3 | As a 团队管理员，I want 编辑组织仓库墙（pinned repos），so that 新成员进来先看到核心仓库 | REQ-C3 |
| B-4 | As a 团队管理员，I want 查看仓库 Fork 拓扑与贡献者趋势，so that 评估外部贡献活跃度 | REQ-B6、REQ-B7 |

---

## 3. 需求池

> 通用约束（适用于所有条目）：
> - **G1 数据层**：新建 5 个 composable（`useCnbReleases.ts`、`useCnbPackages.ts`、`useCnbOrg.ts`、`useCnbSocial.ts`、`useCnbExplore.ts`）+ 1 个仓库管理写操作模块；**构建写操作并入 `useCnbRepo.ts`**（架构 D-裁决：不并入 `useCnbBuildWatch.ts`，后者职责是轮询监听），响应 snake_case → camelCase 归一化，字段空值兜底（`?? '-'` / 空数组）。
> - **G2 403 处理**：凡需要 `repo-manage:r` / `group-manage:r` 等 scope 的端点，失败时**不整页报错**，渲染 `StateAlert.vue` 的「无权限查看」空态变体，文案注明所需权限（如"需要仓库管理权限 repo-manage:r"）。
> - **G3 二次确认**：所有破坏性写操作（停止构建、删除日志、归档、删除 Release/制品/标签）必须弹 `UModal` 确认框，确认框文案明确后果且按钮用 danger 色。
> - **G4 i18n**：所有新文案三语同步。命名规范见 §3.4。

### 3.1 P0（必须有 · 8 条）

| 编号 | 名称 | 涉及端点 | UI 落点 | 交互要点 | 验收标准 |
|---|---|---|---|---|---|
| REQ-A1 | 触发构建 | `POST /{repo}/-/build/start` | 流水线页签 · 顶部「触发构建」按钮 | 需选分支（复用 `RepoBranchSelect`）；触发后复用 `useCnbBuildWatch` 轮询刷新列表并滚动到新流水线 | 点击后 3s 内列表出现新构建记录；403 时显示无权限空态 |
| REQ-A2 | 停止构建 | `POST /{repo}/-/build/stop/{sn}` | 流水线详情页 · 「停止」按钮（仅运行中状态显示） | G3 二次确认；停止后状态轮询刷新为 cancelled | 运行中构建可被停止且状态正确更新 |
| REQ-A3 | 删除构建日志 | `DELETE /{repo}/-/build/logs/{sn}` | 流水线详情 · 日志区右上角「删除日志」 | G3 二次确认（后果：日志不可恢复）；删除后日志区显示空态 | 删除后重新拉取详情，日志为空 |
| REQ-A4 | 编辑仓库信息 | `PATCH /{repo}` | 仓库页 · 新增「设置」入口（`RepoHeader` 下拉菜单），弹出编辑抽屉 | 可编辑字段以 `dto.RepoPatch` 为准：**描述 / license / site / topics**（共 4 个）。**仓库可见性不可通过 API 修改**（全库无对应端点，Web 端已锁定），页头以只读徽标展示可见性，编辑抽屉提供「在浏览器打开设置页」外链兜底；成功后 `RepoHeader` 数据即时刷新 | 修改描述后页头与详情即时反映新值；可见性徽标正确展示且不可编辑 |
| REQ-A5 | 归档 / 解除归档 | `POST /{slug}/-/settings/archive`<br>`POST /{slug}/-/settings/unarchive` | 同上设置入口 · 「归档仓库」菜单项 | G3 二次确认（后果：仓库变只读）；归档后页头显示归档徽标，写按钮全部禁用；已归档仓库菜单切换为「解除归档」 | 归档状态在页头与设置菜单双向正确切换 |
| REQ-A6 | 创建仓库 | `POST /{slug}/-/repos` | `/repos` 页右上 · 「新建仓库」按钮，弹窗表单 | 表单字段：名称（校验 `^[\w.-]+$`）、描述、**可见性（创建时可设：Private/Public，`dto.CreateRepoReq`）**、所属组织取当前选中 group（`selectedGroup`，需 `group-resource:rw` 权限）；201 后 toast + 列表刷新 + 跳转新仓库页 | 有权限的用户可创建仓库、列表出现新条目并直接进入；名称不合法时表单内联报错；403 时按钮置灰并注明所需权限 |
| REQ-B1 | Releases 浏览 | `GET /{repo}/-/releases`<br>`GET /{repo}/-/releases/latest`<br>`GET /{repo}/-/releases/{release_id}` | 新页签「Releases」 | 列表分页；每项展示 tag、标题、发布时间、是否 pre-release/latest 徽标、Markdown 正文（复用 `MarkdownView`）；附件列表只读展示（下载链接） | 列表与详情数据完整渲染；空仓库显示「暂无版本」空态 |
| REQ-B2 | Release 创建 / 编辑 / 删除（纯文本） | `POST /{repo}/-/releases`<br>`PATCH /{repo}/-/releases/{release_id}`<br>`DELETE /{repo}/-/releases/{release_id}` | Releases 页签 · 「新建版本」按钮 + 详情页编辑/删除 | 表单字段：tag、目标分支、标题、changelog（Markdown 文本域）、pre-release 开关；删除走 G3 确认 | 纯文本 Release 全生命周期（建→改→删）可在客户端完成；创建后列表即时刷新 |

> **P0 理由**：A 组 7 个写操作是用户明确表达的"最痛"缺失，客户端无写能力即失去存在意义；Releases 的读取与纯文本 CRUD 均为标准 JSON 请求，完全复用现有 composable/UI 范式，投入产出比最高，且发版是开发者高频刚需。REQ-A6 创建仓库归入 P0 已与架构设计对齐（设计文档 T05/P0，依据用户"A 组必须 P0"指令）。

### 3.2 P1（应该有 · 12 条）

| 编号 | 名称 | 涉及端点 | UI 落点 | 交互要点 | 验收标准 |
|---|---|---|---|---|---|
| REQ-B3 | Release 附件上传（二段式）🚫已确认延后 | `POST .../asset-upload-url`<br>`POST .../asset-upload-confirmation/{upload_token}/{asset_path}` | （下轮迭代）Release 详情/编辑表单 · 附件区「上传文件」 | 流程：本地文件选择 → 请求 upload-url → PUT 二进制 → confirmation 确认 → 刷新附件列表；需处理 token 过期重试。**§6-Q1 已确认：本轮不实现，2 个端点不计入本轮落地（落地口径 47）** | 下轮实现的验收：本地文件上传成功后出现在附件列表并可下载 |
| REQ-B4 | 制品库浏览 | `GET /{slug}/-/packages`<br>`GET /{slug}/-/packages/{type}/{name}`<br>`GET .../{type}/{name}/-/tag/{tag}`<br>`GET .../tag/{tag}/provenance` | 新页签「制品库」 | **`type` 为必填 query 参数**（枚举 13 值含 all/docker/helm/oci/npm/maven/ohpm/pypi/composer/nuget/conan/cargo/generic），左栏提供类型筛选下拉，**默认 `type=all`**；若部署返回 400 则**降级为按枚举逐类型请求并合并**（fanout，并发限 3）；类型下再列制品名称，右侧 tag 详情（**docker 制品需先取 `arch` 值回填**，如 `linux/amd64/v3`）；tag 详情展示创建时间、大小、digest；provenance 用 JSON 树/代码块展示 | 能完整浏览某仓库的制品→tag→溯源三级信息；类型筛选切换正确；`all` 不可用时降级路径数据完整；无制品显示空态 |
| REQ-B5 | 删除制品 / 标签 | `DELETE /{slug}/-/packages/{type}/{name}`<br>`DELETE .../tag/{tag}` | 制品库页 · item 操作菜单 | G3 二次确认，确认框需**手动输入制品名/标签名**才能点确认（仿 GitHub 删除仓库）；仅对有 `repo-manage` 权限的用户显示入口 | 删除后列表即时移除；权限不足时操作入口隐藏并显示说明 |
| REQ-B6 | Fork 列表 | `GET /{repo}/-/forks` | 新页签「社区」· Forks 区块 | 表格：Fork 路径、所属用户/组织、Fork 时间；点击跳转该仓库（复用 `useRepoRoute`） | 列表正确渲染并可跳转 |
| REQ-B7 | 贡献者与趋势 | `GET /{slug}/-/contributor/simply`<br>`GET /{slug}/-/contributor/trend` | 社区页签 · 贡献者区块 | simply：头像墙 + 提交数；trend：按时间轴渲染提交趋势图（可用简单柱状/折线） | 两类数据均正确渲染；trend 为空时不渲染图表容器 |
| REQ-B8 | 提交 CI 状态 | `GET /{repo}/-/git/commit-statuses/{commitish}` | 提交页签 · 每行 commit 加状态徽标 | **新建独立的状态→徽标映射**（如 `commitStatusMeta`）：此接口 `state` 为 GitLab 风格六态（pending/running/success/failed/canceled/skipped），与构建状态（pending/success/error/cancel）枚举不同，**禁止复用 `useCnbBuildWatch` 的状态映射**（`failed→error 色`、`skipped→中性色`、**未知值→中性色**）；懒加载，滚动到可视区再请求 | 提交列表正确显示 CI 状态徽标（含 failed/canceled/skipped 及未知值的中性兜底），hover 展示各 check 明细 |
| REQ-B9 | 提交差异比较 | `GET /{repo}/-/git/compare/{base_head}` | 提交页签 · 「比较」入口（选 base/head 后展示） | 复用 `PullDiffView` 渲染 diff；展示 ahead/behind 提交数 | 任选两个 ref 可查看差异与文件变更列表 |
| REQ-B10 | 下载源码归档 | `GET /{repo}/-/git/archive/{ref_with_path}` | 代码页签 · 分支选择器旁「下载源码包」菜单 | **该端点 swagger 未声明响应格式（produces 为空、无 query）**，按二进制流下载处理：本地文件**扩展名由响应 `Content-Type` / `Content-Disposition` 推断**（zip→.zip，gzip→.tar.gz），**不依赖 `?format=` 参数**（前端可默认请求 zip 并尽力附上该参数，但服务端忽略也不影响）；调用 Tauri 下载能力保存到本地下载目录；**秘密仓库禁止使用此接口**，菜单项置灰并提示"秘密仓库不支持导出" | 选定 ref 后文件成功保存（扩展名与实际格式一致）并可解压；秘密仓库菜单置灰不可点 |
| REQ-C1 | 组织信息与子组织 | `GET /{group}`<br>`GET /{slug}/-/sub-groups` | 组织页（现有 `group.vue`）增强 | 组织概览卡：头像、描述、仓库/成员数；子组织以卡片网格展示，点击进入 | 组织页展示完整概览信息与子组织导航 |
| REQ-C2 | 成员权限等级查询 | `GET /{group}/-/members/access-level`<br>`GET /{group}/-/members/{username}/access-level`<br>`GET /{repo}/-/members/access-level`<br>`GET /{repo}/-/members/{username}/access-level` | 现有成员页增强 | 成员列表追加「权限等级」列，**按需加载**：单成员接口形态（`/{username}/access-level`）决定了逐行请求，全量 50 行 = 50 次请求有 N+1 风险 → 默认进入视口/悬停时按需请求 + 提供手动「批量刷新」按钮；403 时按 G2 处理（成员页主体仍可见，权限列显示"无权限查看"） | 有权限时展示准确等级且请求数受控；无权限时优雅降级不阻塞页面 |
| REQ-C3 | 组织仓库墙 | `GET /{slug}/-/pinned-repos`<br>`PUT /{slug}/-/pinned-repos` | 组织页 · 仓库墙区块 | 展示模式全员可见；编辑模式（有权限者）：搜索添加仓库、**上下移按钮排序**（项目无拖拽库，Webview 指针事件有历史问题，不引入拖拽）、移除；PUT 提交全量列表 | 仓库墙编辑保存后组织页即时反映新顺序 |
| REQ-C4 | 全局公仓搜索 | `GET /search/public-repos` | 左侧导航 · 搜索框（快捷键 ⌘K），结果以 Slideover/弹层展示 | **接口无分页**：参数为 `key`（关键词）+ `topN`（默认 10，上限 100），另有可选 flags/order_by/desc；UI 提供「结果条数」选择（**10/30/50/100**），无「加载更多」，结果不足时提示"显示前 N 条，缩小关键词以精确匹配"；关键词防抖 300ms；结果项：仓库名、描述、星数/forks 数；点击直接进入仓库页 | 输入关键词返回相关公仓并可一键进入；topN 生效且无分页/加载更多 UI |

> **P1 理由**：B 组剩余项要么依赖二段式上传/二进制下载等技术专项（B3/B10），要么是浏览型增强（B4/B6/B7）与现有页签的体验升级（B8/B9）；C 组前四项补齐"组织管理"闭环，但独立价值低于写操作。均应在本轮完成，但不阻塞 P0 上线。

### 3.3 P2（可以有 · 5 条）

| 编号 | 名称 | 涉及端点 | UI 落点 | 交互要点 | 验收标准 |
|---|---|---|---|---|---|
| REQ-C5 | 继承成员查看 | `GET /{group}/-/inherit-members`<br>`GET /{repo}/-/inherit-members` | 成员页 · 「继承成员」子页签 | 展示从上级组织继承的成员及来源路径；与直接成员分区显示 | 继承成员列表与来源正确展示 |
| REQ-C6 | 关注 / 粉丝 | `GET /users/{username}/followers`<br>`GET /users/{username}/following` | 个人主页（`profile.vue`）增强 · 两个计数入口 | 点击计数弹出用户列表抽屉；点击用户可跳转其主页 | 计数与列表一致，用户互跳闭环 |
| REQ-C7 | Star 列表（只读） | `GET /user/stared-repos`<br>`GET /users/{username}/stared-repos`<br>`GET /{slug}/-/stars` | 个人主页「我的 Star」页签；仓库社区页签「Star 用户」区块 | 仅展示。**不支持点 Star**（见 §5 明确不做 #1）；仓库侧接口 `filter_type` 为**必填** query（枚举 all/followed），需实现筛选切换（默认 all） | 三类 Star 列表均正确渲染；filter_type 切换生效 |
| REQ-C8 | 用户仓库墙 | `GET /users/{username}/pinned-repos` | 个人主页 · 仓库墙区块 | 与组织仓库墙同款展示组件（只读） | 展示与组织墙一致的样式 |
| REQ-C9 | 排行榜 | `GET /ranks/repo/daily`<br>`GET /ranks/repo/weekly`<br>`GET /ranks/repo/annual`<br>`GET /ranks/repo/language-list` | 全局「探索」页（含 REQ-C4 搜索）· 排行榜区 | 周期 Tab（日/周/年）+ 语言筛选（language-list 驱动下拉）；Top N 榜单点击进仓库 | 三种周期榜单与语言筛选均可切换且数据正确 |

> **P2 理由**：C 组尾部条目属于"社交浏览"，无写操作依赖、交互简单，但单独价值有限（排行榜/粉丝非桌面端核心工作流）。放在 P2 意为：本轮资源充裕则做，紧张可延后，不影响主目标。

### 3.4 i18n 命名规范（G4）

- 命名空间按功能域划分，层级为 `域.模块.键`，小驼峰：

| 命名空间 | 覆盖范围 | 示例（zh-CN） |
|---|---|---|
| `repo.releases.*` | REQ-B1/B2/B3 | `repo.releases.create`="新建版本"、`repo.releases.preRelease`="预发布"、`repo.releases.deleteConfirm`="删除后版本及附件不可恢复，确定删除 {tag} 吗？" |
| `repo.packages.*` | REQ-B4/B5 | `repo.packages.title`="制品库"、`repo.packages.provenance`="溯源信息"、`repo.packages.deleteTypeToConfirm`="请输入 {name} 以确认删除" |
| `repo.community.*` | REQ-B6/B7/C7 区块 | `repo.community.forks`="Fork"、`repo.community.contributors`="贡献者"、`repo.community.starredBy`="Star 用户" |
| `repo.build.*` | REQ-A1/A2/A3 | `repo.build.trigger`="触发构建"、`repo.build.stopConfirm`="确定停止构建 #{sn} 吗？" |
| `repo.settings.*` | REQ-A4/A5 | `repo.settings.archive`="归档仓库"、`repo.settings.archiveConfirm`="归档后仓库将变为只读" |
| `group.*` | REQ-C1/C2/C3/C5 | `group.wall`="仓库墙"、`group.inheritedMembers`="继承成员"、`group.noPermission`="无权限查看，需要 {scope} 权限" |
| `profile.*` | REQ-C6/C7/C8 | `profile.myStars`="我 Star 的仓库"、`profile.followers`="粉丝" |
| `explore.*` | REQ-C4/C9 | `explore.search.placeholder`="搜索公开仓库"、`explore.rank.daily`="日榜" |
| `common.noPermission` | G2 通用空态 | "无权限查看该内容，需要 {scope} 权限" |

- en / zh-TW 文案由工程师按 zh-CN 语义补齐，CI 中以「三语键集合一致」作为验收检查项（缺失任一语言键即构建告警）。

---

## 4. UI 设计概要

### 4.1 仓库详情页：5 页签 → 8 页签

```
代码 | 提交 | Issue | 合并请求 | 流水线 | Releases | 制品库 | 社区
                                              (新)      (新)    (新)
```

- **Releases**：列表 → 详情两级。列表项 = tag 徽标 + 标题 + 时间 + pre-release/latest 徽标；详情 = Markdown 正文 + 附件列表 + 编辑/删除操作（按权限显示）。
- **制品库**：三栏布局 `制品列表 | Tag 列表 | Tag 详情(含 provenance)`。窄窗口降级为主从两级。
- **社区**：聚合页，纵向三区块：① 贡献者（头像墙 + 趋势图）② Fork 列表 ③ Star 用户。把三个低密度端点合并进一个页签，避免页签栏超过 10 项。
- 既有页签增强（不新增页签）：
  - 提交页：每行加 CI 状态徽标（REQ-B8）、顶部「比较」入口（REQ-B9）；
  - 代码页：分支选择器旁「下载源码包」菜单（REQ-B10）；
  - 流水线页：「触发构建」按钮 + 运行中构建「停止」+ 日志「删除」（REQ-A1~A3）；
  - `RepoHeader`：新增设置下拉（编辑/归档，REQ-A4/A5），归档态显示徽标。

### 4.2 全局导航

```
左侧导航（新增 2 项）
├─ 首页
├─ 探索 ★新（搜索 + 排行榜）
├─ 组织
├─ 仓库
├─ 成员
└─ 设置
```

- **探索**：上半区 ⌘K 搜索（REQ-C4），下半区排行榜（REQ-C9，周期 Tab + 语言筛选）。**已确认进一级导航**（§6-Q2）：它是唯一"发现新仓库"的入口，且桌面端没有网页首页的信息流兜底。
- **个人主页（profile）**：增强为 头部（头像/简介/粉丝·关注计数）+ 仓库墙 + 「我的 Star」页签（REQ-C6/C7/C8），不进导航（入口维持现状）。
- **组织页**：概览卡 + 仓库墙（可编辑）+ 子组织网格 + 成员权限列（REQ-C1/C2/C3）。

### 4.3 通用交互组件

| 组件 | 用途 |
|---|---|
| `StateAlert.vue`（扩展 no-permission 变体） | 403 空态：图标 + "无权限查看，需要 {scope}"，不整页报错（G2） |
| `UModal` 确认框（G3） | 破坏性操作；删除制品/标签需输入名称确认 |
| `MarkdownView` / `PullDiffView` / `RepoBranchSelect` | Release 正文 / compare diff / 触发构建选分支，全部复用 |
| 新 `RepoAttachUploader`（REQ-B3，**已确认延后至下轮**） | 二段式附件上传封装 |

---

## 5. 明确不做清单

| # | 不做的事 | 原因 |
|---|---|---|
| 1 | **Star / UnStar 写操作** | Open API Starring 标签下**只有 3 个读接口**，无任何写端点。网页端的点 Star 走 CNB 内部接口，不在 Open API 体系内。客户端只能展示"谁 Star 了它 / 我 Star 了哪些"（REQ-C7），任何"点 Star"按钮均无法实现，不要在 UI 上留占位。 |
| 2 | 未列入 A/B/C 的 64 个缺口端点 | 组织增删改、保护分支规则、推送管控、任务集（Missions）、AI 对话、徽章、LFS、commit-assets、NPC 等均不在用户确认的本轮范围。避免范围蔓延。 |
| 3 | MSI / Linux 打包 | 与 API 覆盖无关；且当前 bundle 不产 dmg，附件上传场景价值受限（相关联的 REQ-B3 已确认延后，见 §6-Q1）。 |
| 4 | 组织信息编辑 / 组织删除 / 仓库转移 | `PUT|DELETE /{group}`、`/{repo}/-/transfer` 属高危组织级写操作，未在用户确认范围，且一旦误操作影响面大。 |
| 5 | 制品库上传/发布 | Open API 制品相关端点只有查询与删除，发布走 CI 流水线推送，客户端无发布入口可做。 |

---

## 6. 决策记录（Q1~Q6 全部已闭环，非待办清单）

| # | 决策点 | 背景 | 已确认结论 |
|---|---|---|---|
| Q1 | **Release 附件上传是否本轮实现？** | 二段式上传（拿 URL → PUT 二进制 → confirmation）涉及本地文件选择与二进制流，技术难度高于其余全部 JSON 端点；且当前 bundle 不产 dmg，附件价值有限（架构 D1 技术依据：白名单不可审计 + body 收不了二进制 + 响应走 `.text()`） | ✅ **本轮不做**。REQ-B3 延后至下轮迭代，2 个端点不计入本轮落地（落地口径 47），本轮只做纯文本 Release（REQ-B2） |
| Q2 | **排行榜（探索页）是否进一级导航？** | 进导航 = 桌面端新增"逛 CNB"心智，改动导航信息架构；不进 = 降级为首页一个入口卡片 | ✅ **已确认：进一级导航**（理由见 §4.2） |
| Q3 | 组织仓库墙编辑能力（PUT）是否随本轮交付？ | PUT 已在本轮 48 端点清单内；若只想先看后编辑，可只交付 GET、PUT 延后 | ✅ **已确认：随本轮交付**（GET+PUT，排序用上下移按钮，不引入拖拽库，见 REQ-C3） |
| Q4 | 8 页签方案是否接受（Forks/贡献者/Star 合并为「社区」页签）？ | 备选方案是 Forks、贡献者各自独立页签（则页签达 9~10 个） | ✅ **已确认：接受合并方案**（8 页签） |
| Q5 | 删除制品/标签是否要求输入名称确认？ | 更安全但增加一步摩擦 | ✅ **已确认：要求输入名称**（不可逆且影响 CI 拉包） |
| Q6 | 创建仓库（`POST /{slug}/-/repos`）是否本轮实现、优先级？ | 曾出现 PRD 漏条目 + 架构 T05 标 P1 的口径分歧；创建仓库属 A 组 7 端点之一 | ✅ **已确认：本轮做，标 P0**（REQ-A6 / 架构 T05，批次 1 交付；P0 保持"A 组整体 P0"口径一致，交付顺序不变） |

---

## 附：端点覆盖核对表（48 = A 7 + B 20 + C 21，本轮实际落地 47 个，B3 的 2 个延后、创建仓库补入）

- A 组 7：build/start、build/stop、build/logs 删除、PATCH 仓库、archive、unarchive、**创建仓库** ✔（REQ-A1~A6，创建仓库对应 REQ-A6）
- B 组 20：Releases 8（REQ-B1×3、B2×3、**B3×2 延后**）、制品库 6（REQ-B4×4、B5×2）、Forks 1（B6）、贡献者 2（B7）、commit-statuses 1（B8）、compare 1（B9）、archive 下载 1（B10）✔
- C 组 21：组织信息 1 + 子组织 1（C1）、仓库墙 GET|PUT 2（C3）、access-level 4（C2）、继承成员 2（C5）、followers/following 2（C6）、stared-repos 3（C7）、用户仓库墙 1（C8）、排行榜 4（C9）、搜索 1（C4）✔

需求条目统计：**P0 × 8，P1 × 12，P2 × 5，共 25 条**。

---

## 变更记录

| 版本 | 变更 | 依据 |
|---|---|---|
| v1.0 | 初稿 | 需求范围（A+B+C 组 48 端点） |
| v1.1 | 按架构师 swagger 核对回写 6 处：① REQ-A4 可编辑字段改为 description/license/site/topics，可见性改只读徽标 + 浏览器外链（`dto.RepoPatch` 仅 4 字段，全库无改可见性端点）；② 新增 REQ-A6 创建仓库（原附录误计）；③ REQ-C4 明确 `key`/`topN` 无分页；④ REQ-B4 补 `type` 必填枚举、REQ-C7 补 `filter_type` 必填（all/followed）；⑤ REQ-B8 状态映射独立实现（GitLab 风格六态 ≠ 构建四态）；⑥ REQ-B10 补秘密仓库置灰、二进制流处理。另采纳：REQ-C2 权限列按需加载（防 N+1）、REQ-C3 上下移替代拖拽、覆盖率目标调整为 30%（81/268） | `docs/design/cnb-api-coverage-design.md` 架构核对 + swagger 复核 |
| v1.2 | 对齐设计文档 §1 全部修正细节 + §10 已拍板结论：① REQ-A6 验收补 name 正则 `^[\w.-]+$`、组织取 `selectedGroup`、201 后列表刷新+跳转；② REQ-B3 标记**已确认延后**（Q1 拍板本轮不做，落地口径 47）；③ REQ-B4 补 `type=all` 降级 fanout（400 时逐类型合并、并发限 3）与 docker 制品 `arch` 回填；④ REQ-B8 补未知值中性色兜底；⑤ REQ-B10 改为扩展名由响应 `Content-Type`/`Content-Disposition` 推断、不依赖 `?format=`；⑥ REQ-C4 条数选择定为 10/30/50/100；⑦ §6 决策表：Q1（附件上传不做）/Q2（探索进一级导航）/Q4（8 页签）/Q5（删除输名称）标记已确认，仅 Q3（仓库墙 PUT）待拍板；⑧ G1 数据层修正为构建写操作并入 `useCnbRepo.ts` + 新增 `useCnbExplore.ts`（采纳架构 D-裁决） | `docs/design/cnb-api-coverage-design.md` §1/§10 + team-lead 回写指令 |
| v1.3 | §6 定稿为**闭环决策记录**：标题去掉"待拍板"措辞，列名改为「已确认结论」；Q3（仓库墙 GET+PUT 随本轮交付）确认；**新增 Q6 创建仓库行**（team-lead 裁决：本轮做、标 P0，与架构 T05 批次 1 交付对齐，P0 维持"A 组整体 P0"口径）。至此 Q1~Q6 全部闭环，PRD 定稿，可交付工程师开工 | team-lead 裁决 + 架构设计文档对齐确认 |
