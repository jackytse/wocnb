# PRD：Team / Organization 术语统一为 Group（增量）

> 本文档只描述本次变更，不重复既有功能设计。所有条款基于 2026-10-29 对代码库的实际核对（`src/locales/*.ts`、`src/components/*`、`src/pages/*`、`src/composables/*`）。

## 0. 项目信息

- **Language**：中文（简体）
- **Programming Language / 技术栈**：Vue 3 + Vite + `@nuxt/ui` v4 + Tailwind CSS v4 + Tauri 2 + `vue-i18n` v11 + `unplugin-vue-router`（**沿用现有栈，不引入新依赖**）
- **Project Name**：`wocnb-group-terminology`
- **原始需求（用户原话）**：「应用中的 Team、Organization 统一改用 Group」
- **已确认口径（不可更改）**：
  1. 英文 UI 文案统一 `Group` / `Groups`，不得再出现 Team、Organization 作为用户可见文案；
  2. 中文（zh-CN）统一「组织」，不得出现「团队」；中文繁体（zh-TW）统一「組織」，不得出现「團隊」；
  3. 改动深度 = 文案 + 内部标识符一起重命名；
  4. 不改 CNB 官方 Swagger DTO 类型名（`OrganizationAccess`、`OrganizationUnion` 等）与 API 端点。

## 1. 背景与目标

**背景**：同一个对象（CNB 的 `/groups` 资源）在界面上有三个名字——英文的 *Team*（`teams.loading: "Loading teams..."`）与 *Organization*（`layout.org: "Organization"`、`home.reposTitle: "Organization repositories"`），中文的「团队」（`teams.createTeam: "创建团队"`）与「组织」（`layout.org: "组织"`）。用户在侧边栏点「组织」、菜单里看到「创建团队」，会怀疑这是两个不同的东西；排查时又要额外判断"团队版本的组织"与"组织"的区别。而 CNB OpenAPI 里只有 `groups`（18 个 `/groups` 相关端点，无任何 team / organization 端点），说明术语错在 UI 与代码命名层，不在服务端。

**目标**：全应用对同一对象只保留一个名字 —— 英文 **Group**，中文 **组织 / 組織**；同时让内部标识符与 API 概念对齐，且不改动任何 API 行为。

**产品目标（3 个正交目标）**

| # | 目标 | 衡量方式 |
|---|---|---|
| G1 | 术语收敛 | 用户可见文案中 Team/Organization/团队/團隊 出现次数 = 0（三语全量） |
| G2 | 代码一致 | 自有标识符中 `Org`/`Org…`/`TeamsMenu` 等前缀清零（官方 DTO 名除外） |
| G3 | 零回归 | `/org` 旧链接仍可访问；三语键集完全一致；现有功能行为不变 |

**用户故事**

1. 作为首次使用的开发者，我希望侧边栏、首页、设置页对同一对象只用一个词，这样我不会把「团队」和「组织」当成两个概念。
2. 作为中文用户，我希望界面用词与 CNB 官方中文站一致（组织），这样我对照官方文档时能一一对应。
3. 作为英文用户，我希望界面叫 Group，与我在 CNB 文档/接口里看到的 `/groups` 一致。
4. 作为长期用户，我希望升级后我保存的 `/org` 页面链接仍然可用，不要白屏或 404。
5. 作为维护者，我希望代码命名与 CNB 概念一致（`GroupsMenu` 而不是 `TeamsMenu`），这样新同学读代码不再被误导。

## 2. 术语映射表（核心）

> 全部为实际读取三个 locale 文件所得，非推测。三语当前各 **416 个叶子键**（已用脚本核对：`en=416 / zh-CN=416 / zh-TW=416`，键名集合完全一致）。
> 变更类型：**改名+改值** = key 与 value 都变；**仅改名** = key 变、value 不变；**仅改值** = key 不变、value 变。

### 2.1 `teams.*` → `groups.*`（7 键，全部改名；en 7 条值变更，中文两语各 6 条值变更）

> 本章只统计 `teams` 命名空间。zh-TW 另有 1 条值统一（`settings.general.noGroup`，见 §2.4），故 zh-TW 值改动总计 7 条。

| 旧键 → 新键 | en 旧 → 新 | zh-CN 旧 → 新 | zh-TW 旧 → 新 |
|---|---|---|---|
| `teams.loading` → `groups.loading` | `Loading teams...` → `Loading groups...` | `加载团队中…` → `加载组织中…` | `載入團隊中…` → `載入組織中…` |
| `teams.noTeam` → `groups.noGroup` | `No team selected` → `No group selected` | `未加入任何团队` → `未选中组织` ⚠️ | `未加入任何團隊` → `未選取組織` ⚠️ |
| `teams.loadFailedRetry` → `groups.loadFailedRetry` | `Failed to load teams, click to retry` → `Failed to load groups, click to retry` | `团队列表加载失败，点击重试` → `组织列表加载失败，点击重试` | `團隊列表載入失敗，點擊重試` → `組織列表載入失敗，點擊重試` |
| `teams.empty` → `groups.empty` | `You have not joined any team yet` → `You have not joined any group yet` | `还未加入任何团队` → `还未加入任何组织` | `尚未加入任何團隊` → `尚未加入任何組織` |
| `teams.createTeam` → `groups.create` | `Create team` → `Create group` | `创建团队` → `创建组织` | `建立團隊` → `建立組織` |
| `teams.manageTeams` → `groups.manage` | `Manage teams` → `Manage groups` | `管理团队` → `管理组织` | `管理團隊` → `管理組織` |
| `teams.refresh` → `groups.refresh` | `Refresh teams` → `Refresh groups` | `刷新组织`（值不变） | `重新整理組織`（值不变） |

⚠️ `noTeam → noGroup`：中文原值「未加入任何团队」与 `empty`（空态「还未加入任何团队」）语义重复，而该键实际承载的是**侧边栏按钮在无选中项时的占位**（见 `TeamsMenu.vue` `buttonLabel`）。建议改为「未选中组织 / 未選取組織」。若产品侧希望严格"只换词不改语义"，可退回「未选中任何组织」，但不得再保留"团队"字样。

