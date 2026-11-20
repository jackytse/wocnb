# PRD · CNB Open API 全量差距盘点与增量（第二轮）

| 项目 | 内容 |
|---|---|
| 项目名 | wocnb（CNB.cool macOS/Windows 桌面客户端） |
| 技术栈 | Tauri 2 + Vue 3 + Nuxt UI v4 + vue-i18n（en / zh-CN / zh-TW） |
| 文档类型 | 增量 PRD（基于全量 swagger 268 operation 的二次盘点） |
| 上游依据 | `cnb-swagger.json`（268 operation）+ `cnb-all-operations.txt` + 实际源码扫描 |
| 原始诉求 | "对照 cnb api 文档检查一下，还有哪些功能没有实现的，去实现一下"；上下文："组织相关的功能太少了，参考 api 增加更多的功能" |
| 状态 | 待架构师评审 |
| 实施状态 | P0+P1 共 11 条需求 / 71 端点已全部实施（2026-11-18），QA 两轮验收通过；覆盖率 97 → 168/268（62.7%）；P2 与 backlog 未实施 |

---

## 1. 现状与覆盖率

### 1.1 统计方法与口径

上一轮的 `cnb-missing-operations.txt`（112 条）是**实现前的快照，已过时**，本轮不采信。本轮覆盖率由**实际源码扫描**得出：

1. **扫描范围**：`src/composables/**/*.ts`（排除 `__tests__`）、`src/pages/**/*.vue`、`src/components/**/*.vue`、`src/utils/*.ts`。
2. **检索模式**：`cnbFetch` / `cnbFetchVoid` / `cnbFetchText` / `cnbRequest` / `httpFetch` 调用，以及 `/-/`、`/user`、`/users`、`/groups`、`/ranks`、`/search`、`/events`、`/workspace` 等路径字面量；二进制下载（`downloadArchive` → `cnb_download_archive`）按构造 URL 计入。
3. **归一化**：调用点的具体路径（如 `/${encodeRepoPath(repo)}/-/git/commits/${sha}`）归一为 swagger 模板（`GET /{repo}/-/git/commits/{ref}`）；`{repo}` / `{slug}` / `{group}` 在 swagger 中是不同 operation，分开计数。
4. **判定**：`METHOD + 路径模板` 同时命中 swagger 中的一条 operation 即算"已实现"（数据层封装存在，不论 UI 是否暴露）。

### 1.2 覆盖率数字

| 指标 | 上一轮 PRD 所称 | 本轮实测 |
|---|---|---|
| 已实现端点 | 81/268（30%） | **97/268 ≈ 36.2%** |
| 未实现端点 | — | **171/268 ≈ 63.8%** |

> 差异说明：上一轮 81 是"计划落地口径"，本轮实测 97，多出的 16 条来自组织能力第二轮（`useCnbOrgSettings` / `useCnbMembers` / `useCnbBranchProtections` 的成员写、组织设置、保护分支、transfer、charge 等）及历史既有实现，上一轮文档未纳入统计。本轮以实测 97 为准。

> 注：本节及下文 §1.3 的数字均为**盘点时（实施前）快照口径**，仅作历史记录；P0+P1 实施后现状为 **168/268 ≈ 62.7%**（2026-11-18，见头部「实施状态」）。

### 1.3 当前"能做什么 / 不能做什么"

| 维度 | ✅ 现在能做（97 条） | ❌ 现在不能做（171 条） |
|---|---|---|
| 仓库 | 信息/内容浏览、分支·标签·提交**列表**、创建/编辑/归档仓库 | 分支/标签的**创建删除**、保护分支、推送管控、PR 设置、删除/转移仓库 |
| Git | 提交历史/详情、CI 状态、compare、raw、源码包下载 | commit/tag 元数据、blob 创建、分支锁、commit 附件、LFS |
| Issue | 列表/详情、新建、关闭重开、评论读写、动态 | 处理人、标签、自定义属性、评论编辑、附件、批量查询 |
| PR | 列表/详情、diff、提交、评论读写、合并、创建入口**尚无** | 新建/编辑 PR、评审、处理人、标签、状态检查、批量 |
| 流水线 | 历史/状态/阶段日志、触发/停止/删日志、构建通知 | AI 用量审计、Runner 日志下载、crontab 同步 |
| Release/制品 | 版本 CRUD（纯文本）、制品三级浏览、删制品/标签、附件下载 | 按 tag 取版本、附件上传/删、制品描述编辑、制品库浏览 |
| 组织/成员 | 组织概览/设置/创建/转移、成员增删改写、外部贡献者、保护分支（根组织）、仓库墙、子组织、用量 | 仓库级成员管理、根组织单条规则查询、组织维度贡献者（已裁决不做） |
| 社交/探索 | 粉丝/关注、Star 列表、贡献者、Fork、搜索、日/周/年榜、语言清单 | 月榜、用户详情/邮箱/GPG、活跃日历、Workspace、Event |
| 安全 | — | 仓库安全概览、代码扫描、制品安全概览 |

---

## 2. 未实现能力全景清单（171 条）

> 说明：本表按 swagger 标签（业务域）分组，穷举全部 171 条未实现端点。scope 取自 swagger `description`（部分端点无 scope 标注，记 `—`）。
> 处置列：`本轮` = 本 PRD 建议实现（REQ 编号见 §4）；`不做` = 明确不做（见 §3）；`后续` = 可做但本轮范围外、下沉 backlog（见 §2.2）。
> 难度：`低`=纯 JSON 且复用现有范式；`中`=需新数据层/UI；`高`=二进制流/二段式上传/特殊权限。

