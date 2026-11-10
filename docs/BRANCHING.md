# WOCNB 分支与发布规范

> 面向人的可执行规范。配套文件：
> - 流水线实现：[`.cnb.yml`](../.cnb.yml)
> - 设计与取舍依据：[`docs/design/cnb-pipeline-design.md`](design/cnb-pipeline-design.md)
> - 打包 / 上传脚本：[`scripts/ci/`](../scripts/ci)
>
> 一句话概括：**开发一律走短生命周期分支 + PR；主干只接受压缩合并；只有推 `v*` tag 才发版。**

---

## 1. 分支模型（速查表）

| 分支类型 | 命名规则 | 从哪个分支切出 | 合并到哪 | 生命周期 | 是否保护 | 命中的流水线（`.cnb.yml` 的 key） |
| --- | --- | --- | --- | --- | --- | --- |
| 主干 | `main` | — | — | 永久 | **强保护** | `main: push`（合并后校验）+ `main: pull_request` / `$: pull_request`（PR 校验，同一份流水线） |
| 功能 | `feat/<slug>` 或 `feature/<slug>` | `main` | `main`（PR，Squash） | ≤ 7 天，合并即删 | 否 | `$: push` |
| 修复 | `fix/<slug>` | `main` | `main`（PR，Squash） | ≤ 7 天，合并即删 | 否 | `$: push` |
| 紧急修复 | `hotfix/<slug>` | `main`（或出问题的 tag） | `main`（PR）→ 再打 patch tag | ≤ 2 天，合并即删 | 否 | `$: push` |
| 杂务 / 重构 / 文档 / 测试 / CI | `chore/`、`refactor/`、`docs/`、`test/`、`ci/` + `/<slug>` | `main` | `main`（PR） | ≤ 7 天，合并即删 | 否 | `$: push` |
| 发布维护（可选，暂不启用） | `release/<major>.<minor>` | `main` | `main` | 视维护窗口 | 建议与 `main` 同级 | `$: push`（若启用建议单独加 `release/**` key） |

### 1.1 命名规则

- `<slug>` 用**小写 kebab-case**，描述「做什么」而不是「谁在做」：`feat/tray-menu-i18n`、`fix/build-log-scroll`。❌ `feat/张三`、`fix/修复bug`、`fix/tray_menu`。
- 分支名只允许 `[a-z0-9._-]` 与 `/`；**不要用多级斜杠**（`feat/ui/menu`），glob 的 `*` 不跨 `/`，多级需要 `**`，容易误配。`$` 兜底虽能覆盖，但仍建议一层。
- **分支名禁止以 `v` 开头**（`v2-rewrite`、`version-bump`、`verify-ci` 都不行）：`v*` 是给 tag 用的 glob 键，**对分支名同样生效**；分支名一旦命中它，该键下只有 `tag_push` 事件 → 这条分支 **push 后一条流水线都不跑**，并且因为 stage 1 已命中，`$: push` 也**不会兜底**。最坏的是它**不报错**：你以为 CI 绿了，其实是 CI 没跑。版本号只用于 tag，不用于分支。
- 一个分支只做一件事。合并后立刻删除分支（平台可在合并后自动删）。

### 1.2 为什么只有这些分支

本仓库规模小、节奏快，不需要 Git Flow 的 `develop` / `release` 长期分支。`main` 始终是可发布状态；需要发版时从 `main` 打 tag。

---

## 2. 版本与 tag 规范

### 2.1 版本号语义（SemVer）

| 形式 | 示例 | 用途 |
| --- | --- | --- |
| 正式版 | `v0.1.0`、`v1.2.3` | 对外发布 |
| 预发布 | `v0.2.0-rc.1`、`v0.2.0-beta.2` | 内测 / 候选版本 |

- `MAJOR`：不兼容变更；`MINOR`：新功能；`PATCH`：修 bug。
- **0.x 阶段（当前）**：`MINOR` 可以含不兼容变更，`PATCH` 只修 bug。
- 版本号**不带前缀 `v` 是错的**：tag 必须形如 `v1.2.3`，流水线的 `v*` 触发规则依赖这个前缀。
- 预发布版（含 `-`）在创建 Release 时自动标记为「预发布」且**不**占用 `latest` 标记，不会误导用户下载。