### 2.2 `home.org.*` → `home.group.*`（22 键，全部改名；其中 2 键同时改值）

仅改名、值不变的 20 键（键名前缀 `home.org.` → `home.group.`）：

`members`、`allMembers`、`repos`、`missions`、`registries`、`follows`、`createdAt`、`monthlyUsage`、`noQuota`、`frozen`、`freeQuota`、`usageLoadFailedTitle`、`usageLoadFailedDesc`、`res.ci_in_sec`、`res.ci_gpu_in_sec`、`res.dev_in_sec`、`res.dev_gpu_in_sec`、`res.git_in_byte`、`res.object_in_byte`、`res.credit_in_milli`

> 说明：`home.org.usageLoadFailedDesc` 里的 `group-resource:r` 是 CNB 权限 scope 名，**保持原样**。

改名+改值的 2 键：

| 旧键 → 新键 | en 旧 → 新 | zh-CN | zh-TW |
|---|---|---|---|
| `home.org.subGroups` → `home.group.subGroups` | `Sub-organizations` → `Sub-groups` | `子组织`（不变） | `子組織`（不變） |
| `home.org.visitOrg` → `home.group.visit` | `Org homepage` → `Group homepage` | `组织主页`（不变） | `組織主頁`（不變） |

### 2.3 导航键（1 键，改名；en 同时改值，中文仅改名）

| 旧键 → 新键 | en 旧 → 新 | zh-CN | zh-TW |
|---|---|---|---|
| `layout.org` → `layout.group` | `Organization` → `Group` | `组织`（不变） | `組織`（不變） |

> 英文取单数 `Group`：该导航项打开的是**当前选中组织**的概览页（单组织），与 `Repositories`/`Members` 这类列表项不同。见「待确认问题 Q1」。

### 2.4 仅改值的键（en 共 10 键；zh-CN 无需改动；zh-TW 改 1 条 —— 见末行"值统一"）

| 键 | en 旧 → 新 | zh-CN / zh-TW |
|---|---|---|
| `home.reposTitle` | `Organization repositories` → `Group repositories` | 组织仓库 / 組織倉庫（不变） |
| `home.reposEmpty` | `No repositories in this organization` → `No repositories in this group` | 该组织下暂无仓库 / 該組織下暫無倉庫（不变） |
| `notifications.joinGroup` | `Joined an organization` → `Joined a group` | 加入了组织 / 加入了組織（不变） |
| `state.forbiddenDesc` | `Contact your organization admin, or manage your access token scopes on CNB.` → `Contact your group admin, or manage your access token scopes on CNB.` | 请联系组织管理员… / 請聯絡組織管理員…（不变） |
| `buildWatch.settings.desc` | `Periodically checks build status for the selected organization and notifies you when a build finishes.` → `...for the selected group and notifies you...` | 定时检查当前组织的构建状态…（不变） |
| `buildWatch.settings.followGroup` | `Follows all repositories of the organization selected in the sidebar ({group}).` → `Follows all repositories of the group selected in the sidebar ({group}).` | 关注侧边栏当前选中组织…（不变） |
| `settings.general.desc` | `Read-only summary of the signed-in account and current organization.` → `...and current group.` | 登录账号与当前组织的只读摘要。（不变） |
| `settings.general.group` | `Current organization` → `Current group` | 当前组织 / 目前組織（不变） |
| `settings.general.groupDesc` | `The organization currently selected in the sidebar.` → `The group currently selected in the sidebar.` | 侧边栏当前选中的组织。（不变） |
| `settings.general.noGroup` | `No organization selected` → `No group selected` | 未选中组织（不变）/ **未選中組織 → 未選取組織**（值统一，见下） |

> **口径裁决（zh-TW 同义分裂）**：`groups.noGroup`（§2.1 新定值「未選取組織」）与 `settings.general.noGroup`（原值「未選中組織」）是**同一句英文** `No group selected`，若不处理，繁中用户会看到"未選取組織"与"未選中組織"两种写法。
> **裁决：统一为「未選取組織」**，改 `settings.general.noGroup` 这一处（旧值向 §2.1 的新定稿收敛；"選取"亦与 CNB 繁中站用词一致）。**zh-CN 两处已同为「未选中组织」，不动。**
> 规则（后续新增文案延续）：**同一英文值在不同键下的 zh-TW 译文必须唯一**，不得因历史用词差异出现同义两写。

### 2.5 注释内的术语（非用户可见，但属"术语统一"范围）

| 文件:行 | 旧 | 新 |
|---|---|---|
| `src/locales/en.ts:5` | `teams 团队菜单` | `groups 组织菜单` |
| `src/locales/en.ts:127` | `// —— Org overview ——` | `// —— Group overview ——` |
| `src/components/TeamsMenu.vue:3` | `侧边栏顶部的团队（组织）菜单。` | `侧边栏顶部的组织（Group）菜单。` |
| `src/composables/useCnbAuth.ts:116` | `CNB 组织（团队）图标 URL 规则…` | `CNB 组织（group）图标 URL 规则…` |
| `src/composables/useCnbAuth.ts:525` | `获取当前用户所在的顶层组织（团队）列表。` | `获取当前用户所在的顶层组织（group）列表。` |
| `src/composables/useCnbAuth.ts:538` | `保证"侧边栏选中哪个团队、首页就展示哪个团队的仓库"` | `保证"侧边栏选中哪个组织、首页就展示哪个组织的仓库"` |
| `src/components/GroupsMenu.vue:157` | `// Manage teams 是用户维度页面…` | `// Manage groups 是用户维度页面…` **（已闭环 ✅）** |