### 2.1 按域明细

#### Git（24 未实现：本轮 15 / 后续 9）
| 方法 | 端点 | scope | 业务价值 | 难度 | 处置 |
|---|---|---|---|---|---|
| POST | `/{repo}/-/git/branches` | repo-code:rw | 从客户端建功能分支 | 低 | 本轮 REQ-01 |
| DELETE | `/{repo}/-/git/branches/{branch}` | repo-code:rw | 删除临时分支 | 低 | 本轮 REQ-01 |
| GET | `/{repo}/-/git/branches/{branch}` | repo-code:r | 分支详情 | 低 | 本轮 REQ-01 |
| POST/DELETE | `/{repo}/-/git/branch-locks/{branch}` | repo-code:rw | 锁定/解锁分支防误推 | 低 | 本轮 REQ-01 |
| POST | `/{repo}/-/git/tags` | repo-release:rw | 打标签 | 低 | 本轮 REQ-02 |
| DELETE | `/{repo}/-/git/tags/{tag}` | repo-release:rw | 删标签 | 低 | 本轮 REQ-02 |
| GET | `/{repo}/-/git/tags/{tag}` | repo-release:r | 标签详情（轻量/附注） | 低 | 本轮 REQ-02 |
| GET/PUT/DELETE | `/{repo}/-/git/tag-annotations/{tag}` | repo-release:r/w | 标签元数据读写 | 低 | 本轮 REQ-08 |
| GET/POST/PUT/DELETE | `/{repo}/-/git/commit-annotations…` | repo-code:r/w | 提交元数据（含批量） | 低 | 本轮 REQ-08 |
| GET | `/{repo}/-/commit-assets/download/{commit_id}/{filename}` | repo-code:r | 下载 commit 附件 | 高 | 后续（二进制） |
| GET | `/{repo}/-/git/archive-commit-changed-files/{sha1}` | repo-code:r | 下载提交变更包 | 高 | 后续（二进制） |
| GET | `/{repo}/-/git/archive-compare-changed-files/{base_head}` | repo-code:r | 下载比较变更包 | 高 | 后续（二进制） |
| POST | `/{repo}/-/git/blobs` | repo-code:rw | 建 blob（编辑器前置） | 中 | 后续（无编辑器场景） |
| GET/POST/DELETE | `/{repo}/-/git/commit-assets…` | repo-code:r/w | commit 附件（含二段式上传） | 高 | 后续（二进制） |
| GET | `/{slug}/-/lfs/{oid}` | repo-code:r | LFS 下载链接 | 高 | 后续（二进制） |

#### GitSettings（11 未实现：本轮 11）
| 方法 | 端点 | scope | 业务价值 | 难度 | 处置 |
|---|---|---|---|---|---|
| GET/POST/GET{PATCH,DELETE} | `/{repo}/-/settings/branch-protections[/{id}]` | repo-manage:r/w | 仓库级保护分支 CRUD（与组织级同构，已有范式） | 低 | 本轮 REQ-07 |
| GET/PUT | `/{repo}/-/settings/cloud-native-build` | repo-manage:r/w | 云原生构建设置 | 低 | 本轮 REQ-12 |
| GET/PUT | `/{repo}/-/settings/pull-request` | repo-manage:r/w | 合并请求设置 | 低 | 本轮 REQ-12 |
| GET/PUT | `/{repo}/-/settings/push-limit` | repo-manage:r/w | 推送管控 | 低 | 本轮 REQ-12 |

#### Issues（25 未实现：本轮 16 / 后续 9）
| 方法 | 端点 | scope | 业务价值 | 难度 | 处置 |
|---|---|---|---|---|---|
| GET/POST/PATCH/DELETE | `/{repo}/-/issues/{number}/assignees[/{assignee}]` | repo-issue:r/w | Issue 处理人管理（高频） | 低 | 本轮 REQ-04 |
| GET/POST/PUT/DELETE | `/{repo}/-/issues/{number}/labels[/{name}]` | repo-issue:r/w | Issue 标签管理（高频） | 低 | 本轮 REQ-04 |
| GET/PATCH | `/{repo}/-/issues/{number}/comments/{comment_id}` | repo-notes:r/w | 评论编辑 | 低 | 本轮 REQ-09 |
| GET/PATCH | `/{repo}/-/issues/{number}/property` | repo-issue:r/w | Issue 自定义属性 | 中 | 本轮 REQ-09 |
| GET | `/{repo}/-/property[…/invisible]` | repo-issue:r | 仓库自定义属性字典 | 低 | 本轮 REQ-09 |
| GET | `/{repo}/-/files/issues/{file_path}`、`/{repo}/-/imgs/issues/{img_path}` | repo-issue:r | Issue 附件读取 | 高 | 后续（二进制） |
| POST | `/{repo}/-/issues/asset-groups[…upload-url]` | repo-issue:rw | 附件组与上传链接 | 高 | 后续（二段式） |
| GET | `/{repo}/-/issues/batch` | repo-issue:r | 批量查 Issue | 低 | 后续（无批量入口，收益低） |
| GET | `/{repo}/-/issues/{number}/activities/latest/{id}` | repo-issue:r | 最新动态（已有列表版） | 低 | 后续（信息重叠） |
| POST | `/{repo}/-/issues/{number}/comment-{file,image}-asset-upload-url` | repo-notes:rw | 评论附件上传 | 高 | 后续（二进制） |

