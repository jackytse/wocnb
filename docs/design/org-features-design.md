# 组织能力扩展设计（2026-11-11 第二轮）

> 目标：把「组织」从只读概览扩成可治理的工作台 —— 组织信息编辑、安全策略、保护分支规则、
> 成员增删改、创建子组织。所有端点以 `https://api.cnb.cool/swagger.json`（268 operation）
> 逐条核对，不接受推测。

## 1. 范围裁决（做 / 不做）

| # | 能力 | 端点 | 裁决 |
|---|---|---|---|
| 1 | 组织信息编辑 | `PUT /{group}` | ✅ 做 |
| 2 | 组织安全设置读取/保存 | `GET` / `PUT /{slug}/-/settings` | ✅ 做 |
| 3 | 创建组织 / 子组织 | `POST /groups` | ✅ 做 |
| 4 | 转移组织 | `POST /{group}/-/transfer` | ✅ 做（高危二次确认） |
| 5 | 成员添加 / 改角色 / 移除 | `POST` / `PUT` / `DELETE /{group}/-/members/{username}` | ✅ 做 |
| 6 | 批量成员权限 | `GET /{group}/-/members/access-level?include_inherit=` | ✅ 做（替代逐人 N+1） |
| 7 | 外部贡献者改权限 / 移除 | `PUT` / `DELETE /{slug}/-/outside-collaborators/{username}` | ✅ 做 |
| 8 | 组织保护分支规则 CRUD | `GET` / `POST` / `PATCH` / `DELETE /{group}/-/git-group-settings/branch-protections[/{id}]` | ✅ 做 |
| 9 | 上传组织 Logo | `POST /{group}/-/upload/logos` | ❌ 不做 |
| 10 | 删除组织 | `DELETE /{group}` | ❌ 不做（仅外跳） |
| 11 | 贡献者趋势/缩略 | `GET /{slug}/-/contributor/{trend,simply}` | ❌ 不做 |
| 12 | 用户可见子组织 | `GET /user/groups/{slug}` | ⏸ 延后（与 `sub-groups` 信息重叠，无独立价值） |

### 不做项的理由（写进代码注释，避免下一轮重新论证）

- **D1 Logo 上传**：`UploadAssetsResponse` 返回 `upload_url`，域名由服务端动态给出、swagger 未声明
  任何白名单；且需向该 URL **PUT 二进制流**。本项目的网络出口是自建 Rust 命令
  `cnb_http_request`（URL 前缀白名单 `https://api.cnb.cool/`，body 仅接受 String），
  与附件上传（设计文档 §D1）是同一堵墙。UI 保留「在 Web 端更换」外跳。
- **D2 删除组织**：需要 `x-cnb-identity-ticket`（微信身份验证票据，「首次请求不传会返回新票据」），
  本质是扫码二次验证，桌面端无法完成。且组织下存在子资源时服务端禁止删除。
  只提供外跳 `https://cnb.cool/{path}`。
- **D3 贡献者趋势**：`GET /{slug}/-/contributor/trend` 的 scope 是 `repo-code:r`，语义是**仓库**贡献者
  排名。按 `outside-collaborators` 的前车之鉴（同样的 `{slug}` 占位但语义是仓库，传组织路径
  直接 `400 This feature is not supported for organizations.`），不做组织维度入口。
- **D4 保护分支仅根组织**：端点描述明确「**根组织**保护分支规则」。判定：`slug` 含 `/` 即为子组织，
  页签内提示「保护分支规则在根组织统一配置」并给出跳转根组织（`slug.split('/')[0]`）的按钮，
  不发请求（避免必然的 400）。

## 2. 端点契约（供实现逐字对照）

所有路径的 `{group}` / `{slug}` 一律用 `encodeSlugPath`（逐段 `encodeURIComponent`，保留 `/`）。

### 2.1 组织信息