### 2.2 铁律：tag 必须与配置文件版本一致

**tag 去掉 `v` 必须严格等于 `src-tauri/tauri.conf.json` 的 `version`。**

原因：Tauri 以 `tauri.conf.json > version` 为产物版本（写进 `.dmg` / `.exe` 的元数据与安装目录）。tag 是 `v0.2.0` 而配置还是 `0.1.0` 时，用户装到的就是 0.1.0 —— 这种「静默错版」比构建失败危险得多。

执行方式：流水线 `release-meta` 的第 6 个 stage `version-check` 调用 [`scripts/ci/check-version.sh`](../scripts/ci/check-version.sh)，不一致直接失败，且**不会创建 Release**（坏提交不发布）。

### 2.3 打 tag 的正确姿势

```bash
# 1) 确认本地 main 是最新的、CI 已绿
git switch main && git pull --ff-only

# 2) 先在 PR 里改版本号（走一遍 CI）
#    src-tauri/tauri.conf.json  ->  "version": "0.2.0"
#    合并进 main

# 3) 打带注释的 tag 并推送（这一步才会触发发布）
git tag -a v0.2.0 -m "WOCNB v0.2.0"
git push origin v0.2.0
```

- tag **必须打在 `main` 上的提交**（hotfix 打在其 PR 合并后的 `main` 提交上）。
- **禁止** `git tag -f` 移动已发布的 tag 并强推：用户已下载的产物会对不上。
- 发布失败需要重发时：先 `git push --delete origin v0.2.0` 删远端 tag，再重新打、重新推。重发时 Release 走「更新」分支（`overlying: true`），**不会清空已上传的其它平台附件**。
- 非 `v*` 的 tag（如 `nightly-20260101`）**不会触发任何流水线**（`.cnb.yml` 刻意没有配 `$: tag_push`）。

---

## 3. 提交信息与 PR 规范