#### Pulls（29 未实现：本轮 20 / 后续 9）
| 方法 | 端点 | scope | 业务价值 | 难度 | 处置 |
|---|---|---|---|---|---|
| POST | `/{repo}/-/pulls` | repo-pr:rw | 新建 PR（高频刚需） | 低 | 本轮 REQ-05 |
| PATCH | `/{repo}/-/pulls/{number}` | repo-pr:rw | 编辑 PR（标题/目标分支/状态） | 低 | 本轮 REQ-05 |
| GET/POST/DELETE | `/{repo}/-/pulls/{number}/assignees[/{assignee}]` | repo-pr:r/w | PR 处理人 | 低 | 本轮 REQ-05 |
| GET | `/{repo}/-/pulls/{number}/commit-statuses` | repo-pr:r | PR 维度 CI 状态 | 低 | 本轮 REQ-05 |
| GET/POST/PATCH | `/{repo}/-/pulls/{number}/reviews[/{review_id}]` | repo-notes:r/w / repo-pr:r | 评审 CRUD（批准/请求改动） | 中 | 本轮 REQ-10 |
| GET/PATCH | `…/reviews/{review_id}/comments[/{review_comment_id}]` | repo-notes:r / repo-pr:r | 行级评审评论 | 中 | 本轮 REQ-10 |
| POST | `…/reviews/{review_id}/replies` | repo-notes:rw | 回复评审评论 | 中 | 本轮 REQ-10 |
| POST/DELETE | `/{repo}/-/pulls/{number}/reviewers` | repo-pr:rw | 增删评审人 | 低 | 本轮 REQ-10 |
| GET/POST/PUT/DELETE | `/{repo}/-/pulls/{number}/labels[/{name}]` | repo-pr:r/w | PR 标签 | 低 | 本轮 REQ-10 |
| GET | `/{repo}/-/files/pulls/{file_path}`、`/{repo}/-/imgs/pulls/{img_path}` | repo-pr:r | PR 附件读取 | 高 | 后续（二进制） |
| DELETE | `/{repo}/-/files/{filePath}`、`/{repo}/-/imgs/{imgPath}` | repo-manage:rw | 删除上传附件/图片 | 高 | 后续（二进制） |
| GET | `/{repo}/-/pull-in-batch` | repo-pr:r | 批量查 PR | 低 | 后续（无批量入口） |
| GET/PATCH | `/{repo}/-/pulls/{number}/comments/{comment_id}` | repo-notes:r/w | 评论单条读/改 | 低 | 后续（已有列表+创建，边际价值低） |
| POST | `/{repo}/-/upload/files`、`/{repo}/-/upload/imgs` | repo-notes:rw / repo-code:rw | 上传附件/图片 | 高 | 后续（二进制） |

#### Members（10 未实现：本轮 8 / 后续 2）
| 方法 | 端点 | scope | 业务价值 | 难度 | 处置 |
|---|---|---|---|---|---|
| GET/POST/PUT/DELETE | `/{repo}/-/members[/{username}]` | repo-manage:r/w | 仓库级成员管理（与组织级同构） | 低 | 本轮 REQ-11 |
| GET | `/{repo}/-/members/access-level[/{username}]` | repo-manage:r | 仓库成员权限 | 低 | 本轮 REQ-11 |
| GET | `/{slug}/-/list-members` | repo-manage:r | 有效成员（含继承） | 低 | 本轮 REQ-11 |
| GET | `/{repo}/-/inherit-members` | repo-manage:r | 仓库继承成员 | 低 | 本轮 REQ-11 |
| POST | `/{mission}/-/members/{username}`、`/{registry}/-/members/{username}` | mission/registry-manage:rw | 任务集/制品库成员 | 低 | 后续（无任务集/制品库成员入口） |

#### Build（5 未实现：本轮 3 / 不做 2）
| 方法 | 端点 | scope | 业务价值 | 难度 | 处置 |
|---|---|---|---|---|---|
| GET | `/{repo}/-/build/logs/ai-audit/{sn}/{pipelineId}` | repo-cnb-history:r | AI 用量汇总 | 低 | 本轮 REQ-06 |
| GET | `/{repo}/-/build/logs/ai-request/{sn}/{pipelineId}/{page}` | repo-cnb-history:r | AI 请求明细 | 低 | 本轮 REQ-06 |
| GET | `/{repo}/-/build/logs/ai-request-detail/…/{requestId}` | repo-cnb-history:r | AI 请求详情 | 低 | 本轮 REQ-06 |
| POST | `/{repo}/-/build/crontab/sync/{branch}` | repo-cnb-trigger:rw | 同步分支定时任务 | 低 | 不做（见 §3 #10） |
| GET | `/{repo}/-/build/runner/download/log/{pipelineId}` | repo-cnb-trigger:r | Runner 日志下载 | 高 | 不做（二进制流） |

#### Releases（5 未实现：后续 3 / 不做 2）
| 方法 | 端点 | scope | 业务价值 | 难度 | 处置 |
|---|---|---|---|---|---|
| GET | `/{repo}/-/releases/tags/{tag}` | repo-release:r | 按 tag 取版本 | 低 | 后续（详情页已可由 id 进入） |
| GET/DELETE | `/{repo}/-/releases/{release_id}/assets/{asset_id}` | repo-release:r/w | 单附件读/删 | 高 | 后续（二进制流） |
| POST | `…/asset-upload-url`、`…/asset-upload-confirmation/…` | repo-release:rw | 附件二段式上传 | 高 | 不做（Q1 已裁决延后） |