```
PUT /{group}                      scope group-manage:rw   → 200 空 body（用 cnbFetchVoid）
body dto.UpdateGroupReq（全部可选）：
  description, domain, email, readme_repo_path, readme_repo_id, remark, site, wechat_mp
```

> **勘误（2026-11-11 QA 回归发现，初稿结论是错的）**：初稿写「`GET /{group}` 不返回
> email/domain/remark/wechat_mp，无法回填」——**错**。`GET /{group}` 的 200 schema 是
> `dto.OrganizationAccess`，其中确实含 `description / site / email / domain / remark /
> wechat_mp / readme_repo_path`，**还含 `access_role`**（「用户在当前资源的最大权限」）。
>
> 这条错误结论造成了本轮最严重的缺陷：下钻子组织时把 `access_role` 硬编码为空串 →
> `canManageRole('')` 恒为 false → 用户对自己的子组织三个页签全部只读（设置/保护分支/
> 成员写操作全无入口）。而 `GroupsMenu` 只列顶层组织、子组织**只能**靠 `?slug=` 下钻
> 到达，等于「子组织在桌面端不可治理」。
>
> 现在：7 个字段全部回填，7 个字段统一「与基线比较，变化才提交」（清空 = 主动清空）；
> `accessRole` 从该接口回填并驱动 `canManage`。`OrgOverview` 新增字段已有单测锁定，
> 删掉映射会红。

### 2.2 组织安全设置

```
GET /{slug}/-/settings          scope group-manage:r   → dto.OrganizationSettingWithParent
PUT /{slug}/-/settings          scope group-manage:rw  → 200 空 body（cnbFetchVoid）
body dto.GroupSettingReq：
  hide_members(0|1), hide_sub_groups(0|1), show_private_repo_watermark(0|1),
  group_protection(0|1), email_verification(string[]), npc_price_limit(int),
  visitor_npc_price_limit(int), values(string，逗号拼接的 organization.SettingValue 枚举)
```

`organization.SettingValue` 共 **33** 个枚举值（实测 `swagger.json` 的 enum 长度为 33；
初稿写 34 是笔误，已由实现方核对修正，并要求 `SETTING_VALUES` 加长度断言防漂移），
UI 按语义分组渲染为开关（勾选即写入逗号串）：

- **组织与成员**：`disable_organization_readme` `disable_invitation` `enable_add_member`
  `enable_add_member_only_root` `enable_change_member_role_only_root` `disable_invite_auth_control`
- **资源创建**：`prevent_organization_creation` `prevent_repository_creation`
  `prevent_mission_creation` `prevent_registry_creation`
- **资源变更/删除**：`prevent_visibility_modification` `prevent_resource_deletion`
  `prevent_repository_archival`
- **资源转移**：`prevent_organization_transfer` `prevent_repository_transfer`
  `prevent_mission_transfer` `prevent_registry_transfer`
- **Git 与配额**：`use_group_git_quota` `use_group_git_object_limit` `use_root_group_git_push_limit`
- **保护分支管控**：`user_root_group_branch_protection_only` `forbid_redefine_branch_protection`
- **NPC / 触发器**：`only_repo_member_can_mention_npc` `allow_npc_cross_repo` `allow_cron_cross_repo`
  `allow_uncredible_cross_repo` `enable_other_group_npc_add_comment` `disable_repo_event_auto_trigger`
  `disable_repo_cron_auto_trigger` `disable_repo_npc_auto_trigger`
- **其它**：`cloud_native_dev_only` `enable_tapd_access` `enable_show_private_mission_water_mark`

保存语义：`values` 必须**全量提交**当前勾选集合（后端是覆盖写）。切换开关后点「保存」才提交，
不做即时保存（33 个开关逐个发请求既慢又容易半途失败）。

`can_show_members` / `can_show_sub_groups` / `can_show_watermark` 是**上级限制位**：
为 false 时对应开关必须 disabled 并提示「上级组织已限制」。`root_*` 字段只读展示（根组织基线）。