采用 [Conventional Commits](https://www.conventionalcommits.org/)：

```
feat: 托盘菜单支持三语切换
fix: 修复构建日志抽屉滚动位置丢失
chore: 升级 vite 到 8.3.4
refactor: 抽出 useCnbBuildWatch 的轮询逻辑
docs: 补充分支与发布规范
perf: 减少仓库详情页重复请求
test: 补齐时间线组件单测
ci: 门禁顺序改为 build 先于 typecheck
```

- 类型白名单：`feat` / `fix` / `chore` / `refactor` / `docs` / `perf` / `test` / `ci`。
- **PR 标题必须符合 Conventional Commits**：主干只允许 Squash 合并，PR 标题就是最终落库的 commit message，也是 changelog 的一行。
- PR 描述写清三件事：**改了什么 / 为什么改 / 怎么验证**；涉及 UI 的附截图。
- PR 必须满足：目标分支 `main`、CI `ci-pr` 绿、至少 1 位评审通过、无冲突。
- 一个 PR 只做一件事；超过 ~400 行 diff 建议拆分。

---

## 4. 每条规则落在哪里（规范 ↔ 实现对照）

| 规则 | 实现位置 |
| --- | --- |
| 任意分支 push 都跑门禁 | `.cnb.yml` → `$: push` → 流水线 `ci-branch` |
| PR 都跑门禁，作为状态检查 | `.cnb.yml` → `main: pull_request` 与 `$: pull_request`（后者是前者内容的 YAML 别名，为什么写两个见 §8）→ 流水线 `ci-pr`（状态检查名即 `ci-pr`） |
| 合并进 `main` 后再跑一遍门禁 | `.cnb.yml` → `main: push` → 流水线 `ci-main` |
| 只有 `v*` tag 才发版 | `.cnb.yml` → `v*: tag_push`（且**没有** `$: tag_push`） |
| 门禁顺序 `install → build → typecheck → lint → test` | 各流水线的 `stages`（数组 = 串行）。`build` 必须在前：`auto-imports.d.ts`、`components.d.ts` 被 `.gitignore` 忽略、干净克隆里不存在，缺了它们 `typecheck` 必报 TS2304/TS2552；`src/route-map.d.ts` 虽是生成物但**已提交跟踪**，不缺 |
| tag 与 `tauri.conf.json` 版本一致 | `release-meta` 的 `version-check` stage → `scripts/ci/check-version.sh` |
| 源码包 / Web 包 / 校验和 | `release-meta` 的 `pack` stage → `scripts/ci/pack-meta.sh`（内部调 `package-source.sh`） |
| Release 只由一条流水线创建 | `release-meta` 的 `release-create` / `release-update`（`git:release` 全仓唯一调用点） |
| 重发时不清空已上传附件 | `CNB_TAG_IS_RELEASE` 二选一：`false` → `overlying: false`（首次创建）；`true` → `overlying: true`（只更新） |
| 预发布不占 `latest` | `release-create-prerelease` / `release-update-prerelease` 两个互斥 job（按 tag 是否含 `-` 判定） |
| 安装包命名与汇聚 | `scripts/ci/collect-macos.sh`、`collect-windows.ps1`、`collect-artifacts.sh`、`release-upload.sh/.ps1` |
| 分支保护（禁止直推 / 需要 PR / 需要状态检查） | **平台设置**，不在 `.cnb.yml` 里 —— 见第 5 节 |

### 4.1 `release-meta` 的真实结构（stage 与 job 不是一回事）

`v*: tag_push` 下只有 **1 条**流水线 `release-meta`，它由 **14 个 stage** 组成（`stages` 是数组 → 严格串行）：

| # | stage | 类型 | 作用 |
| --- | --- | --- | --- |
| 1 | `install` | script | `pnpm install --frozen-lockfile`（含 corepack/pnpm 兜底） |
| 2 | `build-generate` | script | `pnpm build`：生成被忽略的两个 `.d.ts` + 产出 `dist/` |
| 3 | `typecheck` | script | `pnpm typecheck` |
| 4 | `lint` | script | `pnpm lint` |
| 5 | `test` | script | `pnpm test` |
| 6 | `version-check` | script | tag ≡ `tauri.conf.json` 的 `version`；`exports: stdout → APP_VERSION` |
| 7 | `pack` | script | 源码包 + Web 包 + `SHA256SUMS-meta.txt` |
| 8 | `changelog` | 插件 `cnbcool/changelog` | `allowFailure: true`，生成 `LATEST_CHANGELOG.md` |
| 9 | `ensure-changelog` | script | 文件缺失/为空时兜底写入，保证 `descriptionFromFile` 有文件可用 |
| 10 | `release-create` | 内置 `git:release` | 无 Release + 正式 tag（`overlying: false`） |
| 11 | `release-create-prerelease` | 内置 `git:release` | 无 Release + 预发布 tag |
| 12 | `release-update` | 内置 `git:release` | 已有 Release + 正式 tag（`overlying: true`，不删附件） |
| 13 | `release-update-prerelease` | 内置 `git:release` | 已有 Release + 预发布 tag |
| 14 | `upload-meta` | 插件 `cnbcool/attachments` | 上传 Linux 侧三个附件 |

要点：

- 第 10–13 项是 **4 个独立 stage**（每个 stage 内 1 个 job），它们用 `if` 组成 2×2 互斥矩阵（`CNB_TAG_IS_RELEASE` true/false × tag 是否含 `-`），**同一次构建只会执行其中 1 个**，另外 3 个显示为 skipped。所以「4 个」说的是 **job 分支数**，不是「会发 4 次版」。
- `git:release` 的全仓唯一调用点就在这 4 个 stage 里；其它地方（含 P2/P3）只上传附件，不碰 Release 本体。

---

## 5. 必须在平台侧手动完成的配置

`.cnb.yml` 只描述「触发后做什么」，下面这些**必须人工在页面上配**，缺一项链路就不通或保护不生效。

### 5.1 必做（否则流水线根本不会触发）

- [ ] **仓库级开关**：仓库 → 设置 → 云原生构建 → 勾选「允许自动触发」。不勾选则 push / tag 都不触发。
- [ ] **组织级开关**：根组织 → 组织设置 → 云原生构建 → 「允许事件自动触发」为开启。最终是否触发取决于「仓库开关 **且** 组织开关」。
- [ ] **合并方式**：仓库 → 设置 → 合并请求 → 只保留「允许压缩合并（Squash）」。
- [ ] **分支保护**：仓库 → 设置 → 分支保护 → 新建规则，匹配分支填 `main`，按下表勾选。
- [ ] **确认组织级分支保护是否已开启**：组织级规则一旦开启会**完全覆盖**仓库级规则，仓库侧勾选会静默失效；开启前先核对组织规则与下表一致。
- [ ] **首次推送 `.cnb.yml` 后目视确认**：推一个 `feat/*` 分支应命中 `ci-branch`，向 `main` 提 PR 应命中 `ci-pr`，合并后应命中 `ci-main`。

> CNB CLI 目前**没有**分支保护相关 API（`cnb git` / `cnb repositories` 模块均无该能力），所以只能网页配置。

### 5.2 分支保护规则（分支 `main`）建议勾选

| 选项 | 取值 | 说明 |
| --- | --- | --- |
| 需要合并请求 | **开** | 禁止本地直推 |
| 需要评审人批准 | **开** | 至少 1 人；单人维护期可临时关闭 |
| 评审通过率 > 50% | 开（随上一项） | — |
| 至少一个仓库管理员批准 | 关 | 单人协作开销过大 |
| **需要通过状态检查** | **开** | ⚠️ 这是门禁真正生效的关键：状态来自流水线 `ci-pr`，不勾则门禁只是「参考」 |
| 仅允许线性历史 | 开 | 配合 Squash |
| 仅允许自动合并 | 关 | 保留人工合并 |
| 禁止创建 / 推送 / 强制推送 / 删除保护分支 | 全开（管理员除外） | 防误删误改 |

> tag 保护：平台目前没有「Tag 保护」规则。缓解手段是约定只有维护者能打 `v*` tag，且 `version-check` 会拦住错版 tag。

---

## 6. 自托管构建节点（产出 macOS / Windows 安装包的前提）

官方构建节点只有 Linux 容器：**打 `.dmg` 需要 Xcode、打 `.exe` 需要 MSVC，官方节点两者都没有**。因此 `.cnb.yml` 里的 `release-macos`（P2）与 `release-windows`（P3）当前是**整段注释**状态 —— 这是确定性降级：推 `v*` tag 必定绿，只产出源码包 + Web 包 + Release，不产出安装包。

> ⚠️ **P2 / P3 链路未实测**：`release-macos`、`release-windows` 以及它们调用的
> `scripts/ci/collect-macos.sh`、`collect-artifacts.sh`、`collect-windows.ps1`、
> `release-upload.sh`、`release-upload.ps1`，**从未在真实的 macOS / Windows 自托管节点上执行过**，
> 只做过 YAML / bash / PowerShell 的语法级验证与沙箱假产物验证。
> 真机上的失败点（Xcode / MSVC 版本、`rustup target`、bundle 目录结构、签名公证、上传接口字段）
> 未被覆盖。启用后第一次发版，建议先做一次空跑验证，确认「节点被调度 → 能出包 → 能拿到 Release id → 附件出现在 Release 页」四步都通过，再正式发版。
>
> ⚠️ **空跑用的 tag 不能随手取**：第 6 个 stage `version-check` 要求「tag 去掉 `v` 严格等于 `src-tauri/tauri.conf.json` 的 `version`」。所以 `v0.0.0-test` 这类 tag 会在 version-check 直接失败，后面的阶段**一个都不会跑**（等于什么也没验到）。两条可行路径：
> 1. 把 conf 的 `version` 改成与测试 tag 一致（走一轮 PR），再打该 tag；
> 2. 直接在有真实发版 tag 时验证，失败就用平台构建页的「重新构建」重试 —— 重试是幂等的（Release 不存在走「创建」，已存在走「更新且不删附件」）。**不要删 tag 重打**，那会让 changelog 的版本区间基线变脏。

### 6.1 接入节点

1. 根组织 → 组织设置 → 构建节点 → **新增 Runner**（无此入口说明平台尚未对该组织开放）。
2. 填标签（`runner.tags` 是「与」关系，节点标签必须是配置的超集）：
   - Mac 机器：`mac`、`arm64`（Intel Mac 用 `mac`、`x64`）
   - Windows 机器：`windows`、`x64`
3. 点该节点行的「连接指引」，复制一键接入脚本，在目标机器上执行（脚本已注入节点唯一标识）。
4. 节点状态由「离线」变「在线」即接入成功。机器需能出网访问 CNB（注册、心跳、拉任务、传日志与制品）。

### 6.2 节点需预装的工具链（Runner 不做环境准备）

| macOS 节点 | Windows 节点 |
| --- | --- |
| Xcode Command Line Tools（`xcode-select --install`） | Visual Studio 2022 Build Tools：`C++ x64/x86 生成工具` + **`MSVC v143 C++ ARM64 生成工具`**（arm64 交叉编译必需） |
| Rust（rustup） | Rust（rustup） |
| Node 22 | Node 22 |
| pnpm 12.14（`corepack enable`） | pnpm 12.14（`corepack enable`） |
| git（Xcode CLT 自带） | git |
| python3（`release-upload.sh` 解析 JSON 用，Xcode CLT 自带） | PowerShell 5.1+（系统自带） |

### 6.3 启用 P2 / P3（⚠️ 必须先把节点接好，再解除注释）

编辑 [`.cnb.yml`](../.cnb.yml)：从文件末尾 P2 区块的「取消注释」标记行一直到文件末尾，统一去掉行首一个「# 」（说明性文字是 `# #` 双重注释，取消一层后仍算 YAML 注释，不会破坏解析）。这些行本来就是 `v*: tag_push:` 的列表项、缩进已对齐，**不需要移动位置**。

**真实行为（不要反过来做）**：

| 状态 | 解除注释后的结果 |
| --- | --- |
| 节点**已接入**且标签匹配 | `v*` tag 额外跑 `release-macos` / `release-windows`，正常出包并上传附件 ✅ |
| 节点**未接入 / 标签不匹配** | **`v*` 发布整体失败** ❌ —— `runner: {namespace: group, tags: [...]}` 找不到满足标签的节点，任务分配不到构建节点（排队到超时或直接判失败），把这次 tag 发布一起拖红 |

所以正确顺序是：**接入节点 → 确认状态「在线」→ 解除注释 → 用一次真实发版（失败可点「重新构建」重试）验证**。**不要"先解除注释、等着以后接节点"** —— 那期间每一次打 tag 都会红。

> 自托管 Runner 默认不开 Docker：`docker.image`、`docker.volumes`、`runner.cpus` 均无效；Windows 上的 stage 脚本默认走 PowerShell 而不是 bash。

### 6.4 签名与公证（当前未做，不阻塞发布）

产物未签名：macOS 用户首次打开会被 Gatekeeper 拦截（右键「打开」或 `xattr -dr com.apple.quarantine`），Windows 用户会看到 SmartScreen 警告。补签名需要的证书/密钥应配置在「仓库密钥 / 组织密钥」里，**不要**写进 `.cnb.yml`。

---

## 7. 发布操作手册（一次性走完）

```bash
# 0) 本地门禁全绿
pnpm install && pnpm build && pnpm typecheck && pnpm lint && pnpm test

# 1) 改版本号（走 PR）
#    src-tauri/tauri.conf.json: "version": "0.2.0"
git switch -c chore/bump-0.2.0
git commit -am "chore: 版本号提升到 0.2.0"
git push -u origin chore/bump-0.2.0
#    → 提 PR 到 main → ci-pr 绿 → Squash 合并

# 2) 打 tag 触发发布
git switch main && git pull --ff-only
git tag -a v0.2.0 -m "WOCNB v0.2.0"
git push origin v0.2.0
```

发布后应看到：

| 产出 | 位置 | 当前是否产出 |
| --- | --- | --- |
| `wocnb-0.2.0-source.tar.gz` | Release 附件（`release-meta` 上传） | ✅ |
| `wocnb-0.2.0-web.tar.gz` | Release 附件（`release-meta` 上传） | ✅ |
| `SHA256SUMS-meta.txt` | Release 附件 | ✅ |
| `wocnb-0.2.0-macos-{x64,arm64}.dmg` | Release 附件（`release-macos` 上传） | ❌ 需接入 Mac 节点 |
| `wocnb-0.2.0-windows-{x64,arm64}-setup.exe` | Release 附件（`release-windows` 上传） | ❌ 需接入 Windows 节点 |

用户校验下载文件的正确姿势：

```bash
# macOS / Linux
shasum -a 256 -c SHA256SUMS-meta.txt
```

---

## 8. 常见问题

**Q：为什么 `build` 排在 `typecheck` 前面？顺序看起来是反的。**
三个 `.d.ts` 都是 Vite 插件在 `build`（或 `dev`）时生成的，但**版本控制状态不同，不能一概而论**：
- `auto-imports.d.ts`、`components.d.ts`：被 `.gitignore` 忽略（`.gitignore:27-28`），**干净克隆里不存在** —— 它们缺失时 `typecheck` 会报 11 处 `TS2304/TS2552`。
- `src/route-map.d.ts`：**已提交跟踪**（`.gitignore` 里没有它），干净克隆里是有这份文件的，不需要 `build` 来生成。

所以 CI 里必须先 `build` 生成前两个，再 `typecheck`。另外这三个文件都会被 `build`/`dev` 重写，所以**不要并发跑 dev 与 build**（会产出语法损坏文件，TS1128）。

**Q：可以同时跑 `pnpm dev` 和 `pnpm build` 吗？**
不可以。`dev` 与 `build` 并发写同一批 `*.d.ts` 会产出语法损坏文件（TS1128）。CI 里也**从不**起 dev server。

**Q：`pnpm lint` 有 warning 会不会把构建搞红？**
不会，门禁只要求 0 error，且刻意没有加 `--max-warnings 0`。历史基线里 `src/pages/dev-search-repro.vue` 曾有 2 个 warning，最近一次实测未复现，两种情况都不影响门禁结果。

**Q：为什么 PR 流水线写了两个 key（`main: pull_request` 和 `$: pull_request`）？会不会跑两遍？**
不会跑两遍。官方触发规则是「glob 优先，只有 glob 未匹配才走 `$` 兜底」，两条 key 在任意匹配语义下都只会命中一条。写两个是为了兜住一个文档没写死的点：PR 事件的 key 究竟按「目标分支名」还是「目标分支名 + 事件名」匹配。如果只写 `$: pull_request`，一旦平台按「只看分支 key」匹配，指向 `main` 的 PR 会一条流水线都没有 —— 结果就是状态检查永不上报、保护分支把这个 PR 永久卡住。`$` 里那条是 `main` 里那条的 YAML 别名（`*ci-pr`），内容不会漂移。**这两条是同一份配置的双挂（YAML 锚点），任何情况下都不要合并成一条**——合并即失去对「PR 按目标分支匹配」这一种语义的兜底。

**Q：PR 只改了文档，能不能跳过流水线？**
不能，也**不要**加 `ifModify` 跳过规则：流水线被整条跳过时「状态检查」永不上报，勾了「需要通过状态检查」的保护分支会把该 PR 永久卡住。

**Q：重发同一个 tag 会不会把别的平台已上传的安装包弄丢？**
不会。`git:release` 只有 `release-meta` 一个调用点，且已存在的 Release 走 `overlying: true`（只更新字段、不动附件）；安装包由各平台流水线以「全局唯一文件名 + `overwrite: true`」直传，互不覆盖。

**Q：本地 `pnpm tauri build` 只出 `.app` 不出 `.dmg`，是不是配置坏了？**
不是。`tauri.conf.json` 的 `bundle.targets` 是 `"app"`（本地自测最快）。CI 里用 `--bundles dmg` / `--bundles nsis` 显式覆盖，不改配置文件。