#### Registries（3 未实现：后续 2 / 不做 1）
| 方法 | 端点 | scope | 业务价值 | 难度 | 处置 |
|---|---|---|---|---|---|
| PUT | `/{slug}/-/packages/{type}/{name}/-/description` | registry-package:rw | 改制品描述 | 低 | 后续（制品库只读定位） |
| GET | `/{slug}/-/registries` | group-resource:r | 我的制品仓库 | 低 | 后续（与 packages 列表信息重叠） |
| DELETE | `/{registry}` | registry-delete:rw | 删制品库 | 低 | 不做（高危写） |

#### Organizations（5 未实现：不做 3 / 后续 2）
| 方法 | 端点 | scope | 业务价值 | 难度 | 处置 |
|---|---|---|---|---|---|
| GET | `/user/groups/{slug}` | account-engage:r | 用户可见子组织 | 低 | 后续（与 `/-/sub-groups` 重叠，组织设计已标延后） |
| GET | `/users/{username}/groups` | account-engage:r | 他人顶层组织 | 低 | 后续（个人主页增强，非核心） |
| DELETE | `/{group}` | group-delete:rw | 删组织 | — | 不做（微信票据，见 §3 #2） |
| POST | `/{group}/-/upload/logos` | group-manage:rw | 上传 Logo | — | 不做（动态域名+PUT 二进制） |
| GET | `/{group}/-/git-group-settings/branch-protections/{id}` | group-manage:r | 单条根组织规则 | 低 | 后续（列表已含详情，边际低） |

#### Users（4 未实现：本轮 3 / 后续 1）
| 方法 | 端点 | scope | 业务价值 | 难度 | 处置 |
|---|---|---|---|---|---|
| GET | `/users/{username}` | account-profile:r | 他人用户详情 | 低 | 本轮 REQ-13 |
| GET | `/user/emails` | account-email:r | 邮箱列表 | 低 | 本轮 REQ-13 |
| GET | `/user/gpg-keys` | account-profile:r | GPG 密钥 | 低 | 本轮 REQ-13 |
| GET | `/user/autocomplete_source` | account-engage:r | 用户资源列表 | 低 | 后续（用途不明确） |

#### Activities（3 未实现：本轮 3）· Event（1）· Rank（1 月榜）· Security（1）· RepoCodeIssue（2）· ArtifactSecurity（1）
| 域 | 方法 | 端点 | scope | 处置 |
|---|---|---|---|---|
| Activities | GET | `/users/{username}/calendar` | account-engage:r | 本轮 REQ-15 |
| Activities | GET | `/users/{username}/repo-activities/{activityType}` | account-engage:r | 本轮 REQ-15 |
| Activities | GET | `/{repo}/-/top-activity-users` | repo-basic-info:r | 本轮 REQ-15 |
| Event | GET | `/events/{repo}/-/{date}` | — | 本轮 REQ-15 |
| Rank | GET | `/ranks/repo/monthly` | repo-basic-info:r | 本轮 REQ-13（补一个枚举值） |
| Security | GET | `/{repo}/-/security/overview` | repo-security:r | 本轮 REQ-14 |
| RepoCodeIssue | GET | `/{slug}/-/code/issues[/{record_id}]` | repo-code:r | 本轮 REQ-14 |
| ArtifactSecurity | GET | `/{slug}/-/sca-artifact-scan/…/security/overview` | registry-security:r | 本轮 REQ-14 |

#### Workspace（5 未实现：本轮 5）
| 方法 | 端点 | scope | 业务价值 | 难度 | 处置 |
|---|---|---|---|---|---|
| GET | `/workspace/list` | account-engage:r | 我的开发环境列表 | 中 | 本轮 REQ-15 |
| POST | `/{repo}/-/workspace/start` | repo-cnb-trigger:rw | 启动开发环境 | 中 | 本轮 REQ-15 |
| GET | `/{repo}/-/workspace/detail/{sn}` | repo-cnb-detail:r | 环境访问地址 | 中 | 本轮 REQ-15 |
| POST | `/workspace/stop`、`/workspace/delete` | account-engage:rw | 关闭/删除环境 | 中 | 本轮 REQ-15 |

#### Assets（4 未实现：后续 3 / 不做 1）
| 方法 | 端点 | scope | 处置 |
|---|---|---|---|
| GET | `/{repo}/-/files/{filePath}`、`/{repo}/-/imgs/{imgPath}` | repo-code:r | 后续（二进制） |
| GET | `/{slug}/-/list-assets` | repo-manage:r | 后续（asset 记录列表） |
| DELETE | `/{repo}/-/assets/{assetID}` | repo-manage:rw | 不做（高危写） |

#### Repositories（4 未实现：本轮 1 / 后续 1 / 不做 2）
| 方法 | 端点 | scope | 处置 |
|---|---|---|---|
| GET | `/user/repos` | account-engage:r | 本轮 REQ-13（我的仓库权限维度） |
| GET | `/users/{username}/repos` | account-engage:r | 后续（他人可见仓库） |
| DELETE | `/{repo}` | repo-delete:rw | 不做（高危写） |
| POST | `/{repo}/-/transfer` | repo-code:rw,repo-manage:rw | 不做（高危写） |

#### Badge（3）· Authentication（1）· AI（1）· KnowledgeBase（6）· NpcObservability（3）· Missions（8）· mission-resources（2）
全部 `不做`，见 §3。

