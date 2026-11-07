# P2 工单汇总（不排期 · 不进本次交付）

> 本文件收 3 项互相独立的 P2（明细见下，三项互不依赖、可分别排期与验收）。

> **文档类型**：工单规格，**不是 PRD**。纯值改动、无键名/结构变更、不涉及产品取舍、无需竞品分析，走 PRD 流程过重。
> **状态**：已批准立项，**不排期**，不进「Group 术语统一」本次交付（避免污染该 PR 的单一主题验收边界）。
> **立项依据**：`menu.theme` / `menu.light` / `menu.dark` / `menu.language` 在 zh-CN 与 zh-TW 两个语言包中**仍为英文原文**，中文用户在用户菜单里看到的是 `Theme / Light / Dark / Language`。经核对属本次改造**之前**就存在的 i18n 缺口，非「Group 术语统一」引入。

> **本文件现容纳 3 项互相独立的 P2**（同属"不排期、不进本次交付"，故合并登记，避免碎片化）：
> - **T1**：`menu.*` 中文未汉化 —— §1–§6（本文主体）
> - **T2**：dev HMR 后 dashboard 布局丢失 —— §7.1
> - **T3**：`<html lang>` 初值不同步 —— §7.2
> 三项**互不依赖**，可分别排期、分别验收。下文 §1–§6 仍以 **T1** 为主体。

## 1. 问题与影响

| 项 | 内容 |
|---|---|
| 现象 | 中文界面下，头像菜单（UserMenu）出现英文：主题分组标题 `Theme`、两个主题项 `Light` / `Dark`、语言分组标题 `Language` |
| 位置 | `src/components/UserMenu.vue` —— `t('menu.theme')`（L149）、`t('menu.light')`（L152）、`t('menu.dark')`（L162）、`t('menu.language')`（L177） |
| 影响面 | 全部中文用户（zh-CN + zh-TW）；英文用户无感 |
| 严重度 | P2（可用性无损，属本地化完整性缺陷；但出现在高频入口，感知明显） |
| 根因 | 4 个键在中文包里直接抄了英文值（`theme: 'Theme'` 等），非回退导致（`fallbackLocale: 'en'` 不是原因，值本身就是英文） |

## 2. 改动范围（8 个值，4 键 × 2 语）

**en 不动**（`en.ts:83-86` 已是正确英文）。zh-CN / zh-TW 各改 4 行，**只改值，不改键名、不改结构、不动缩进**。

| 键 | en（基准，不改） | zh-CN 现值 → 目标值 | zh-TW 现值 → 目标值 |
|---|---|---|---|
| `menu.theme` | `Theme` | `Theme` → **`主题`** | `Theme` → **`主題`** |
| `menu.light` | `Light` | `Light` → **`浅色`** | `Light` → **`淺色`** |
| `menu.dark` | `Dark` | `Dark` → **`深色`** | `Dark` → **`深色`** |
| `menu.language` | `Language` | `Language` → **`语言`** | `Language` → **`語言`** |

**精确落点**：
- `src/locales/zh-CN.ts:81-84`
- `src/locales/zh-TW.ts:81-84`

**译法来源（复用既有文案，不新造词）**——这是本工单的核心口径，目的是让"同一英文值在不同键下译文唯一"：

| 目标值 | 复用自 | 说明 |
|---|---|---|
| `浅色` / `淺色` | `settings.appearance.light`（`zh-CN.ts:497` / `zh-TW.ts:472`） | 设置页外观卡已是此译法，用户菜单必须一致 |
| `深色` / `深色` | `settings.appearance.dark`（`zh-CN.ts:498` / `zh-TW.ts:473`） | 同上 |
| `语言` / `語言` | `layout.language`（`zh-CN.ts:246` / `zh-TW.ts:244`）、`settings.language.title`（`zh-CN.ts:501` / `zh-TW.ts:476`） | 侧边栏与设置页均已用此译法 |
| `主题` / `主題` | 新造（无既有同名标签） | `settings.appearance.title` 是「外观/外觀」（卡片标题），不宜复用；`settings.appearance.desc` 正文已用「界面主题/介面主題」，取「主题/主題」与其一致 |