### 2.3 创建组织

```
POST /groups                     scope group-manage:rw   → 201
body dto.CreateGroupReq：path(必填，可含父路径如 parent/new-group), description, remark, bind_domain
```
成功后：`fetchCnbGroups()` 刷新侧边栏列表 → 选中新组织 → 跳 `/group`。

### 2.4 转移组织

```
POST /{group}/-/transfer         scope group-manage:rw   → 200
body dto.TransferSlugReq：{ source: 当前组织 path, target: 目标父组织 path }
```
`typeToConfirm` 输入当前组织名才可提交。成功后刷新组织列表（路径已变）。

### 2.5 成员写操作（组织直属成员）

```
POST   /{group}/-/members/{username}   scope group-manage:rw  → 200 空 body
PUT    /{group}/-/members/{username}   scope group-manage:rw  → 200 空 body
DELETE /{group}/-/members/{username}   scope group-manage:rw  → 200 空 body
body dto.UpdateMembersRequest：{ access_level: AccessRole, is_outside_collaborator?: boolean }
```
`AccessRole` 枚举：`Guest` / `Reporter` / `Developer` / `Master` / `Owner`（大小写敏感，首字母大写）。
`username` 走**路径段**，必须 `encodeURIComponent`。移除成员需 `typeToConfirm` 输入 username。

### 2.6 批量成员权限

```
GET /{group}/-/members/access-level?include_inherit=true|false   scope group-manage:r
```
⚠️ swagger 把响应当成**单个** `dto.MemberAccessLevelInSlugUnion`（`access_level` / `inherit` /
`read_privilege` / `write_privilege`），但接口语义是「当前层级成员的权限信息」—— 真实结构大概率是
`map[username]MemberAccessLevelInSlugUnion`（Go 的 map 在 swagger 里常被展平）。
归一化必须兼容三种形态：

1. `{ "alice": {access_level, inherit, read_privilege, write_privilege}, ... }` → 逐键转条目；
2. `[{ username, access_level, ... }]` → 按数组处理；
3. 单对象（无 username 键）→ 返回空 Map，UI 自动降级为「逐人按需加载」（现有能力）。

### 2.7 外部贡献者写操作（仓库级）

```
PUT    /{slug}/-/outside-collaborators/{username}?role=Guest|Reporter|Developer   → 200 空 body
DELETE /{slug}/-/outside-collaborators/{username}                                 → 200 空 body
```
`role` 是 **query 参数**（不是 body），枚举只有三档（无 Master/Owner）。
`{slug}` 是**仓库完整路径**（`org/repo`），沿用成员页已有的仓库选择器上下文。

### 2.8 保护分支规则

```
GET    /{group}/-/git-group-settings/branch-protections        → api.BranchProtection[]
POST   /{group}/-/git-group-settings/branch-protections        → 200
PATCH  /{group}/-/git-group-settings/branch-protections/{id}   → 200
DELETE /{group}/-/git-group-settings/branch-protections/{id}   → 200
```
`api.BranchProtection` 字段（**22 个**：`id` + `rule` + 21 个可写配置项，初稿误写 26）：`id`（只读）、`rule`（规则名，支持通配符）、
9 个 `allow_*` 布尔、`required_approved_review_count`(1~5)、`required_approved_review_ratio`(1~100)、
其余 `required_*` 布尔。组织最多 10 条规则（POST 超限会 422，需给出可读提示）。
`id` 在 PATCH/DELETE 时走路径段并 `encodeURIComponent`。

## 3. 页面结构

`src/pages/group.vue` 改为**页签容器**（沿用仓库页的 `?tab=` 约定，`switchTab` 必须清旧下钻键）：