### 2.2 数字汇总（self-consistent）

```
268 (全量)
├─ 97  已实现（36.2%）— 实测
└─ 171 未实现（63.8%）
   ├─ 95  本轮建议实现（§4）
   │      ├─ P0: 6 条 / 32 端点
   │      ├─ P1: 5 条 / 39 端点
   │      └─ P2: 4 条 / 24 端点
   ├─ 35  明确不做（§3）= 沿用裁决 5 + 本轮新增 30
   └─ 41  后续 backlog（可做但本轮范围外）
          Git 9 · Issues 9 · Pulls 9 · Assets 3 · Releases 3 ·
          Members 2 · Organizations 2 · Registries 2 ·
          Repositories 1 · Users 1
```

> 校验：`97 + 95 + 35 + 41 = 268` ✔；P0+P1+P2 端点无重复，且不与"不做"重叠。
> 完成本轮 P0 后覆盖率 → **129/268 ≈ 48.1%**；全部建议实现后 → **192/268 ≈ 71.6%**。

---

## 3. 明确不做清单 + 理由

> 原则：**已裁决过的事不重新列为待实现**。以下 35 条从"待实现"中剔除，架构与 QA 不必再评估。

### 3.1 沿用上一轮/组织设计已裁决（5 条）

| # | 不做 | 端点 | 理由 |
|---|---|---|---|
| 1 | Star / UnStar 写 | （Open API 无此端点） | Starring 标签仅 3 个读接口，写走 CNB 内部接口；不要留"点 Star"占位 |
| 2 | 删除组织 | `DELETE /{group}` | 需 `x-cnb-identity-ticket`（微信扫码票据），桌面端无法完成；仅外跳 Web |
| 3 | 上传组织 Logo | `POST /{group}/-/upload/logos` | 返回动态 `upload_url`，域名未声明白名单，且需 PUT 二进制流，超出 Rust 通道能力 |
| 4 | Release 附件上传 | `…/asset-upload-url`、`…/asset-upload-confirmation/…`（2 条） | Q1 已拍板：二段式上传（拿 URL→PUT 二进制→confirmation）本轮不做，附件区只读+外跳 |
| 5 | 用户可见子组织 | `GET /user/groups/{slug}` | 与现有 `/-/sub-groups` 信息重叠，无独立价值（组织设计标延后） |

### 3.2 本轮新增裁决不做（30 条）

| # | 不做 | 端点（条数） | 理由 |
|---|---|---|---|
| 6 | AI 对话 | `POST /{repo}/-/ai/chat/completions`（1） | AI 能力由 Web 端承载，桌面端不做大模型对话入口 |
| 7 | 知识库全套 | `/{repo}/-/knowledge/**`、`/search/npc`（6） | 知识库/Embedding 属研究向能力，无桌面端使用场景；`POST query` 已废弃 |
| 8 | NPC 可观测 | `/{repo}/-/npc-observability/**`（3） | NPC 调用审计属运营向，非开发者工作流 |
| 9 | 任务集全套 | `/{mission}/**`、`/{slug}/-/missions`、`mission-resources/**`（10） | Missions 属项目运营/任务编排域，桌面客户端无对应信息架构；本轮不引入新导航 |
| 10 | 分支 crontab 同步 | `POST /{repo}/-/build/crontab/sync/{branch}`（1） | 定时任务同步是 CI 内部维护动作，用户无感知、无手动触发价值 |
| 11 | Runner 日志下载 | `GET /{repo}/-/build/runner/download/log/{pipelineId}`（1） | 二进制流下载，且属运维排障，非日常功能 |
| 12 | 徽章全套 | `/{repo}/-/badge/**`（3） | 徽章为 CI 展示装饰，上传需额外数据流，优先级低 |
| 13 | id_token 兑换 | `POST /{repo}/-/id_token`（1） | 仅允许流水线 OCI token，桌面 PAT 场景不可用 |
| 14 | 高危写（删除/转移） | `DELETE /{repo}`、`POST /{repo}/-/transfer`、`DELETE /{registry}`、`DELETE /{repo}/-/assets/{assetID}`（4） | 不可逆、影响面大；沿用上一轮"组织删除/转移不做"口径，统一外跳 Web 处理 |

---

## 4. 本轮建议实现范围

> **务实原则**：P0 是本轮**必须落地并可被 QA 验证**的核心（6 条 / 32 端点，全部纯 JSON、复用现有范式）；P1 次之（5 条 / 39 端点）；P2 可选（4 条 / 24 端点）。
> **通用约束**（沿用上一轮 G1~G4）：
> - G1 数据层：优先扩展现有 composable（`useCnbRepo` / `useCnbOrg` / `useCnbMembers` / `useCnbReleases`），新域才新建；snake_case→camelCase 归一化，空值兜底。
> - G2 403 处理：需 `*-manage:r` 等 scope 的端点，失败只降级 `StateAlert`（注明所需 scope），**不整页报错、不登出**。
> - G3 二次确认：所有破坏性写（删分支/标签/成员/规则/环境）必须 `UModal`/`ConfirmDialog` 确认，danger 色。
> - G4 i18n：三语同步，命名见 §5。

### 4.1 P0（必须有 · 6 条 / 32 端点）