> 注意：`menu.systemLanguage` 已是「系统语言/系統語言」，与本工单的 `menu.language`（「语言/語言」）语义不同（一个是"跟随系统语言"选项，一个是分组标题），**不要合并或改名**。

## 3. 明确不做（边界）

1. **不改键名、不合并键**：`menu.*` 4 个键名保持原样，不改名、不迁命名空间（与 Group 术语改造无关）。
2. **不改结构**：键数不变，三语仍各 **416** 叶子键。
3. **不含 `Feedback`**：`layout.feedback`「使用反馈」vs `settings.about.feedback`「问题反馈」两处用词不同，但**上下文不同**（侧边栏入口 vs 关于页反馈动作），产品判定**不改**，不纳入本工单。
4. **不顺手改其它同英文多译法项**：`Pending`（评审待评审 / 构建排队中 / 阶段等待中）三处语义本就不同，属**合理差异**，任何"同英文同译"检查都必须豁免，禁止在本工单里"统一"。
5. **不动英文包**、**不动任何组件代码**、**不动 API / 路由 / 存储键**、**不新增依赖**。

## 4. 验收断言

**必须用键级断言，不要用 grep 数短词**：`Light` / `Dark` 这类短词用 grep 会撞上其它内容（如 `highlight`、`darker`、`Light` 出现在注释里），命中数不可靠。推荐与本项目 B2b 同款 `vm` 加载方式（能取到真实对象，不受正则解析边界影响）。

```bash
# A. 键级断言（8 条值断言 + 8 条冗余检查「是否仍等于英文」）：期望输出 OK / exit 0
node -e '
const fs=require("fs"),vm=require("vm");
const load=p=>{let s=fs.readFileSync(p,"utf8").replace(/export\s+default/,"module.exports =");
  const sb={module:{exports:{}}};vm.createContext(sb);vm.runInContext(s,sb);
  return sb.module.exports.default ?? sb.module.exports};
const flat=(o,p="",r={})=>{for(const[k,v]of Object.entries(o)){const q=p?p+"."+k:k;
  if(v&&typeof v==="object"&&!Array.isArray(v))flat(v,q,r);else r[q]=v}return r};
const cn=flat(load("src/locales/zh-CN.ts")), tw=flat(load("src/locales/zh-TW.ts")), en=flat(load("src/locales/en.ts"));
const must={
  "menu.theme":   ["主题","主題"],
  "menu.light":   ["浅色","淺色"],
  "menu.dark":    ["深色","深色"],
  "menu.language":["语言","語言"],
};
let bad=0;
for(const[k,[c,t]]of Object.entries(must)){
  if(cn[k]!==c){console.log(`FAIL zh-CN ${k}: ${cn[k]} ≠ ${c}`);bad++}
  if(tw[k]!==t){console.log(`FAIL zh-TW ${k}: ${tw[k]} ≠ ${t}`);bad++}
  if(cn[k]===en[k]){console.log(`FAIL zh-CN ${k} 仍等于英文值 ${en[k]}`);bad++}
  if(tw[k]===en[k]){console.log(`FAIL zh-TW ${k} 仍等于英文值 ${en[k]}`);bad++}
}
console.log(bad?`FAILED: ${bad} 处`:"OK: menu.* 中文已完成汉化且与既有译法一致");
process.exit(bad?1:0)'
```

> **脚本已实测可用（红灯基线）**：在当前未修复代码上运行，输出 `FAILED: 16` / `exit 1`——即 4 键 × 2 语 × 2 检查（值不符 + 仍等于英文）。修复后应为 `OK` / `exit 0`。这也证明脚本能真正抓住缺陷，不是"恒绿"脚本。
> **部分修复时的读数含义（别误判脚本坏了）**：报出条数 = `未汉化键数 × 2 语 × 2 检查`。全未修 = `4×2×2 = 16`；已修 1 键 = `12`；已修 3 键 = `4`；全绿才是 `OK`。所以看到 `FAILED: 4` 是"还剩 1 键未汉化"，**不是脚本异常**；只有出现 `TypeError` / 无任何输出才算脚本问题。