> 上表前 6 条为侦察期登记项；**第 7 条（`GroupsMenu.vue:157`）是事后复验发现的补登项**（原侦察遗漏；同一文件的头注释 L9/L10 侦察期已登记，见 §6 P1 ⑤，已由实现修正）。注释层不产生任何用户可见文案，**不纳入门禁**（§7.1 A1 只扫 `src/locales/`），故此项为 P2、不影响验收通过。
> **状态：7 条全部已改完。** 第 7 条随本次落盘一并修正（实测 `rg -c "Manage teams" src/` → 0），故 §6 的 P2 项已关闭。保留本表是为了记录"注释属于术语范围、但不入门禁"这一口径，不代表仍有待办。
> 判定仍以 §7.1 A3 的标识符断言为准 —— 注释文字不在断言范围内，不要把它升级成门禁。

### 2.6 汇总口径

- 键改名合计：**30**（`teams` 7 + `home.org` 22 + `layout.org` 1），改名前后叶子键总数不变（**416 → 416**），三语键名集合仍完全一致。
- 值改动合计：**en 20 条 / zh-CN 6 条 / zh-TW 7 条**（zh-TW 比 zh-CN 多 1 条：`settings.general.noGroup` 的值统一，见 §2.4 裁决）。
- 中文两语在 `home.*` / `settings.*` / `state.*` / `notifications.*` 下的既有文案**基本无需改动**（现状已用「组织/組織」，唯一术语错误集中在 `teams.*` 的「团队/團隊」）；唯一例外是 zh-TW `settings.general.noGroup` 的同义统一。

## 3. 标识符重命名清单

### 3.1 文件/组件/i18n 命名空间

| 类型 | 旧 | 新 | 关联引用点（实测） |
|---|---|---|---|
| 文件 | `src/components/TeamsMenu.vue` | `src/components/GroupsMenu.vue` | `src/layouts/default.vue:141` 模板标签 `<TeamsMenu>`；`components.d.ts:41` |
| 文件 | `src/components/HomeOrgOverview.vue` | `src/components/HomeGroupOverview.vue` | `src/pages/org.vue:29` 模板标签；`components.d.ts:18` |
| 文件 | `src/pages/org.vue` | `src/pages/group.vue` | `src/route-map.d.ts:55-57,174-176`；`src/layouts/default.vue:24` |
| 模板标签 | `<TeamsMenu :collapsed="collapsed" />` | `<GroupsMenu :collapsed="collapsed" />` | `layouts/default.vue:141`（组件由 `unplugin-vue-components` 自动注册，须重新生成 `components.d.ts`） |
| 模板标签 | `<HomeOrgOverview />` | `<HomeGroupOverview />` | `pages/group.vue` |
| 面板 id | `UDashboardPanel id="org"` | **保持不变（不改 `id`）**，仅补一行中文注释说明原因 | `pages/org.vue:18`；依据见下 |
| i18n 命名空间 | `teams.*`（7 键） | `groups.*`（7 键） | `TeamsMenu.vue` 98/100/132/150/163/169/212/221 共 7 个键、8 处调用 |
| i18n 命名空间 | `home.org.*`（22 键） | `home.group.*`（22 键） | `HomeOrgOverview.vue` 67-73、118、181、200、232、251-252、279、282、285 共 16 处 |
| i18n 键 | `layout.org` | `layout.group` | `layouts/default.vue:22`、`pages/group.vue:20` |

> **`UDashboardPanel id` 为什么保留 `"org"`**（原 P1「`id="org"`→`"group"`」已作废）：`@nuxt/ui` 的 `DashboardPanel.vue:27` 会把它拼进 localStorage 键 —— `` const id = `${dashboardContext.storageKey}-panel-${props.id || useId()}` ``（`runtime/components/DashboardPanel.vue:27-28`），外层 `UDashboardGroup` 使用 `storage="local"`。把 `id` 改成 `"group"` 会让老用户已保存的面板宽度静默失效（键名从 `dashboard-panel-org` 变为 `dashboard-panel-group`）。该 `id` 不是用户可见文案，**保持 `"org"` + 补一行注释说明**即可。

### 3.2 类型 / 函数 / 常量（`src/composables/useCnbAuth.ts`）

| 类型 | 旧 | 新 | 位置 | 引用点 |
|---|---|---|---|---|
| interface | `CnbOrgUsageItem` | `CnbGroupUsageItem` | `useCnbAuth.ts:798` | `HomeGroupOverview.vue` 23/29/122/127/132/137/142（7 处） |
| const | `ORG_USAGE_KEYS` | `GROUP_USAGE_KEYS` | `useCnbAuth.ts:812` | `useCnbAuth.ts:844`（内部私有，仅 2 处） |
| async function | `fetchCnbOrgUsage` | `fetchCnbGroupUsage` | `useCnbAuth.ts:837` | `HomeGroupOverview.vue:20,44` |

### 3.3 注释中的组件名引用（约 10 处，随文件改名同步）

`TeamsMenu` → `GroupsMenu`、`HomeOrgOverview` → `HomeGroupOverview`，出现位置：`layouts/default.vue:21,29`、`pages/group.vue:5,6`、`pages/members.vue:150`、`pages/settings/index.vue:56`、`pages/repos/index.vue:5`、`composables/useCnbAuth.ts:537`、`components/HomeRepos.vue:7,61`、`components/HomeGroupOverview.vue:8,55`。

### 3.4 自动生成物（`src/route-map.d.ts` 需重新生成并提交；`components.d.ts` 只需本地重建、**不入库**）

| 文件 | 现状残留 | 处理 | 入库 |
|---|---|---|---|
| `components.d.ts`（unplugin-vue-components） | 含 `TeamsMenu`（L41）、`HomeOrgOverview`（L18） | `pnpm dev` / `pnpm build` 后自动重写为 `GroupsMenu` / `HomeGroupOverview`；另需过一遍 §7.5 健康检查 | **不入库**（`.gitignore:28`） |
| `src/route-map.d.ts`（unplugin-vue-router） | 含 `'/org'`（L55-57）与 `'src/pages/org.vue'`（L174-176） | 重新生成后应出现 `'/group'`；如保留 `/org` 重定向则不应再出现 `src/pages/org.vue` | **需提交**（tracked） |