| tab 值 | 内容 | 组件 |
|---|---|---|
| `overview`（默认，URL 不带 tab） | 概览卡 + 用量 + 仓库墙 + 子组织网格 + 「新建子组织」入口 | 现有区块保持在 group.vue |
| `settings` | 组织信息 / 安全设置 / 危险区 | `components/org/OrgSettingsTab.vue`（新） |
| `protections` | 保护分支规则表格 + 新建/编辑/删除 | `components/org/OrgProtectionsTab.vue`（新，已存在占位文件） |

`group.vue` 额外职责：右上角加「新建子组织」按钮（打开 `CreateGroupModal`，path 预填 `{当前组织}/`）。

`src/pages/members.vue` 增量（成员页签内）：
- 工具栏加「添加成员」按钮（弹窗：username + 角色）→ `POST`；
- 成员行的角色改为可下拉修改（仅 `canManage` 时）→ `PUT`；
- 行操作加「移除」→ `ConfirmDialog` + `typeToConfirm` → `DELETE`；
- 「批量加载权限」改为调用批量端点（一次请求），失败再逐人降级。

`src/components/GroupsMenu.vue`：`Create group` 由「外跳 cnb.cool」改为站内弹窗（同一
`CreateGroupModal`，path 不预填）。

## 4. 数据层契约

### 4.1 新文件 `src/composables/useCnbOrgSettings.ts`

```ts
export interface OrgSettings {                       // 归一化后的安全设置
  hideMembers: boolean
  hideSubGroups: boolean
  showPrivateRepoWatermark: boolean
  groupProtection: boolean
  emailVerification: string[]
  npcPriceLimit: number                              // 毫元/百万 token，0 = 不限
  visitorNpcPriceLimit: number
  values: string[]                                   // 已拆分的 SettingValue 枚举
  canShowMembers: boolean                            // 上级限制位
  canShowSubGroups: boolean
  canShowWatermark: boolean
  rootGroupProtection: boolean
  rootNpcPriceLimit: number
}

export function normalizeOrgSettings(raw: unknown): OrgSettings
export function buildGroupSettingBody(input: OrgSettings): Record<string, unknown>
export async function fetchOrgSettings(slug: string): Promise<OrgSettings>
export async function saveOrgSettings(slug: string, input: OrgSettings): Promise<void>

export interface OrgProfilePatch {                    // 只提交用户填写过的键
  description?: string, site?: string, email?: string, domain?: string,
  remark?: string, wechatMp?: string, readmeRepoPath?: string,
}
export async function updateOrgProfile(slug: string, patch: OrgProfilePatch): Promise<void>

export interface CreateGroupInput { path: string, description?: string, remark?: string, bindDomain?: string }
export async function createGroup(input: CreateGroupInput): Promise<void>
export async function transferGroup(slug: string, target: string): Promise<void>
```

### 4.2 新文件 `src/composables/useCnbBranchProtections.ts`

```ts
export interface BranchProtectionRule { /* 26 字段的 camelCase 镜像 + id */ }
export function normalizeBranchProtection(raw: unknown): BranchProtectionRule
export async function fetchBranchProtections(slug: string): Promise<BranchProtectionRule[]>
export async function createBranchProtection(slug: string, rule: BranchProtectionRule): Promise<void>
export async function updateBranchProtection(slug: string, id: string, rule: BranchProtectionRule): Promise<void>
export async function deleteBranchProtection(slug: string, id: string): Promise<void>
export const BRANCH_PROTECTION_LIMIT = 10
```

### 4.3 `useCnbMembers.ts` 追加

```ts
export const MEMBER_ROLES = ['Guest', 'Reporter', 'Developer', 'Master', 'Owner'] as const
export type MemberRole = typeof MEMBER_ROLES[number]

export async function addGroupMember(group: string, username: string, role: MemberRole): Promise<void>
export async function updateGroupMemberRole(group: string, username: string, role: MemberRole): Promise<void>
export async function removeGroupMember(group: string, username: string): Promise<void>
export async function fetchGroupMembersAccessLevel(group: string, includeInherit: boolean): Promise<Map<string, string>>
export async function updateOutsideCollaborator(repoPath: string, username: string, role: string): Promise<void>
export async function removeOutsideCollaborator(repoPath: string, username: string): Promise<void>
```