```bash
# B. 一致性断言（4 条）：同英文值必须与既有键同译
# 期望：全部相等
#   zh-CN: menu.light === settings.appearance.light（浅色）
#   zh-CN: menu.dark  === settings.appearance.dark（深色）
#   zh-TW: menu.light === settings.appearance.light（淺色）
#   zh-TW: menu.dark  === settings.appearance.dark（深色）
#   zh-CN: menu.language === layout.language（语言）
#   zh-TW: menu.language === layout.language（語言）
# 同上脚本内追加比较即可，不加新工具。
```

```bash
# C. 键集不变：三语各 416 叶子键，missing=[] extra=[]
# 期望输出：en=416 / zh-CN=416 / zh-TW=416
```

```bash
# D. 结构面断言：键名/命名空间不得变动（原「git diff 面断言」已作废，原因见下）
```

> ⚠️ **原 D 判据（`git diff --stat` 期望「2 files changed, 8 insertions」）作废 —— 在本仓库不可执行。**
> 实测：`src/locales/zh-CN.ts`、`src/locales/zh-TW.ts` 均为 **UNTRACKED**（`git ls-files --error-unmatch` 无输出，`git status` 显示 `??`）。`git diff --stat` 对未跟踪文件**输出空**，永远得不到「8 insertions」。根因：本仓库 `HEAD` 是上游模板提交，项目绝大部分文件从未入库，**任何基于 `git diff` 的"只改了 X 行"判据在本仓库恒为空**。
> 替代方案：用**结构化内容断言**（node，工具无关），锁定"命名空间与键名不变"，再叠加 A/B/C 的值与键集断言，共同覆盖 D 原本想表达的"只改值不改结构"。

```bash
# D（替代）：结构锁定 —— 顶层命名空间清单 + menu.* 键名清单 + 三语一致
node -e '
const fs=require("fs"),vm=require("vm");
const load=p=>{const s=fs.readFileSync(p,"utf8").replace(/^\s*export\s+default/m,"module.exports =");
  const sb={module:{exports:{}},exports:{}};vm.runInNewContext(s,sb,{filename:p});
  return sb.module.exports.default ?? sb.module.exports};
const flat=(o,p="",r={})=>{for(const[k,v]of Object.entries(o)){const q=p?p+"."+k:k;
  if(v&&typeof v==="object"&&!Array.isArray(v))flat(v,q,r);else r[q]=v}return r};
const L={};for(const l of ["en","zh-CN","zh-TW"])L[l]=load(`src/locales/${l}.ts`);
const F={};for(const l in L)F[l]=flat(L[l]);
let bad=0;
// D1 顶层命名空间清单锁定（17 个，改前=改后）
const NS="common,state,login,auth,menu,groups,home,notifications,buildWatch,profile,layout,repo,issues,pulls,builds,members,settings";
const ns=Object.keys(L.en).join(",");
if(ns!==NS){console.log(`FAIL 顶层命名空间变动:\n  期望 ${NS}\n  实际 ${ns}`);bad++}
// D2 menu.* 键名清单锁定（12 个，防改名/误删/误加）
const MK="myProfile,profile,settings,theme,light,dark,language,systemLanguage,logout,loggedOut,loggedOutDesc,notLoggedIn";
const mk=Object.keys(F.en).filter(k=>k.startsWith("menu.")).map(k=>k.slice(5)).join(",");
if(mk!==MK){console.log(`FAIL menu.* 键名变动:\n  期望 ${MK}\n  实际 ${mk}`);bad++}
// D3 三语 menu 键集合一致（防只改一两个语种）
for(const l of ["zh-CN","zh-TW"]){
  const s=Object.keys(F[l]).filter(k=>k.startsWith("menu.")).map(k=>k.slice(5)).join(",");
  if(s!==mk){console.log(`FAIL ${l} 的 menu 键集合与 en 不一致`);bad++}
}
console.log(bad?`FAILED: ${bad} 处`:"OK: 结构未变（17 命名空间 + menu 12 键，三语一致）");
process.exit(bad?1:0)'
```
> 该脚本在**修复前**即应为 `OK`（它只锁结构、不锁值），与 A 的 `FAILED: 16` 形成互补：**A 红 + D 绿 = "确实只缺汉化、结构没坏"**。若 A/D 同时红，说明改到了键名或命名空间，属超出本工单范围。
> **为什么不用 `grep` 写 D**：本机 `grep` 存在两个版本（Agent 沙箱 toybox 0.8.13 / 普通终端 `/usr/bin/grep` GNU compatible），`\s` `\b` `\|` 等扩展在 toybox 下**静默失效**且与"无命中"同形。故本工单的判定一律走 node 脚本。