> 两个文件都**只允许重建、禁止手改**；重建时机与 HMR 陷阱见 §7.5。区别只在入库口径：`route-map.d.ts` 是 tracked，`components.d.ts` 被 gitignore —— 因此后者的正确性**不能靠 diff 判断**，只能靠 §7.5 的三条健康检查。

### 3.5 已合规、**不要动**的标识符（避免重复劳动）

`CnbGroup`、`fetchCnbGroups`、`fetchCnbGroupRepos`、`selectedGroup`、`cnbGroupUrl`、`cnbGroupLogoUrl`、`cnbGroupManageUrl`、`CNB_GROUP_CREATE_URL`、`buildSnapshotGroup`、localStorage 键 `cnb-build-snapshot-group` —— 均已是 group 命名。

## 4. 路由变更与兼容

| 项 | 变更 |
|---|---|
| 正式路由 | `/group`（由 `src/pages/group.vue` 经 `unplugin-vue-router` 自动生成） |
| 旧路由 | `/org` **永久重定向**到 `/group` |
| 其它路由 | `/`、`/repos`、`/members`、`/settings/*`、`/profile`、`/login`、`/repos/[...repoPath]` 全部不动 |

**全量跳转点核查（`/org` 只出现 3 处）**

| 位置 | 现状 | 改法 |
|---|---|---|
| `src/layouts/default.vue:24` | 侧边栏导航项 `to: '/org'` | 改为 `to: '/group'`（label 用 `layout.group`） |
| `src/route-map.d.ts:55,174` | 自动生成的 `'/org'` 路由记录 | 重新生成 |
| `src/pages/org.vue` | 页面文件 | 改名为 `pages/group.vue` |

> **澄清（与上游侦察的差异）**：`TeamsMenu.vue` 内**没有任何站内路由跳转**——它的 4 个可点项是「切换选中组织」与两条外链（`CNB_GROUP_CREATE_URL`、`cnbGroupManageUrl`），不涉及 `/org`。侧边栏导航项在 `src/layouts/default.vue`。另 `src/main.ts` 无 `router.push('/org')`，`useDashboard.ts` 仅注册 `/` 与 `/settings` 快捷键。

**重定向实现（已定稿：方案 A）**

- 方案 A（**已拍板采用**）：在 `src/main.ts` 创建 router 时追加一条手工路由（`RouteRecordRaw` 为手写常量，不依赖任何生成物）：
  ```ts
  const appRoutes: RouteRecordRaw[] = [
    ...setupLayouts(routes as RouteRecordRaw[]),
    { name: 'legacy-org', path: '/org', redirect: '/group' },   // 旧链接永久重定向
  ]
  ```
- 方案 B（备选，未采用）：保留 `src/pages/org.vue` 作为无 UI 的跳转页，`onMounted` 调 `router.replace('/group')`。
- **命名已冻结**：路由名 `legacy-org` 与设计稿 S1–S5 批次号不再变动，本 PRD 与 `docs/design/group-terminology-design.md` 直接互引，无需再对齐措辞。
- **只做精确匹配**：`src/pages/org.vue` 是叶子页面、`src/pages/org/` 目录不存在，因此**不存在** `/org/xxx` 深链接，**不要**加 `/org/:pathMatch(.*)*` 兜底。
  > **实测后果（勿凭直觉）**：加兜底后 `/org`、`/org/anything`、`/org/x/y/z` **全部静默跳到 `/group`**（对 `/group` 无误伤）—— 即把"`/org/*` 本该 404"变成"全部落到组织页"，用户输错 URL 也察觉不到。**注意边界**：`/org/:pathMatch(.*)*` 只吃 `/org/*` 下的路径，不会让**任意乱路径**都跳组织页（那需要根级 `/:pathMatch(.*)*`，本次不涉及）；PRD 早前"任意乱路径"的说法不准确，以此处为准。
- **与登录守卫的顺序（关键）**：`vue-router` 的 redirect **在 `beforeEach` 之前**解析（`pushWithRedirect` → `handleRedirectRecord` 早于 `navigate`），所以未登录访问 `/org` 时守卫看到的目标已是 `/group`，最终落到 `/login?redirect=/group`（**不是** `redirect=/org`）；登录后按 `redirect` 参数回到 `/group`。功能目标（旧链接可达、登录后正确落页、无重定向环）完全达成。
- 语义说明：SPA 内 `redirect` 无 HTTP 状态码，"永久"体现在**旧 URL 永久可用且不改回**，不做 301。
- **HMR 注意**：`vue-router/auto-routes` 的 `handleHotUpdate` 内部会 `router.clearRoutes()` 再重放生成的原始路由，**会连带清掉这条手工 `/org` 路由**（且重放未套 `setupLayouts`，布局会丢，属既有缺陷）。凡改动 `src/pages/**` 文件名后，**必须整页刷新**（或重启 dev）再验证 `/org` 重定向，不要在热更新状态下断言失败。

## 5. 不做的事（边界）