| 编号 | 名称 | 涉及端点 | UI 落点 | 验收标准 |
|---|---|---|---|---|
| REQ-01 | 分支管理 CRUD | `POST/DELETE/GET /{repo}/-/git/branches[/{branch}]`；`POST/DELETE /{repo}/-/git/branch-locks/{branch}` | 代码页 · `RepoBranchSelect` 下拉增加「新建分支 / 删除 / 锁定 / 解锁」菜单项（复用 `ConfirmDialog`） | 新建分支后下拉可见并可切换；删除受保护分支时服务端报错以 error toast 呈现；锁/解锁状态在下拉图标反映；400/403 不登出 |
| REQ-02 | Git 标签 CRUD | `POST/DELETE/GET /{repo}/-/git/tags[/{tag}]` | Releases 页签 · 列表顶部「新建标签」+ 每项删除；标签详情用现有 `MarkdownView`/信息卡 | 新建标签后列表与 Releases 同步出现；删除二次确认；`GET /{tag}` 展示轻量/附注类型与提交哈希 |
| REQ-03 | 仓库标签管理 | `GET/POST /{repo}/-/labels`；`PATCH/DELETE /{repo}/-/labels/{name}` | 新页签内 modal 或 Issue 列表页「标签管理」入口（色彩 chip 复用 `RepoIssueDetail` 标签样式） | 增删改标签后 Issue 标签选择器即时反映；颜色/描述字段正确保存；`repo-notes:rw` 无权限时入口隐藏 |
| REQ-04 | Issue 处理人与标签管理 | `GET/POST/PATCH/DELETE /{repo}/-/issues/{number}/assignees[/{assignee}]`；`GET/POST/PUT/DELETE /{repo}/-/issues/{number}/labels[/{name}]` | `RepoIssueDetail` 侧栏「标签/处理人」区改造为可点击编辑（当前只读展示）；处理人用 `USelectMenu` 多选，标签用下拉 | 添加/移除处理人后侧栏即时更新；标签增删正确；`assignee` 可分配性校验端点用于下拉过滤；空 body 写端点走 `cnbFetchVoid` |
| REQ-05 | PR 创建/编辑 + 处理人 + CI 状态 | `POST /{repo}/-/pulls`；`PATCH /{repo}/-/pulls/{number}`；`GET/POST/DELETE /{repo}/-/pulls/{number}/assignees[/{assignee}]`；`GET /{repo}/-/pulls/{number}/commit-statuses` | PR 列表页「新建 PR」按钮（`UModal` 表单：标题/源分支/目标分支，分支用 `RepoBranchSelect`）；`RepoPullDetail` 顶部「编辑」+ 处理人区 + CI 状态徽标区（**独立映射，勿复用 commit 六态**） | 新建 PR 成功后进详情；编辑标题/正文生效（主理人裁决：swagger `api.PatchPullRequest` 仅含 `title/body/state`、无 base 字段，目标分支仅新建时可选，不做"改目标分支"）；处理人增删正确；PR CI 状态按 `success/failed/pending/...` 独立映射并 hover 展示明细 |
| REQ-06 | CI · AI 用量查询 | `GET /{repo}/-/build/logs/ai-audit/{sn}/{pipelineId}`、`…/ai-request/{sn}/{pipelineId}/{page}`、`…/ai-request-detail/…/{requestId}` | `RepoBuildDetail` 新增「AI 用量」子区（构建详情下钻，复用 `sn`/`pipelineId` 路由键） | 三条数据分级展示（汇总→分页明细→单次详情）；无 AI 用量的构建显示空态；分页正确 |

> **P0 理由**：6 条全部为纯 JSON、与现有数据层/UI 高度同构（分支标签复用代码页，Issue/PR 复用详情页，保护分支复用组织级范式），是"功能变多"最高性价比；完成即把覆盖率从 36.2% 推到 48.1%。

### 4.2 P1（应该有 · 5 条 / 39 端点）

| 编号 | 名称 | 涉及端点 | UI 落点 | 验收标准 |
|---|---|---|---|---|
| REQ-07 | 仓库级保护分支规则 CRUD | `GET/POST/GET{PATCH,DELETE} /{repo}/-/settings/branch-protections[/{id}]`（5） | `RepoSettingsDrawer` 新增「保护分支」区块（复用 `OrgProtectionsTab` 组件与表单结构） | 规则增删改查闭环；与组织级页面互不串数据；`repo-manage:rw` 无权限时只读 |
| REQ-08 | 提交/标签元数据 | `GET/PUT/DELETE /{repo}/-/git/tag-annotations[/{tag}]`、`…/{tag_with_key}`；`GET/POST/PUT/DELETE /{repo}/-/git/commit-annotations…`（7） | 标签详情/提交详情新增「元数据」折叠区；批量查询用 `POST …/commit-annotations-in-batch` 一次拉取 | 元数据增删改后即时刷新；批量接口避免 N+1；删除二次确认 |
| REQ-09 | Issue 评论编辑 + 自定义属性 | `GET/PATCH /{repo}/-/issues/{number}/comments/{comment_id}`；`GET/PATCH /{repo}/-/issues/{number}/property`；`GET /{repo}/-/property[…/invisible]`（6） | `CommentSection` 每条评论加「编辑」；`RepoIssueDetail` 侧栏加自定义属性展示/编辑 | 评论编辑后正文更新；属性字典驱动表单；隐藏属性仅 `repo-issue:r` 可见 |
| REQ-10 | PR 评审 + 标签 | `GET/POST/PATCH /{repo}/-/pulls/{number}/reviews[/{review_id}]`；行级评论 `GET/PATCH …/comments[/{…}]`；`POST …/replies`；`POST/DELETE …/reviewers`；标签 CRUD（13） | `RepoPullDetail` 新增「评审」区（批准/请求改动按钮）+ 评审人管理 + 标签 chip 编辑 | 提交评审后状态徽标更新；行级评论与回复层级正确；标签增删正确；评审状态枚举独立映射 |
| REQ-11 | 仓库成员管理 | `GET/POST/PUT/DELETE /{repo}/-/members[/{username}]`；`GET …/members/access-level[/{username}]`；`GET /{slug}/-/list-members`；`GET /{repo}/-/inherit-members`（8） | `members.vue` 增「仓库成员」维度（复用组织成员表格/角色下拉/ConfirmDialog，按 `query.repo` 定位仓库） | 成员增删改查闭环；权限列采用批量端点优先、逐人降级（沿用 R9 N+1 规避）；仓库路径逐段编码 |