**功能回归（手动，2 条）**

| # | 场景 | 期望 |
|---|---|---|
| R1 | zh-CN 下打开头像菜单 → 主题子菜单 | 显示「主题」「浅色」「深色」；切换浅/深色生效且勾选态正确 |
| R2 | zh-TW 下打开头像菜单 → 主题子菜单、语言子菜单 | 显示「主題」「淺色」「深色」「語言」；语言切换仍能热切换三语 |

## 5. 读数纪律（必须遵守，本次已踩过两次）

1. **判据锚定输出文本**（`OK: menu.* 中文已完成汉化...`），**不要只看退出码**：脚本崩溃的退出码同样非 0，与"断言失败"无法区分。
2. **不要用管道包住被测命令再取 `$?`**：`node x.js | tail -3; echo $?` 取到的是 `tail` 的退出码，会把失败读成通过。要留日志用重定向：`node x.js > out.log 2>&1; echo $?`。
3. **不要手改 `components.d.ts` / `src/route-map.d.ts`**：这两个是生成物，只能靠 `pnpm dev` / `pnpm build` 重建。另外实测过并发写坏案例：`dev` 与 `build` 两个 vite 进程同时写 `components.d.ts` 会产生尾部重复拼接的残片（`TS1128`），**跑手动回归前确认没有并发的 build/typecheck**。
4. **不要用 `grep` 做判定**（本工单的 A/B/C/D 已全部改为 node 脚本，此条为通用纪律）：本机存在**两个** `grep`，取决于 `PATH` —— Agent/CLI 沙箱解析到 **toybox 0.8.13**（`--version` 自报"is not GNU grep 9.0"），普通终端解析到 `/usr/bin/grep`（**BSD grep 2.6.0-FreeBSD，GNU compatible**）。toybox 对 `\s` / `\b` / `\d` / `\w` / BRE `\|` **静默降级为"无匹配"**，与"真的没有残留"输出完全同形。需要按模式找东西时用 `grep -E` + POSIX 字符类（`[[:space:]]`）+ `grep -w` / `-F`，且读数前先 `command -v grep` 自证。
5. **不要用 `git diff` 判断改动面**：本仓库 `HEAD` 是上游模板提交，项目绝大部分文件（含 `src/locales/*.ts`）**从未入库**，`git diff` 对它们恒为空 —— 详见 §4 D 的作废说明。

## 6. 完成定义（DoD）

- [ ] 8 个值按 §2 表格改完，键名/结构/缩进未变
- [ ] A / B / C / D 四组断言全绿，且以**输出文本**为准（不看退出码）
- [ ] `pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm build` 全绿
- [ ] R1 / R2 手动回归通过（需 GUI）
- [ ] ~~`git diff --stat` 仅 2 文件 8 行值改动~~ **作废**：两文件均 UNTRACKED，`git diff` 恒为空 → 改由 **D 组结构断言**覆盖（见 §4 D）
- [ ] 提交时按路径逐个 `git add src/locales/zh-CN.ts src/locales/zh-TW.ts`（这两个文件当前**未入库**，是新增文件而非"修改"，`git status` 显示 `??`；**禁用 `git add -A`**）

---

## 7. 同批次登记的其他 P2（与 T1 无关，各自独立）

### 7.1 T2：dev HMR 后 dashboard 布局丢失