1. **不改 CNB 官方 DTO 名**：`dto.OrganizationAccess`、`dto.OrganizationUnion` 仅出现在注释中（`useCnbAuth.ts:119,120,471,527`、`HomeGroupOverview.vue:7`），属 API 契约引用，**保留原名**。
2. **不改任何 API 端点与请求参数**：`/user/groups`、`/{slug}/-/repos`、`/{slug}/-/charge/volume|quota`、`/{group}/-/members` 等一律不动；权限 scope 字符串（如 `group-resource:r`、`repo-cnb-history:r`）不改。
3. **不新增功能**，不改 UI 布局/交互/视觉；不改通知轮询、构建快照、图片缓存等既有逻辑。
4. **不做数据迁移**：全部 localStorage 键为 `cnb-*` 前缀且与术语无关（`cnb-token`、`cnb-user`、`cnb-locale`、`cnb-auth-method`、`cnb-token-expires-at`、`cnb-build-notify-enabled`、`cnb-build-notify-interval-sec`、`cnb-build-snapshot`、`cnb-build-snapshot-group`），**无需改名或迁移**；`UDashboardPanel id="org"` **保持原值**（改 id 会改变 `dashboard-panel-org` 这一 localStorage 键，导致老用户已保存的面板宽度失效，见 §3.1 说明）。
5. **不改测试夹具**：`__tests__/useCnbRepo.buildlogs.test.ts:64` 的仓库路径字面量 `'guroads/team/sub/repo'`、`useCnbBuildWatch.*.test.ts` 的 `'orgA'`/`'org/repo'` 属测试数据，不属术语。
6. **不改历史档案**：`.workbuddy/memory/*.md` 内的 Team/团队 描述属历史记录，不改写。
7. **不改 README**：实测 `README.md` 无 Team/Organization/组织/团队 字样，无需变更。
8. **不改 Tauri 配置**：`productName`/`window.title` 均为 `WOCNB`，无术语。
9. **不引入新依赖**、不改构建配置。
10. **不恢复 `src/pages/org.vue`、不给 `/org` 加 `:pathMatch(.*)*` 兜底** —— 两条都是"看起来更保险、实际会破坏语义"的常见误改，取舍理由与长期约定见 `docs/design/group-terminology-design.md` §4.1 / §4.2（此处只指路、不重述）。

## 6. 需求池与优先级

| 优先级 | 需求 |
|---|---|
| **P0** | 三语 locale 键改名（30 键）与值修订（en 20 / zh 6 / zh 6）；`teams.*`→`groups.*`、`home.org.*`→`home.group.*`、`layout.org`→`layout.group` |
| **P0** | `TeamsMenu.vue`→`GroupsMenu.vue`、`HomeOrgOverview.vue`→`HomeGroupOverview.vue`、`pages/org.vue`→`pages/group.vue`，同步模板标签与注释引用 |
| **P0** | `src/layouts/default.vue` 导航项 `to: '/org'` → `'/group'`（label 用 `layout.group`） |
| **P0** | `/org` → `/group` 永久重定向（`main.ts` 追加 `{ name: 'legacy-org', path: '/org', redirect: '/group' }`） |
| **P0** | 类型/常量/函数改名：`CnbOrgUsageItem`、`ORG_USAGE_KEYS`、`fetchCnbOrgUsage` |
| **P0** | 重新生成 **`src/route-map.d.ts` 并提交**（tracked）；**本地重建 `components.d.ts`（gitignored，不入库、不 `git add -f`）** 并做健康检查；`pnpm typecheck` / `lint` / `test` / `build` 全绿 |
| ~~P1~~ | ~~注释术语清理~~ **已完成 ✅**：① `src/locales/en.ts:5` `teams 团队菜单`→`groups 组织菜单`；② `// —— Org overview ——`→`// —— Group overview ——`（原 L127，键改名后**现位于 L129** —— 行号会随上下文漂移，核查请按内容搜不按行号）；③ 注释内「团队」3 处（`useCnbAuth.ts:116/525/538`）；④ 组件名引用（`TeamsMenu`→`GroupsMenu`、`HomeOrgOverview`→`HomeGroupOverview`，见 §3.3）；⑤ `GroupsMenu.vue` 头注释 L9/L10 的 `Create team:`/`Manage teams:` 旧文案引用 + 函数体内 L157。逐项已核实改完（`GroupsMenu.vue:3` 同步改名）。**核验命令**：`rg -c "团队|團隊" src/` → 0；`rg -n "team|Team" src/ -g '!src/locales/**' -g '!**/__tests__/**'` → 0 |
| ~~P1~~ | ~~`UDashboardPanel id="org"`→`"group"`~~ **已作废**：保持 `id="org"`，仅补一行注释说明原因（见 §3.1） |
| ~~P2~~ | ~~英文导航项命名定调（`Group` vs `Groups`，见 Q1）~~ **已定稿 ✅：`Group` 单数**（单实体页面用 `Group`，列表/菜单等复数场景用 `Groups`；`Repositories`/`Members` 等列表项不受影响） |
| ~~P2~~ | ~~注释补漏：`src/components/GroupsMenu.vue:157` `// Manage teams` → `// Manage groups`~~ **已闭环 ✅**（随本次落盘修正，`rg -c "Manage teams" src/` → 0；该项本不入门禁，不影响验收） |

## 7. 验收标准（可测）