> **P1 理由**：评审、保护分支、元数据、仓库成员是高价值但更复杂/更大的一组，需要新组件或跨页联动；不阻塞 P0 上线，但应在本轮排期内完成。

### 4.3 P2（可选 · 4 条 / 24 端点）

| 编号 | 名称 | 涉及端点 | UI 落点 | 验收标准 |
|---|---|---|---|---|
| REQ-12 | 仓库设置增强 | `GET/PUT /{repo}/-/settings/{cloud-native-build,pull-request,push-limit}`（6） | `RepoSettingsDrawer` 增加三个设置子区块（只读展示 + 有权限可改） | 三类设置读写正确；403 只读降级 |
| REQ-13 | 用户资料补全 + 月榜 | `GET /users/{username}`、`GET /user/emails`、`GET /user/gpg-keys`、`GET /user/repos`、`GET /ranks/repo/monthly`（5） | `profile.vue`：他人主页/邮箱/GPG；「我的仓库」权限筛选；`explore.vue` 榜单周期 Tab 加「月榜」 | 各类数据正确渲染；月榜与日/周/年榜同款切换 |
| REQ-14 | 安全概览 | `GET /{repo}/-/security/overview`、`GET /{slug}/-/code/issues[/{record_id}]`、`GET …/sca-artifact-scan/…/security/overview`（4） | 仓库详情新增「安全」页签或社区页区块；列表→详情两级 | 安全统计与扫描问题正确渲染；无数据显示空态；`repo-security:r` 无权限降级 |
| REQ-15 | 活动与 Workspace | Activities 3 + Event 1 + Workspace 5（共 9） | `profile.vue` 活跃日历/仓库动态；首页 Event；新「开发环境」入口（列表/启动/详情/停止/删除） | 活动数据按日期渲染；Workspace 启停删走二次确认，状态即时刷新；访问地址可外跳浏览器 |

> **P2 理由**：安全/活动/Workspace 价值明确但属"锦上添花"，且 Workspace 涉及环境生命周期、安全涉及新页签；资源充裕则做，紧张可延后，不影响 P0/P1 主目标。

---

## 5. i18n 命名规范

- 命名空间按功能域划分，层级 `域.模块.键`，小驼峰；与上一轮 `repo.*` / `group.*` / `profile.*` / `explore.*` 保持同一前缀体系，避免重复键。

| 命名空间 | 覆盖范围 | 示例（zh-CN） |
|---|---|---|
| `repo.branches.*` | REQ-01 | `repo.branches.create`="新建分支"、`repo.branches.lockConfirm`="锁定后其他人无法推送，确定锁定 {branch} 吗？" |
| `repo.tags.*` | REQ-02/08 | `repo.tags.create`="新建标签"、`repo.tags.type`="标签类型" |
| `repo.labels.*` | REQ-03/04/10 | `repo.labels.manage`="标签管理"、`repo.labels.deleteConfirm`="删除标签 {name} 将从所有 Issue 移除，确定吗？" |
| `repo.issues.*`（扩展） | REQ-04/09 | `repo.issues.assignees`="处理人"、`repo.issues.customProperty`="自定义属性" |
| `repo.pulls.*`（扩展） | REQ-05/10 | `repo.pulls.create`="新建合并请求"、`repo.pulls.review.approve`="批准"、`repo.pulls.review.changesRequested`="请求修改" |
| `repo.build.aiUsage.*` | REQ-06 | `repo.build.aiUsage.title`="AI 用量"、`repo.build.aiUsage.empty`="本次构建无 AI 用量记录" |
| `repo.protections.*` | REQ-07 | `repo.protections.title`="保护分支规则"、`repo.protections.create`="新建规则" |
| `repo.members.*` | REQ-11 | `repo.members.title`="仓库成员"、`repo.members.scopeHint`="需要 repo-manage 权限" |
| `repo.settings.*`（扩展） | REQ-12 | `repo.settings.pushLimit`="推送管控"、`repo.settings.cloudNativeBuild`="云原生构建" |
| `repo.security.*` | REQ-14 | `repo.security.overview`="安全概览"、`repo.security.codeIssues`="代码扫描问题" |
| `profile.*`（扩展） | REQ-13/15 | `profile.emails`="邮箱"、`profile.gpgKeys`="GPG 密钥"、`profile.activityCalendar`="活跃日历" |
| `workspace.*` | REQ-15 | `workspace.title`="云原生开发环境"、`workspace.startConfirm`="启动开发环境可能产生资源费用，确定吗？" |
| `common.noPermission`（复用） | G2 通用空态 | "无权限查看该内容，需要 {scope} 权限" |