| 项 | 内容 |
|---|---|
| 现象 | dev 下修改/重命名 `src/pages/**` 任意文件触发热更新后，页面**布局层消失**（侧边栏、面板框架不见，只剩内容裸渲染），整页刷新才恢复 |
| 影响面 | **仅 dev**。生产构建无 HMR，不受影响；不影响打包产物、不影响用户 |
| 严重度 | P2（开发体验；但极易被误判为"改坏了"，本次改造期间已误导过至少一次复验） |
| 根因 | `vue-router/auto-routes` 的 `handleHotUpdate` 内部先 `router.clearRoutes()`，再重放**原始生成路由**——重放时**未套 `setupLayouts()`**，而 `main.ts` 建表时是 `setupLayouts(routes)`。重放后路由存在但 layout 包装丢失 |
| 代码位置 | `src/main.ts:176-182`（`if (import.meta.hot) { handleHotUpdate(router, cb) }`）；`cb` 目前只补挂 `legacy-org`，未恢复 layout 包装 |
| 现状认定 | **既有缺陷，与 Group 术语改造无关**。`main.ts:174-175` 的注释已如实记录（"属既有缺陷"），PRD §7.5 也据此要求"改 `src/pages/**` 后必须整页刷新再验证" |
| 修点建议 | 在 `handleHotUpdate` 的第 2 个参数（重放后回调）里，对重放后的路由重新 `setupLayouts()` 再 `addRoute`；与现有"幂等补挂 `legacy-org`"合并为一次重建 |
| 验收 | dev 下改 `src/pages/**` 任一文件 → 布局仍在、`/org` 仍可重定向、无需整页刷新 |
| 不做的部分 | 不改生产路由装配；不为它动 `appRoutes` 结构（避免把测试耦合到装配细节） |

### 7.2 T3：`<html lang>` 初值不同步（仅在用户主动切换语言后才更新）

| 项 | 内容 |
|---|---|
| 现象 | 冷启动后 `<html lang>` **恒为 `en`**（`index.html:2` 的静态值），即使当前生效语言是中文；用户**手动切换一次语言后**才被写对 |
| 影响面 | 全部非英文用户的首屏；不影响界面文案（文案由 vue-i18n 渲染，正确），影响**无障碍朗读、字体渲染策略、浏览器翻译提示、CSS `:lang()` 选择器** |
| 严重度 | P2（无功能阻断，属语义/可访问性缺陷；不易被用户主动感知，但会影响朗读与字体回退） |
| 根因 | `src/main.ts:63-73`：初始化时只写 `i18n.global.locale.value = resolvedLocale.value`，**未同步 `document.documentElement.lang`**；`setAttribute('lang', loc)` 只在 `watch(resolvedLocale, …)` 的回调里执行，而该 `watch` **未设 `immediate: true`** → 首次不触发 |
| 实测证据 | `src/main.ts:72` 存在 `document.documentElement.setAttribute('lang', loc)`；但该行位于 watcher 回调内。另有第二个 `watch(localePref, …)` 只写 i18n locale、**不写 lang** |
| 修点建议 | ① 给 `watch(resolvedLocale, …)` 加 `{ immediate: true }`；或 ② 抽 `syncHtmlLang(loc)` 函数，初始化时显式调一次、watcher 内复用（推荐 ②，避免依赖 watcher 时序） |
| 验收 | 冷启动（系统语言为中文）→ `<html lang>` 为 `zh-CN`；DevTools 改 `localePref` 为 `zh-TW` → 变为 `zh-TW`；切回 `en` → `en` |
| 附带待确认 | `lang` 是否应写**完整 BCP-47 标签**（`zh-CN` / `zh-TW`）还是主语言（`zh`）。当前 `resolvedLocale` 是 `zh-CN`/`zh-TW` 粒度，直接用即可，但若将来引入 `zh-Hans` 需复查 |

> **本轮不做**：T2/T3 均为登记，**不含任何代码改动**，不进「Group 术语统一」PR（该 PR 需保持单一主题验收边界）。
> **与本次改造的关系**：T2 是本次复验期间被踩到的**干扰项**（曾导致"布局丢失=改造改坏了"的误判），T3 是核对 `<html lang>` 时顺带发现的**相邻缺陷**，两者均**先于**本次改造存在。