> **全局 grep 纪律（本节所有命令适用）**
>
> ⚠️ **本机有两个 `grep`，"哪个生效"取决于 `PATH`** —— 这是本节所有坑的总根源：
>
> | 解析结果 | 身份 | 出现在哪 |
> |---|---|---|
> | `<WorkBuddy>/cli/vendor/shim/brokered-bin/grep` | **toybox 0.8.13** | Agent/CLI 沙箱 shell（`PATH` 被 shim 前置） |
> | `/usr/bin/grep` | **BSD grep 2.6.0-FreeBSD（GNU compatible）** | 普通终端 / `PATH` 未被改写的 shell |
>
> 两者对 GNU 扩展的**支持完全不同**，且 toybox 是**静默降级**（不报错、只给"无匹配"）：
>
> | 写法 | toybox | BSD grep 2.6.0 | 结论 |
> |---|---|---|---|
> | `\s`（空白） | ❌ 当字面量字母 `s` | ✅ | 不可移植 |
> | `\b`（词边界） | ❌ 恒无匹配 | ✅ | 不可移植 |
> | `\d` / `\w` | ❌ 恒无匹配 | ✅ | 不可移植 |
> | 交替：BRE 用**反斜杠转义竖线** | ❌ 恒无匹配 | ✅ | 不可移植 |
> | 交替：`grep -E` 用**原生竖线** | ✅ | ✅ | **安全** |
> | `[[:space:]]` / `[[:alnum:]]` | ✅ | ✅ | **安全** |
> | `grep -w` / `grep -F` | ✅ | ✅ | **安全** |
>
> **因此本节命令只用 POSIX ERE + POSIX 字符类**（`grep -E`、`[[:space:]]`、`[[:alnum:]]`、`(a|b)`、`grep -w`、`grep -F`），**禁用一切 GNU 扩展**（`\s` `\b` `\d` `\w` BRE 的 `\|`）。
> **危害在于"同一份命令在不同 shell 里结论相反"**：用 GNU 扩展写的门禁，在普通终端全绿、在 Agent 沙箱静默变"无匹配"，于是**"检查通过"和"检查根本没生效"输出完全一样**。
> **读数前置动作**：任何一次"期望无输出"的判定前，先 `command -v grep` 自证工具身份（或直接 `grep --version`）；同一批断言必须在**同一个 shell**里跑完。
> 另：`grep -c` **无命中时退出码为 1**，不是 0 —— 判"期望 0"的断言时**只读输出数字、不读退出码**（详见 §7.5 末尾）。
>
> **验收记录（本节判据的工具无关性已实测）**：本节共 **14 条**断言（A1×2、A2×2、A3×2、A4×2、B2×2、§7.5×4；A4 因"文件级/全仓"两种作用域各算一条）已在 **两种 `grep`** 下各跑一遍并比对输出哈希 —— **14/14 完全一致，0 条不同**（`dto.Organization`：toybox 4/5、`/usr/bin/grep` 4/5）。原因即上表：它们只使用 POSIX ERE 与 POSIX 字符类。**这是一个结论，不是一条纪律**：任何人换环境重跑，结果应当相同。
> **⚠️ 期望值必须带作用域与匹配方式**："全仓 5"与"文件级 4"、"前缀匹配"与"全等匹配"都是不同判据。写成 `# 期望：5` 而不写作用域，下一个人可能把 `src/` 抄成某个具体文件（本轮真实发生过一次），得到"数字对、口径错"的假绿 —— **这类错误正控抓不到**（工具活着、命令跑得通），只能靠文字标注。

### 7.1 文案层断言（用户可见）

```bash
# A1 三语不再出现 Team / Organization（含大小写）
grep -rnE "team|Team" src/locales/            # 期望：无输出
grep -rnE "Organization|organization|Org " src/locales/   # 期望：无输出

# A2 中文不再出现「团队 / 團隊」
grep -rn "团队" src/locales/    # 期望：无输出
grep -rn "團隊" src/locales/    # 期望：无输出

# A3 源码内不再有术语化标识符（排除测试夹具与官方 DTO 注释）
grep -rnE "TeamsMenu|HomeOrgOverview|CnbOrgUsageItem|ORG_USAGE_KEYS|fetchCnbOrgUsage" src/ components.d.ts   # 期望：无输出
grep -rnE "home\.org|layout\.org|'teams\.|\"teams\." src/    # 期望：无输出

# A4 官方 DTO 注释白名单仍存在（证明未误改 API 契约引用）
# ⚠️ 作用域必须写进期望值：本判据是「全仓」口径，文件级不是 5
grep -c  "dto.Organization" src/composables/useCnbAuth.ts   # 期望：4（文件级）
grep -rn "dto.Organization" src/ | wc -l                    # 期望：5（全仓 = 文件级 4 + 组件 1）
# 分布：useCnbAuth.ts:119(dto.OrganizationAccess /) :120(dto.OrganizationUnion)
#       :471 :527，以及 HomeGroupOverview.vue:7（原 HomeOrgOverview.vue）
```
> `\|` 等 GNU 扩展的纪律见 §7 开头「全局 grep 纪律」，此处不重复。
> **注意 2：`\s` 不可移植，且失效方式极隐蔽。** 在 toybox grep 里 `\s` 被当成字面量字母 `s` —— `grep -cE "^\s*(//|/\*|\*)"` 只匹配"列 0 起头的注释"，**漏掉全部缩进续行**，同时还会把 `s//` 这类行算进去。最小复现：
> ```bash
> printf '  // a\n// b\ns// c\n' | grep -nE '^\s*//'          # toybox: 只命中 2、3 行（漏第 1 行）；BSD grep: 命中 1、2 行
> printf '  // a\n// b\ns// c\n' | grep -nE '^[[:space:]]*//'  # 两者一致：命中 1、2 行
> ```
> 正确写法统一用 POSIX 字符类：`grep -cE "^[[:space:]]*(//|/\*|\*)"`。**实证差异**：同一文件 `src/main.ts`，`\s` 写法在 toybox 下得 **49** 行、在 BSD grep 下得 **98** 行，而 `[[:space:]]` 写法两种环境下**都是 98** —— 这正是"同一份命令不同 shell 结论相反"的实例（98/211 = 46.4% 为真值）。
> 凡涉及"注释行数/覆盖率"这类统计，**口径与工具都对了结论才对**，**本 PRD 因此不采用任何"注释覆盖率百分比"作为判据**（只按"本次新增/修改处必须带注释"定性判定），且**引用任何绝对计数时必须附上产生它的命令**。

### 7.2 三语键集一致性