- **三语同步要求**：每个新键必须由工程师在 `en.ts` / `zh-CN.ts` / `zh-TW.ts` **同时补齐**；CI 以"三语键集合一致"为验收（缺任一语言键即构建告警，沿用 `src/locales/__tests__/locales.test.ts`）。
- **消息语法陷阱**：含 `{` / `}` 的文案须用 vue-i18n 命名参数，字面花括号需转义（组织设计 §5.1 已记录踩坑）。

---

## 6. 风险与约束

### 6.1 已知踩坑（必须 recap，违反即回归）

| # | 踩坑 | 约束 |
|---|---|---|
| 1 | **repo-scope 端点不能传组织路径** | `GET /{repo}/-/members`、`/-/contributor/trend`、`/-/outside-collaborators` 等 `{repo}` 占位符端点，传组织路径会被网关 `400 This feature is not supported for organizations.`。REQ-11 仓库成员必须先选定**完整仓库路径**再请求 |
| 2 | **403 只降级不登出** | 只有 401 触发全局登出；403/404 一律由 `StateAlert` 渲染"无权限/不存在"，注明所需 scope，不整页报错、不 logout |
| 3 | **空 body 写用 `cnbFetchVoid`** | 组织/成员/保护分支等写端点多返回 200/201 + 空 body；用 `cnbFetch` 会在 `response.json()` 抛 "Unexpected end of JSON input" 把成功当失败。REQ-04/05/07/11 的写端点逐条核对响应体 |
| 4 | **逐段编码路径** | `{slug}` 可能是多级子组织路径（`org/sub`），必须 `split('/').map(encodeURIComponent).join('/')`，整体 encode 会把 `/` 压成 `%2F` 导致 404 |
| 5 | **commit-statuses 六态独立映射** | `GET /{repo}/-/git/commit-statuses/{commitish}` 与 PR `commit-statuses` 的 `state` 是 GitLab 风格六态（pending/running/success/failed/canceled/skipped），与构建四态不同族；**禁止复用 `useCnbBuildWatch` 映射**，未知值中性兜底（沿用 R8） |
| 6 | **⌘K 只放静态动作** | 命令面板只加"跳探索页/跳仓库"等静态动作项，**不在面板内做远程搜索**（破坏 `useOverlayUnlockGuard` 弹层生命周期，整窗点不动，R14） |

### 6.2 本轮新增风险

| # | 风险 | 缓解 |
|---|---|---|
| N1 | 分支/标签删除是不可逆写，误删影响大 | G3 二次确认 + 文案写明后果；受保护分支删除由服务端拒绝并以 error toast 呈现，前端不静默 |
| N2 | Issue/PR 的 assignees/labels 写端点返回形态不一（有的空 body、有的返回列表） | 数据层逐条核对 swagger `responses`，按实际形态选 `cnbFetch`/`cnbFetchVoid`，成功后统一重拉详情（§8.5 写后一致性） |
| N3 | PR 评审涉及行级评论 + 回复的层级渲染，结构复杂 | 评审区独立组件封装，`review_id` / `review_comment_id` 走 query 下钻键；层级渲染单测覆盖 |
| N4 | 仓库成员/保护分支与组织级页面共用组件但 scope 不同，易串数据 | 组件通过 `scopeLevel: 'group' | 'repo'` prop 区分，端点拼装与权限判断隔离；两者 i18n key 分命名空间 |
| N5 | 保护分支规则表单字段多（匹配模式/合并要求/推送管控） | 以 swagger `dto.*Req` 为准逐字段映射，必填项表单校验；保存走增量 patch 避免清空已有配置 |
| N6 | Workspace 启停删涉及环境生命周期与费用 | 所有写操作 G3 二次确认，文案提示可能产生费用；状态变更轮询刷新，避免本地状态与服务端不一致 |
| N7 | N+1 请求（成员权限、批量查询） | 优先用 batch 端点（`/issues/batch`、`/pull-in-batch`、`/members/access-level`）；无 batch 的按需加载 + 缓存 + 并发上限 4（沿用 R8/R9） |
| N8 | 范围过大导致本轮做不完 | **P0（6 条/32 端点）为本轮硬承诺**，P1/P2 按资源伸缩；架构师分解任务时优先保证 P0 可独立交付与 QA 验证 |

---

## 附：端点计数核对表

| 类别 | 条数 | 端点数 | 依据 |
|---|---|---|---|
| 全量 | — | 268 | `cnb-all-operations.txt` |
| 已实现 | — | 97 | 源码实测（§1.1 方法） |
| 未实现 | — | 171 | 268 − 97 |
| ├─ 本轮建议 | 15 | 95 | P0 6/32 + P1 5/39 + P2 4/24 |
| ├─ 明确不做 | — | 35 | 沿用 5（含无端点的 Star 写说明）+ 新增 30 |
| └─ 后续 backlog | — | 41 | 可做但本轮范围外 |

> 注：§3 表 #1（Star 写）是"Open API 无此端点"的说明项，不占 35 条端点配额；35 条端点配额 = 沿用的 4 条实际端点（删组织/Logo/Release 附件上传 2）+ 组织设计延后的子组织查询 1 + 新增 30。计数以端点数为准。

## 变更记录

| 版本 | 变更 | 依据 |
|---|---|---|
| v1.0 | 初稿：全量 268 端点二次盘点，实测覆盖率 97/268，产出 171 条差距全景 + 35 不做 + 15 条建议（P0/P1/P2） | 源码扫描 + swagger 复核 + 上一轮 PRD/设计文档对齐 |