### 4.4 公共基础设施（已由主理人完成，勿重复实现）

`useCnbAuth.ts` 已新增：

```ts
export async function cnbFetchVoid(path: string, options?: RequestInit): Promise<void>
```
**所有返回空 body 的写端点（本节 2.1/2.2/2.4/2.5/2.7/2.8 的写操作）必须用它**，不要用
`cnbFetch` —— 后者会 `response.json()` 在空 body 上抛 "Unexpected end of JSON input"，把成功当失败。
（`POST /groups` 返回 201，可继续用 `cnbFetch`，body 也按需忽略。）

## 5. i18n 约定（避免并行冲突）

三个语种文件里已放好**占位标记**，各自替换**自己那一个标记行**，不要动别人的：

| 标记 | 归属 |
|---|---|
| `// @@I18N:orgSettings@@` | 组织设置任务（`org.orgSettings` 子树） |
| `// @@I18N:protections@@` | 保护分支任务（`org.protections` 子树） |
| `// @@I18N:memberWrite@@` | 成员写操作任务（`members.write` 子树） |

要求：一次替换为**完整的 `键: { ... },` 子树**（含尾部逗号），三语（zh-CN / en / zh-TW）**键集合完全一致**
（`src/locales/__tests__/locales.test.ts` 会红）。标记行本身必须删掉。

### 5.1 消息语法陷阱（实测踩到，务必遵守）

vue-i18n 的 message 会把 `@` 当 linked message 起始符（`@:key`），`|` 当复数分隔符，`{` `}` 当插值。
因此文案里出现**字面量的 `@`**（如邮箱占位符 `name@example.com`、文案「仅仓库成员可 @NPC」）会在
**渲染时**抛 `Invalid linked format`，整句退化成 key 字面量 —— 而 typecheck / 键一致性 / 构建全都不报错。

写法约定：字面量 `@` 一律用插值转义 `{'@'}`，或换词（「提及 NPC」）。
已加常驻用例：`locales.test.ts` 的「locale 消息可编译」会把三语全部消息逐条编译并捕获告警/异常，
新增文案后无需额外操作，跑 `pnpm test` 即自动把关。

## 6. 红线

1. **403 绝不登出**（只有 401 登出）；写操作 403 → 页面内 toast/内联错误 + `missingScope` 提示 + 管理令牌外跳。
2. 写入口按 `canManageRole(selectedGroup.access_role)` **事前隐藏**，不做事后报错。
3. 所有请求走 `cnbFetch` / `cnbFetchVoid`，禁止原生 fetch（TLS 指纹 + CORS 双坑）。
4. 破坏性操作必须有 `ConfirmDialog`；高风险（移除成员、转移组织）必须 `typeToConfirm`。
5. 组件内不写 `console.log`；不新增依赖。
6. 不 commit / 不 push。

## 7. 验收清单

- [ ] `group.vue` 三个页签可切换，`?tab=` 深链可分享，切页签清旧 query
- [ ] 组织信息可保存，未填写的字段不出现在请求体（用 devtools/单测证明）
- [ ] 33 个 SettingValue 开关能读写往返；上级限制位为 false 时开关 disabled
- [ ] 保护分支：非根组织不发请求，显示引导；根组织可增删改查；第 11 条给出可读错误
- [ ] 成员：添加/改角色/移除三条链路可用，移除需输入用户名
- [ ] 批量权限一次请求填充全部行，失败降级为逐人加载
- [ ] 外部贡献者可改角色（三档）/移除
- [ ] 创建组织成功后侧边栏刷新并选中新组织
- [ ] `pnpm test` / `typecheck` / `lint` / `build` 全绿，三语键一致