```bash
# B1 三语叶子键数一致，且仍为 416
# 建议在 PR 里附一段 20 行 node 脚本（现成脚本可复用：读取三个 locale → flat → 比较 key 集合）
# 期望输出：en=416 / zh-CN=416 / zh-TW=416；missing=[] extra=[]
```
- **必须**：`groups` 命名空间恰好 7 键（`loading / noGroup / loadFailedRetry / empty / create / manage / refresh`），`home.group` 命名空间 22 键，`layout.group` 存在，`teams` / `home.org` / `layout.org` 命名空间不存在。
- **B2 同义译文唯一性（zh-TW）**：同一句英文在不同键下译文一致。本 PRD 的硬性判据：`zh-TW` 中 **不得出现 `未選中組織`**，`groups.noGroup` 与 `settings.general.noGroup` 均须为「未選取組織」。
  ```bash
  grep -n "未選中組織" src/locales/zh-TW.ts   # 期望：无输出
  grep -c "未選取組織" src/locales/zh-TW.ts   # 期望：2（groups.noGroup + settings.general.noGroup）
  ```
  > 这说明"中文无需改动"是**近似说法**：zh-TW 实际有 1 条值统一（见 §2.4 裁决），验收时不要按"中文零改动"判定。
  > **两条命令必须分开执行**：**不要**合并成 `grep -n "未選中組織\|未選取組織"` —— macOS BSD grep 不支持 `\|`，会静默返回空（exit 1 且无输出），反而被误判为"通过"；需要或逻辑时用 `grep -E`。
  > **脚本版判据**见 `docs/design/group-terminology-design.md`：**门禁 = §4.4.1 B2b 白名单脚本**（只锁 `groups.noGroup` + `settings.general.noGroup` 两键，期望 `OK: zh-TW 同义译文一致` / 退出码 0）；§4.4.2 的术语域扫描**仅作辅助诊断，不作为 T5 门禁**。
  > 术语域口径（避免误读）：**21 个键 × 2 个中文语种 = 42 次比对**（不是"42 个键"）。域以**源语言入口**划定 —— `en` 值含 `group` 的 21 个键；**不能**改用"中文值含 组织/組織"划域，否则会漏掉 `home.group.usageLoadFailedDesc`（其 zh 值为「…令牌缺少 group-resource:r 权限」，不含"组织"二字）。
  > **脚本判据必须看输出文本，不能只看退出码**：脚本自身崩溃（如取值写法错误抛 `TypeError`）的退出码也是非 0，与"校验失败"无法区分——只判退出码会把崩溃误读成"文案不合格"，方向跑偏。
  > **判定一句话规则**：本次门禁只看 **§4.4 ⑦ 两条 grep + §4.4.1 B2b**（覆盖同一组 2 键，互为交叉验证；两者结论互斥即说明脚本崩溃或读错文件）；**§4.4.2 只报信、不裁决** —— 它报出**新的**分歧时仍判本次**通过**，需按"是否属本次术语域 + 是否同一英文语义"人工判定后，才决定是否扩白名单或登记为后续事项。
  > **禁止**做全表无条件断言：实测全表会命中 11 处，其中仅 1 处属本次，其余为既有问题（`menu.*` 未汉化、`Feedback` 上下文差异、`Pending` 三处语义不同）。

### 7.3 路由兼容

- C1：dev 下（**整页刷新**后）访问 `http://localhost:5173/org` → 最终 URL 为 `/group`，渲染组织概览页，无 404/白屏、控制台无路由警告。
- C2（按方案 A 修订）：未登录访问 `/org` → 最终落到 **`/login?redirect=/group`**（redirect 记录在 `beforeEach` 之前解析，守卫看到的目标已是 `/group`；**不是** `redirect=/org`）；登录成功后落到 `/group`，无重定向环。已登录访问 `/org` → 直接渲染 `/group`。
- C3：`src/route-map.d.ts` 中 `'/group'` 存在；`'/org'` 不应再对应 `src/pages/org.vue`；`/org` 只作为 `main.ts` 的手工路由记录存在（`router.getRoutes()` 可查到 `name: 'legacy-org'`）。**验证方式**：本项目 `main.ts` 未把 router 挂到 `window`，devtools 里无现成句柄，故以**行为验证优先**（访问 `/org` 落到 `/group` 即为通过）；如确需查路由表，临时在 dev 分支打印 `router.getRoutes().map(r => r.name)`，验证后删除，不得留在代码里。
- C4（可选自动化断言，**已按实测修订为 push 版**）：用 `createMemoryHistory` 复刻 `main.ts` 路由表后断言 **`await router.push('/org'); router.currentRoute.value.path === '/group'`**（实测 PASS）。
  > **⚠️ 不要用 `router.resolve()` 断言重定向**：实测 `router.resolve('/org').path` 仍返回 **`/org`**（`redirectedFrom` 为 `undefined`）—— `resolve()` 不解析 redirect 记录，redirect 只在 `pushWithRedirect` 内处理，**与 C2 是同一机理**。用 `resolve()` 写断言会得到"重定向失效"的假结论，后续 QA 请勿重蹈。
  > 可一并自动化的四条实测结论：① 未登录访问 `/org` → `/login` 且 `query.redirect === '/group'`；② 登录后 `replace(redirect)` → `/group`；③ `/group` 无出边（无重定向环）；④ `router.hasRoute('legacy-org') === true` 且 `getRoutes()` 含 `/org`（证明重定向记录在册）。

### 7.4 功能回归（手动）

| # | 场景 | 期望 |
|---|---|---|
| R1 | 语言=en，查看侧边栏下拉 | `Loading groups...` / `No group selected` / `Create group` / `Manage groups` / `Refresh groups` 显示正确，无裸键名 |
| R2 | 语言=zh-CN，同上看 | 加载组织中… / 未选中组织 / 创建组织 / 管理组织 / 刷新组织 |
| R3 | 语言=zh-TW，同上看 | 載入組織中… / 未選取組織 / 建立組織 / 管理組織 / 重新整理組織 |
| R4 | 切换组织 / 点刷新 | 组织页概览、仓库页、成员页、设置页「当前组织」联动正常 |
| R5 | 点「创建组织」「管理组织」 | 系统浏览器打开 `https://cnb.cool/new/groups`、`https://cnb.cool/u/{username}/groups` |
| R6 | 组织页统计与本月用量 | 数值与文案正常；无权限时错误提示正常 |
| R7 | 构建通知卡片 | `followGroup` 文案包含当前组织名；仓库计数正常 |
| R8 | 语言热切换 | 三语来回切换无残留旧文案、无控制台 i18n 报错 |

### 7.5 工程门禁

- `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build` 全部通过。
- **入库口径**：`src/route-map.d.ts` **随 PR 提交**（`git ls-files --error-unmatch src/route-map.d.ts` 有输出，是 tracked 文件）；`components.d.ts` **不入库**（`.gitignore:28` 已忽略、`git check-ignore -v components.d.ts` 可验证），因此**永远不要 `git add -f` 塞进 PR**，也**不要用 `git status` / diff 判断它是否正确**（它不进索引，坏不坏都看不见）。
- **`components.d.ts` 本地健康检查**（不入库 ≠ 不用管：写坏了 typecheck 会直接报错，且"坏"无法从 diff 看出来）：
  ```bash
  wc -l components.d.ts                      # 期望 79
  grep -c "declare module" components.d.ts   # 期望 1
  tail -3 components.d.ts                    # 期望正常闭合（} / }）
  ```
  不达标就 `pnpm build` 重建，**不要试图手工修补**。典型故障：`typecheck` 报 `components.d.ts(80,3) TS1128` —— 文件在 `declare module` 闭合后又多拼了一段残片，根因是**两个 vite 进程并发写同一文件（unplugin 无写入锁）**，不是改造没做完。配套纪律：**同一时刻只允许一个 vite 进程**（跑 `dev` 时不要同时跑 `build`/`typecheck` 的构建步骤）。
- **生成物只能"重建"，禁止手改**：两者分别由 `unplugin-vue-components` / `unplugin-vue-router` 生成（文件头已标 `Generated by …`），只能通过 `pnpm dev` 或 `pnpm build` 重建；手改会在下次启动被覆盖，且掩盖"组件名/路由名不匹配"的真实错误。
- **改名批次顺序**：文件改名（含模板标签同步）必须在同一批完成，重建放在所有文件就位之后。S3（改名）完成、S5（重建）之前，`pnpm typecheck` 报 `GroupsMenu` / `HomeGroupOverview` 未知属**预期中间态**，不要靠手改 dts 绕过。
- **HMR 陷阱**：`vue-router/auto-routes` 的 `handleHotUpdate` 会 `router.clearRoutes()` 后重放生成的原始路由，**手工 `/org` 路由会被清掉**（且重放未套 `setupLayouts`，布局丢失属既有缺陷）。因此"改 `src/pages/**` 文件名后验证路由"必须**整页刷新或重启 dev**，不得在热更新状态下判定重定向失败。
- 无新增依赖（`package.json` / `pnpm-lock.yaml` 无 diff）。
- **提交纪律（互引，不在此重述清单）**：本仓库工作区存在**大量早于本次任务的未提交改动**，`git add -A` 会把无关改动一起带入 PR。提交时按本次实际改动路径逐个 `git add`（含 `docs/` 需显式 add），**禁用 `git add -A` / `git commit -a`**；具体路径清单与豁免说明以 `docs/design/group-terminology-design.md` §4.7 R1 为准（单一来源，避免两份清单漂移）。
- **生成物判定统一用内容断言**：`components.d.ts` 与 `src/route-map.d.ts` **都不要用 diff 判断正确性** —— 后者的 tracked 基线是上游模板（`git diff` 会显示「模板路由 → 当前路由」的整片无关差异，非术语改造引入，实测 +125/−31）。`route-map.d.ts` 用以下三条（**每条都必须带文件名**；漏掉文件名会让 `grep` 去读 stdin，本地表现为"卡住不动"、CI 里表现为超时而非失败）：
  ```bash
  grep -c "'/group'"      src/route-map.d.ts   # 期望 4
  grep -c "'/org'"        src/route-map.d.ts   # 期望 0
  grep -c "pages/org.vue" src/route-map.d.ts   # 期望 0
  ```
  > **注意后两条的退出码语义**：`grep -c` **无命中时退出码为 1**（实测：上面三条连续执行最终 `exit=1`）。在 `set -e` 的脚本里，"期望 0"会被误判为失败 —— 要么写成 `grep -c "..." file || true`，要么**只判输出数字、不判退出码**（与 §7.2 "看输出文本不看退出码"同一原则）。

## 8. 待确认问题

> 状态说明：Q1–Q4 已由主理人拍板定稿，本文档不再变更（Q1 = `Group` 单数；Q2 与 zh-TW 同义收敛照准；Q3 方案 A；Q4 保留 `id="org"`）。

| # | 问题 | 状态 / 结论 |
|---|---|---|
| Q1 | 英文导航项用 `Group` 还是 `Groups`？ | **已定稿：`Group` 单数**。规则：单实体页面用 `Group`，列表/菜单等复数场景用 `Groups`；`Repositories`/`Members` 等列表项不受影响 |
| Q2 | zh-CN `groups.noGroup` 是否按建议改为「未选中组织」（原「未加入任何团队」与空态重复）？ | **已定稿：采用「未选中组织」**；**zh-TW 两处同义统一为「未選取組織」**（含 `settings.general.noGroup` 收敛，zh-TW 值改动 7 条），见 §2.4 |
| Q3 | `/org` 重定向实现方案 | **已定稿（方案 A）**：`main.ts` 追加 `{ name: 'legacy-org', path: '/org', redirect: '/group' }`；C2 断言相应修订为 `redirect=/group` |
| Q4 | `UDashboardPanel id="org"` 是否改名 | **已定稿：不改**，保持 `id="org"` + 补注释（改 id 会变更 localStorage 键 `dashboard-panel-org`，老用户面板宽度失效） |
| Q5 | 上游侦察提到的 `OrganizationDetail` 类型**在代码中不存在**（实际为 `CnbGroup`，注释称"组织详情结构，来源 Swagger dto.OrganizationAccess"）；`ORG_USAGE_KEYS` 存在。以实测为准？ | 以实测为准：只需改 `CnbOrgUsageItem` / `ORG_USAGE_KEYS` / `fetchCnbOrgUsage` 三项 |
| Q6 | `.workbuddy/memory/*.md` 中的历史 Team 描述是否同步 | 建议不改（历史档案） |
