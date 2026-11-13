<script setup lang="ts">
/**
 * 组织成员页（PRD P0-E2 / T13 增量）：成员 / 外部贡献者 / 继承成员三页签。
 *
 * 数据：GET /{group}/-/members（group-manage:r）、
 * GET /{slug}/-/outside-collaborators（repo-manage:r）、
 * GET /{group}/-/inherit-members（继承成员，按 inherit_path 分区），
 * slug 跟随侧边栏 selectedGroup 切换联动刷新。
 * query 定位：tab（members/outsiders/inherited，默认 members）/ keyword / page / repo。
 * 403 降级：StateAlert 呈现缺失 scope + 外跳管理页（不登出）。
 *
 * ⚠️ 外部贡献者是**仓库级**能力（线上缺陷复盘）：直接拿组织路径请求
 * `/{group}/-/outside-collaborators` 会被网关以
 * `400 This feature is not supported for organizations.` 拒绝。
 * 因此 outsiders 页签先加载「组织下仓库列表」让用户选定仓库（query.repo 深链），
 * 再用**完整仓库路径**请求贡献者；仓库列表为空时给出引导空态而非报错。
 *
 * 权限列按需加载（R9 防 N+1，T13 验收 4）：
 * - 列表已返回 access_level 的直接展示（零额外请求，R9 天然满足）；
 * - 列表缺失的行默认显示「—」，行内「查看权限」点击才请求
 *   GET /{group}/-/members/{username}/access-level 并缓存；
 * - 「批量加载」按钮**先**打批量端点（一次请求），失败/结构无法识别再降级逐人串行
 *   （200ms 间隔，防撞限流）；
 * - 单行 403 显示「无权限」tooltip，不阻塞成员页主体。
 *
 * 写操作（本轮增量，设计文档 §2.5 / §2.6 / §2.7）：
 * - 添加成员：POST /{group}/-/members/{username}（弹窗：username + 角色 + 外部协作者开关）；
 * - 改角色：PUT 同一端点；角色列在 `canManage` 时渲染为下拉，失败回滚显示值；
 * - 移除成员：DELETE，必须 ConfirmDialog + `typeToConfirm`（输入 username）；
 * - 外部贡献者：PUT/DELETE /{slug}/-/outside-collaborators/{username}（**仓库级**，
 *   role 走 query，仅三档）；
 * - 写入口统一按 `canManageRole(selectedGroup.access_role)` **事前隐藏**（红线 2），
 *   403 只在 toast 里提示缺失 scope，**绝不登出**（红线 1）。
 */
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { openUrl } from '@tauri-apps/plugin-opener'
import type { TabsItem } from '@nuxt/ui'
import {
  addGroupMember,
  fetchGroupMembers,
  fetchGroupMembersAccessLevel,
  fetchOutsideCollaborators,
  isOutsideCollaboratorsUnsupported,
  MEMBER_ROLES,
  OUTSIDE_COLLABORATOR_ROLES,
  removeGroupMember,
  removeOutsideCollaborator,
  updateGroupMemberRole,
  updateOutsideCollaborator,
  type MemberItem,
  type MemberRole,
  type OutsideCollaboratorRole,
} from '../composables/useCnbMembers'
import {
  fetchInheritMembers,
  fetchMemberAccessLevel,
  pickAccessLevelForSlug,
  type InheritMemberGroup,
} from '../composables/useCnbOrg'
import {
  canManageRole,
  cnbGroupUrl,
  fetchCnbGroupRepos,
  selectedGroup,
  type CnbApiError,
} from '../composables/useCnbAuth'
import { formatDateTime } from '../utils'
import StateAlert from '../components/repo/StateAlert.vue'

const { t } = useI18n()
// useToast 为 Nuxt UI 全局自动导入（见 auto-imports.d.ts）
const toast = useToast()

// 路由对象显式导入（本项目仅 Nuxt UI 组合式函数走自动导入）
const route = useRoute()
const router = useRouter()

// ---------------------------------------------------------------------------
// query 读写（tab / keyword / page，语义与仓库详情一致：tab 切换 replace）
// ---------------------------------------------------------------------------

/** 当前页签（非法值归一 members） */
const tab = computed<'members' | 'outsiders' | 'inherited'>(() => {
  const value = route.query.tab
  return value === 'outsiders' || value === 'inherited' ? value : 'members'
})

const keyword = computed(() =>
  typeof route.query.keyword === 'string' ? route.query.keyword : '',
)
const page = computed(() => {
  const n = Number(route.query.page)
  return Number.isInteger(n) && n > 0 ? n : 1
})

/**
 * query 中的仓库路径（仅 outsiders 页签使用）。
 * 形如 `组织/仓库`；空串表示「未指定，交给列表首个仓库兜底」。
 */
const queryRepo = computed(() =>
  typeof route.query.repo === 'string' ? route.query.repo : '',
)

/** 本地搜索草稿（回车写入 query） */
const keywordDraft = ref(keyword.value)
watch(keyword, value => (keywordDraft.value = value))

/** 导航：合并 query 写回（replace） */
function navigate(partial: Record<string, string | null>) {
  const query: Record<string, string> = {}
  for (const [key, value] of Object.entries(route.query)) {
    if (typeof value === 'string' && value && !(key in partial)) {
      query[key] = value
    }
  }
  for (const [key, value] of Object.entries(partial)) {
    if (value === null || value === '') {
      delete query[key]
    }
    else {
      query[key] = value
    }
  }
  void router.replace({ path: route.path, query })
}

/** 切换页签（replace，重置 keyword/page/repo） */
function switchTab(value: 'members' | 'outsiders' | 'inherited') {
  // repo 是 outsiders 专属定位键：切走后必须清掉，否则回到页签会锁死旧仓库
  navigate({ tab: value === 'members' ? null : value, keyword: null, page: null, repo: null })
}

/** 关键词回车（replace，重置页码） */
function onKeywordEnter() {
  navigate({ keyword: keywordDraft.value.trim() || null, page: null })
}

// ---------------------------------------------------------------------------
// 数据加载（跟随 selectedGroup 切换联动）
// ---------------------------------------------------------------------------

const members = ref<MemberItem[]>([])
const loading = ref(false)
const error = ref<Error | null>(null)

/**
 * 是否具备成员管理权限（Master / Owner）。
 *
 * 必须走 useCnbAuth 的 `canManageRole`（全项目唯一实现点，红线 2）：
 * 禁止在此内联 `role === 'Master' || role === 'Owner'` 之类的字符串比较副本 ——
 * 一旦服务端角色大小写口径漂移，副本会静默失配，写入口要么白露出来
 * （点下去才报错），要么对真正的管理员永久隐藏，两种都很难排查。
 * 写入口据此**事前隐藏**，而不是事后报错。
 */
const canManage = computed(() => canManageRole(selectedGroup.value?.access_role))

// ---------------------------------------------------------------------------
// 外部贡献者的仓库上下文（outsiders 页签专用）
//
// 为什么需要选仓库：CNB 的外部贡献者接口只有仓库维度，组织路径会 400
// （"This feature is not supported for organizations."）。所以页签进来先
// 拉「组织下仓库列表」，默认选首个仓库，用户可切换（写回 query.repo）。
// ---------------------------------------------------------------------------

/** 仓库下拉项（label 带完整路径，避免同名仓库无法区分） */
const repoOptions = ref<{ label: string, value: string }[]>([])
/** 仓库列表加载中（与贡献者列表的 loading 分开：下拉的占位状态不同） */
const reposLoading = ref(false)
/** 仓库列表加载失败（403 缺 group-manage:r / 网络异常），可重试 */
const repoError = ref<Error | null>(null)
/** 当前 repoOptions 属于哪个组织 —— 用于丢弃「切换组织瞬间的陈旧选项」 */
const reposGroupPath = ref('')
/** 服务端明确拒绝组织维度请求时置 true：渲染引导态，而不是红色「加载失败」 */
const outsidersUnsupported = ref(false)

/**
 * 当前生效的仓库路径（`组织/仓库`）。
 * - 仓库列表属于当前组织，且 query.repo 命中时用它（深链可分享）；
 * - 否则退回列表首个仓库（点进页签即有内容，不必先手动选一次）；
 * - 列表未就绪 / 属于上一个组织时返回空串，调用方据此跳过请求。
 */
const selectedRepo = computed(() => {
  const groupPath = selectedGroup.value?.path || ''
  if (!groupPath || reposGroupPath.value !== groupPath) {
    return ''
  }
  if (queryRepo.value && repoOptions.value.some(item => item.value === queryRepo.value)) {
    return queryRepo.value
  }
  return repoOptions.value[0]?.value || ''
})

/**
 * 加载当前组织（含子组织）的仓库列表，供外部贡献者页签的仓库选择器使用。
 * 失败不阻塞页面其他页签：仅 outsiders 页签显示错误 + 重试。
 */
async function loadRepos() {
  const slug = selectedGroup.value?.path
  if (!slug) {
    repoOptions.value = []
    reposGroupPath.value = ''
    return
  }
  // 先置 loading 再清空选项：清空会让 selectedRepo 变空并触发一次 watch，
  // 此时 loading=true 可避免重入 loadRepos（死循环防护）
  reposLoading.value = true
  repoError.value = null
  repoOptions.value = []
  try {
    // 一次取 100 个：外部贡献者排查通常集中在活跃仓库，超量场景用户可去 Web 端
    const repos = await fetchCnbGroupRepos(slug, 1, 100)
    repoOptions.value = repos
      .filter(repo => repo.path)
      .map(repo => ({
        // name 与 path 尾段一致时只显示 path，避免「wocnb（wocnb/wocnb）」的噪音
        label: repo.name && repo.name !== repo.path ? `${repo.name}（${repo.path}）` : repo.path,
        value: repo.path,
      }))
    reposGroupPath.value = slug
  }
  catch (err) {
    repoOptions.value = []
    repoError.value = err as Error
  }
  finally {
    reposLoading.value = false
  }
}

/**
 * 切换仓库：写回 query（replace，重置页码）。
 * USelect 的 v-model 理论上是 item.value 字符串，但不同 items 形态下
 * 也可能回传整个对象，这里兜一层再取路径。
 */
function onRepoSelect(value: unknown) {
  const path = typeof value === 'string'
    ? value
    : (value as { value?: string } | null)?.value || ''
  navigate({ repo: path || null, page: null })
}

async function load() {
  const slug = selectedGroup.value?.path
  // 继承成员页签由 loadInherit 独立加载，列表请求跳过（避免无谓调用）
  if (!slug || tab.value === 'inherited') {
    members.value = []
    error.value = null
    return
  }
  loading.value = true
  error.value = null
  outsidersUnsupported.value = false
  try {
    if (tab.value === 'members') {
      members.value = await fetchGroupMembers(slug, { search: keyword.value || undefined, page: page.value })
    }
    else {
      // 外部贡献者必须带仓库路径：没有（列表仍在加载 / 组织下无仓库）就不发请求，
      // 否则等于拿组织路径打仓库级端点，必然 400
      members.value = selectedRepo.value
        ? await fetchOutsideCollaborators(selectedRepo.value, { search: keyword.value || undefined, page: page.value })
        : []
    }
  }
  catch (err) {
    members.value = []
    // 兜底降级：万一仍收到「组织不支持」的 400（如服务端策略变更、query.repo 被手工
    // 改成组织路径），转成引导态而不是红色「加载失败」，避免用户以为是自己网络/权限问题
    if (tab.value === 'outsiders' && isOutsideCollaboratorsUnsupported(err)) {
      outsidersUnsupported.value = true
      error.value = null
    }
    else {
      error.value = err as Error
    }
  }
  finally {
    loading.value = false
  }
}

// 组织切换 / 页签 / 关键词 / 页码 / 选中仓库 任一变化重载
watch(
  () => `${selectedGroup.value?.path}|${tab.value}|${keyword.value}|${page.value}|${selectedRepo.value}`,
  () => {
    // outsiders 页签依赖仓库列表：还没拉过（或切了组织，选项属于上一个组织）
    // 就先拉，列表到达后 selectedRepo 变化会再次触发本 watch，届时才发贡献者请求
    if (
      tab.value === 'outsiders'
      && reposGroupPath.value !== (selectedGroup.value?.path || '')
      && !reposLoading.value
    ) {
      void loadRepos()
    }
    void load()
  },
  { immediate: true },
)

// ---------------------------------------------------------------------------
// 权限列按需加载（R9 / T13 验收 4）：默认 —、行内查看、批量串行、403 tooltip
// ---------------------------------------------------------------------------

/** 单行权限状态：idle（未请求）→ loading → ok（有值）/ denied（403） */
interface PermState {
  state: 'idle' | 'loading' | 'ok' | 'denied'
  value: string
}

/** 权限缓存：key = `${slug}|${username}`，跨翻页/切页签驻留 */
const permMap = ref<Record<string, PermState>>({})

function permKey(username: string): string {
  return `${selectedGroup.value?.path || ''}|${username}`
}

/** 行内权限展示值：列表自带 accessLevel 优先（零请求），否则查缓存 */
function permDisplay(member: { username: string, accessLevel: string }): PermState {
  if (member.accessLevel) {
    return { state: 'ok', value: member.accessLevel }
  }
  return permMap.value[permKey(member.username)] || { state: 'idle', value: '' }
}

/** 行内「查看权限」：单成员 access-level，结果缓存；403 → denied（不阻塞） */
async function loadPerm(username: string) {
  const slug = selectedGroup.value?.path
  const key = permKey(username)
  if (!slug || permMap.value[key]?.state === 'loading') {
    return
  }
  permMap.value = { ...permMap.value, [key]: { state: 'loading', value: '' } }
  try {
    const levels = await fetchMemberAccessLevel(slug, username)
    permMap.value = {
      ...permMap.value,
      [key]: { state: 'ok', value: pickAccessLevelForSlug(levels, slug) },
    }
  }
  catch {
    // 403（缺 group-manage:r）等：按行 denied（tooltip「无权限」），不影响他行
    permMap.value = { ...permMap.value, [key]: { state: 'denied', value: '' } }
  }
}

/** 是否存在未加载权限的行（控制「批量加载」按钮显隐） */
const hasPendingPerms = computed(() => members.value.some(member => permDisplay(member).state === 'idle'))

const batchLoadingPerms = ref(false)

/**
 * 用批量端点一次填充本页的权限缓存。
 *
 * @returns true = 至少填充了一行（无需降级）；false = 端点不可用 / 结构无法识别 /
 *   本页没有能匹配上的行，调用方需要降级为逐人加载
 */
async function fillPermsFromBatch(slug: string): Promise<boolean> {
  try {
    // include_inherit=false：本页签列出的是**直属成员**，继承成员有独立页签；
    // 传 true 会把不在当前列表里的用户也拉进来，白白多占缓存
    const levels = await fetchGroupMembersAccessLevel(slug, false)
    if (levels.size === 0) {
      // 空 Map = 服务端返回了无法识别的结构（如 swagger 声明的单对象形态）。
      // 这不是错误，只是"批量这条路走不通"，交给调用方降级
      return false
    }
    const next = { ...permMap.value }
    let applied = 0
    for (const member of members.value) {
      // 列表自带角色的行无需缓存（permDisplay 优先返回列表值）
      if (member.accessLevel) {
        continue
      }
      const level = levels.get(member.username)
      if (!level) {
        continue
      }
      next[permKey(member.username)] = { state: 'ok', value: level }
      applied += 1
    }
    if (applied === 0) {
      return false
    }
    permMap.value = next
    return true
  }
  catch {
    // 403（缺 group-manage:r）/ 404（网关版本未提供该端点）/ 网络异常：
    // 不弹错误、不阻塞页面 —— 「批量」只是加速手段，不是功能前提
    return false
  }
}

/**
 * 批量加载权限，**降级顺序**（不可颠倒）：
 * 1. 先打批量端点 `GET /{group}/-/members/access-level?include_inherit=false`
 *    —— 一次请求填满整页，彻底避开 N+1（R9）；
 * 2. 批量返回空 Map / 命中 0 行 / 请求失败 → 保留原有「逐人串行 + 200ms 间隔」
 *    逻辑兜底（单行失败继续下一行，互不阻塞）。
 *
 * 为什么顺序不能反：逐人串行在 50 行时要发 50 次请求、耗时 10 秒以上且必然
 * 撞限流；批量端点一次就够，只有它确实不可用时才值得付出这个代价。
 */
async function loadAllPerms() {
  if (batchLoadingPerms.value) {
    return
  }
  const slug = selectedGroup.value?.path
  if (!slug) {
    return
  }
  batchLoadingPerms.value = true
  try {
    if (await fillPermsFromBatch(slug)) {
      return
    }
    for (const member of members.value) {
      if (permDisplay(member).state !== 'idle') {
        continue
      }
      // 先置 loading 再串行 sleep，行内按钮同步转圈
      await loadPerm(member.username)
      await new Promise(resolve => setTimeout(resolve, 200))
    }
  }
  finally {
    batchLoadingPerms.value = false
  }
}

// ---------------------------------------------------------------------------
// 写操作 · 添加成员 / 改角色 / 移除（组织直属成员，设计文档 §2.5）
// ---------------------------------------------------------------------------

/** 角色 → i18n 键（三语键集合由 locales 单测把关） */
const ROLE_LABEL_KEYS: Record<MemberRole, string> = {
  Guest: 'members.write.roleGuest',
  Reporter: 'members.write.roleReporter',
  Developer: 'members.write.roleDeveloper',
  Master: 'members.write.roleMaster',
  Owner: 'members.write.roleOwner',
}

/** 角色 → 本地化名称（未知取值原样返回，避免下拉出现空白项） */
function roleLabel(role: string): string {
  const key = ROLE_LABEL_KEYS[role as MemberRole]
  return key ? t(key) : role
}

/** 组织成员角色下拉项（5 档，大小写敏感的 AccessRole） */
const memberRoleItems = computed(() =>
  MEMBER_ROLES.map(role => ({ label: roleLabel(role), value: role })),
)

/**
 * 外部贡献者角色下拉项（**3 档**）。
 * 少掉 Master / Owner：外部贡献者只拿到仓库级授权，服务端不接受这两档
 * （传了必然参数非法），所以下拉里也不该出现。
 */
const outsiderRoleItems = computed(() =>
  OUTSIDE_COLLABORATOR_ROLES.map(role => ({ label: roleLabel(role), value: role })),
)

/**
 * USelect 回传值归一：items 为 `{ label, value }` 时理论上回传 value 字符串，
 * 但不同 items 形态/版本下也可能回传整个对象，这里兜一层再取字符串。
 */
function selectValue(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  return (value as { value?: string } | null)?.value || ''
}

/**
 * 把服务端返回的角色字符串收敛回枚举（下拉回填用）。
 * 为什么需要：接口偶尔给出本模块枚举之外的取值（历史角色、上游新增档位），
 * 直接把任意 string 塞给 USelect 的 model-value 会让下拉显示成"未选中"，
 * 这里统一收敛：认识的返回枚举，不认识的返回 undefined（显示占位符）。
 */
function toMemberRole(role: string): MemberRole | undefined {
  return (MEMBER_ROLES as readonly string[]).includes(role) ? (role as MemberRole) : undefined
}

/** 同 {@link toMemberRole}，外部贡献者只有三档 */
function toOutsiderRole(role: string): OutsideCollaboratorRole | undefined {
  return (OUTSIDE_COLLABORATOR_ROLES as readonly string[]).includes(role)
    ? (role as OutsideCollaboratorRole)
    : undefined
}

/**
 * 写操作失败的统一提示。
 *
 * 403 且能从 errmsg 解析出缺失 scope 时，标题换成「令牌缺少 xxx 权限」
 * （复用 `state.forbiddenScope`，与 StateAlert 同一文案口径），description 保留
 * 服务端原文便于定位。红线 1：403 **绝不登出** —— 只有 401 才会被
 * cnbRequest 内部登出跳转，缺 scope 的令牌本身仍然有效。
 */
function notifyWriteError(title: string, err: unknown) {
  const scope = (err as CnbApiError | undefined)?.missingScope
  toast.add({
    title: scope ? t('state.forbiddenScope', { scope }) : title,
    description: (err as Error)?.message || '',
    color: 'error',
    duration: 6000,
  })
}

// —— 添加成员（弹窗）——

/** 添加成员弹窗开关 */
const addOpen = ref(false)

/** 添加成员表单（role 默认 Developer：最常见协作档位且不含管理权） */
const addForm = reactive({
  username: '',
  role: 'Developer' as MemberRole,
  isOutsideCollaborator: false,
})

/** 提交中（禁用按钮防重复提交） */
const addSubmitting = ref(false)
/** username 校验错误文案（空串表示通过） */
const addUsernameError = ref('')

/** 每次打开弹窗重置表单，避免上次输入残留导致误提交 */
watch(addOpen, (value) => {
  if (value) {
    addForm.username = ''
    addForm.role = 'Developer'
    addForm.isOutsideCollaborator = false
    addUsernameError.value = ''
  }
})

/**
 * username 校验：非空 + 不含空白/斜杠。
 * 为什么禁斜杠：username 是**单个路径段**，斜杠会把请求路径打断
 * （`/members/a/b` 会路由到不存在的资源，报错信息完全无法定位）。
 */
function validateAddUsername(): boolean {
  const username = addForm.username.trim()
  if (!username) {
    addUsernameError.value = t('members.write.addUsernameRequired')
    return false
  }
  if (/[\s/]/.test(username)) {
    addUsernameError.value = t('members.write.addUsernameInvalid')
    return false
  }
  addUsernameError.value = ''
  return true
}

/**
 * 提交新增成员（POST /{group}/-/members/{username}，scope: group-manage:rw）。
 *
 * 成功后 toast + 关弹窗 + `load()` 重载：不本地插行 —— 昵称/头像/加入时间
 * 都由服务端给，本地拼一条会出现与真实数据不一致的假条目。
 */
async function onAddMember() {
  if (addSubmitting.value || !validateAddUsername()) {
    return
  }
  const slug = selectedGroup.value?.path
  if (!slug) {
    return
  }
  const username = addForm.username.trim()
  addSubmitting.value = true
  try {
    await addGroupMember(slug, username, addForm.role, {
      isOutsideCollaborator: addForm.isOutsideCollaborator,
    })
    toast.add({
      title: t('members.write.addSuccess', { username }),
      color: 'success',
      duration: 3000,
    })
    addOpen.value = false
    await load()
  }
  catch (err) {
    // 409/400（已是成员、用户名不存在）与 403（缺 scope）都走同一条提示，
    // description 带服务端原文，弹窗保留让用户改完重试
    notifyWriteError(t('members.write.addFailed'), err)
  }
  finally {
    addSubmitting.value = false
  }
}

// —— 改角色（行内下拉）——

/** 正在提交改角色的成员（username → true），用于禁用该行下拉防重复提交 */
const roleUpdating = ref<Record<string, boolean>>({})

/**
 * 写入角色显示值：列表项与权限缓存**同时**更新。
 * 为什么要两处：permDisplay 优先读 `member.accessLevel`，只写缓存不会反映到
 * 界面；只写列表项则翻页回来后缓存里仍是旧角色。
 */
function applyRole(member: MemberItem, role: string) {
  member.accessLevel = role
  permMap.value = { ...permMap.value, [permKey(member.username)]: { state: 'ok', value: role } }
}

/**
 * 修改直属成员角色（PUT /{group}/-/members/{username}，scope: group-manage:rw）。
 *
 * 失败必须**回滚显示值**：下拉是受控的（`:model-value` 取值于 permDisplay），
 * 但 Reka 内部仍可能保留用户刚选的项，显式写回旧值才能保证「失败了仍是旧角色」，
 * 否则用户以为改成功了、实际服务端没变，是比报错更糟的体验。
 */
async function onChangeMemberRole(member: MemberItem, value: unknown) {
  const nextRole = selectValue(value) as MemberRole
  const previous = permDisplay(member).value
  const slug = selectedGroup.value?.path
  if (!slug || !nextRole || nextRole === previous || roleUpdating.value[member.username]) {
    return
  }
  roleUpdating.value = { ...roleUpdating.value, [member.username]: true }
  try {
    await updateGroupMemberRole(slug, member.username, nextRole)
    applyRole(member, nextRole)
    toast.add({
      title: t('members.write.updateSuccess', {
        username: member.username,
        role: roleLabel(nextRole),
      }),
      color: 'success',
      duration: 3000,
    })
  }
  catch (err) {
    applyRole(member, previous)
    notifyWriteError(t('members.write.updateFailed'), err)
  }
  finally {
    const next = { ...roleUpdating.value }
    delete next[member.username]
    roleUpdating.value = next
  }
}

// —— 外部贡献者改角色（仓库级）——

/**
 * 修改外部贡献者角色（PUT /{slug}/-/outside-collaborators/{username}?role=…）。
 *
 * `{slug}` 必须是**当前选中仓库的完整路径**（`组织/仓库`）：外部贡献者是仓库级
 * 概念，传组织路径会拿到 `400 This feature is not supported for organizations.`。
 * 因此没有选中仓库时直接拦住并提示，不发注定失败的请求。
 */
async function onChangeOutsiderRole(member: MemberItem, value: unknown) {
  const nextRole = selectValue(value)
  const previous = member.accessLevel
  const repoPath = selectedRepo.value || ''
  if (!nextRole || nextRole === previous || roleUpdating.value[member.username]) {
    return
  }
  if (!repoPath) {
    toast.add({
      title: t('members.write.repoRequired'),
      color: 'error',
      duration: 4000,
    })
    return
  }
  roleUpdating.value = { ...roleUpdating.value, [member.username]: true }
  try {
    await updateOutsideCollaborator(repoPath, member.username, nextRole)
    member.accessLevel = nextRole
    toast.add({
      title: t('members.write.outsiderUpdateSuccess', {
        username: member.username,
        role: roleLabel(nextRole),
      }),
      color: 'success',
      duration: 3000,
    })
  }
  catch (err) {
    // 回滚显示值（列表项即显示数据源）
    member.accessLevel = previous
    notifyWriteError(t('members.write.outsiderUpdateFailed'), err)
  }
  finally {
    const next = { ...roleUpdating.value }
    delete next[member.username]
    roleUpdating.value = next
  }
}

// —— 移除（成员 / 外部贡献者共用同一个确认框）——

/** 待移除目标：kind 决定用哪个端点（组织成员 vs 仓库外部贡献者） */
interface RemoveTarget {
  kind: 'member' | 'outsider'
  username: string
}

const removeOpen = ref(false)
const removeTarget = ref<RemoveTarget | null>(null)
const removing = ref(false)

/**
 * 打开移除确认框。
 * 两个页签复用同一个 ConfirmDialog（同一时刻只有一个目标），
 * 差异只在标题/文案/target.kind 决定的端点。
 */
function openRemove(kind: RemoveTarget['kind'], username: string) {
  removeTarget.value = { kind, username }
  removeOpen.value = true
}

/** 确认框标题（随目标类型切换） */
const removeTitle = computed(() =>
  removeTarget.value?.kind === 'outsider'
    ? t('members.write.outsiderRemoveTitle')
    : t('members.write.removeTitle'),
)

/** 确认框说明：写清后果与不可逆性（成员要写明「继承权限不再生效」） */
const removeDesc = computed(() =>
  removeTarget.value?.kind === 'outsider'
    ? t('members.write.outsiderRemoveDesc', { repo: selectedRepo.value })
    : t('members.write.removeDesc'),
)

const removeConfirmLabel = computed(() => t('members.write.remove'))

/** 二次确认输入提示（要求逐个字符输入 username） */
const removeTypeLabel = computed(() =>
  t('members.write.removeTypeLabel', { username: removeTarget.value?.username || '' }),
)

/**
 * 执行移除。成功 → 关弹窗 + `load()` 重载；失败 → 弹窗保留（可重试或取消）。
 *
 * 外部贡献者分支用 `selectedRepo`（仓库完整路径），成员分支用组织路径 ——
 * 两者不可混用，混用会 400（组织不支持外部贡献者）。
 */
async function confirmRemove() {
  const target = removeTarget.value
  if (!target || removing.value) {
    return
  }
  const slug = selectedGroup.value?.path || ''
  const repoPath = selectedRepo.value || ''
  // 缺上下文（组织未选中 / 仓库未选中）就不发请求：写操作打错路径的代价比不执行高
  if (target.kind === 'outsider' ? !repoPath : !slug) {
    return
  }
  removing.value = true
  try {
    if (target.kind === 'outsider') {
      await removeOutsideCollaborator(repoPath, target.username)
      toast.add({
        title: t('members.write.outsiderRemoveSuccess', { username: target.username }),
        color: 'success',
        duration: 3000,
      })
    }
    else {
      await removeGroupMember(slug, target.username)
      toast.add({
        title: t('members.write.removeSuccess', { username: target.username }),
        color: 'success',
        duration: 3000,
      })
    }
    removeOpen.value = false
    removeTarget.value = null
    await load()
  }
  catch (err) {
    notifyWriteError(
      target.kind === 'outsider'
        ? t('members.write.outsiderRemoveFailed')
        : t('members.write.removeFailed'),
      err,
    )
  }
  finally {
    removing.value = false
  }
}

// ---------------------------------------------------------------------------
// 继承成员页签（T13 验收 5：按 inherit_path 分区 + 来源路径 + 人数）
// ---------------------------------------------------------------------------

const inheritGroups = ref<InheritMemberGroup[]>([])
const inheritLoading = ref(false)
const inheritError = ref<Error | null>(null)

async function loadInherit() {
  const slug = selectedGroup.value?.path
  if (!slug) {
    inheritGroups.value = []
    return
  }
  inheritLoading.value = true
  inheritError.value = null
  try {
    inheritGroups.value = await fetchInheritMembers(slug)
  }
  catch (err) {
    inheritGroups.value = []
    inheritError.value = err as Error
  }
  finally {
    inheritLoading.value = false
  }
}

// 切到继承成员页签时拉取（独立于成员列表加载）
watch(tab, (value) => {
  if (value === 'inherited') {
    void loadInherit()
  }
}, { immediate: true })

/** 页签定义（UTabs 受控模式） */
const tabItems = computed((): TabsItem[] => [
  { label: t('members.tabMembers'), icon: 'i-lucide-users', value: 'members' },
  { label: t('members.tabOutsiders'), icon: 'i-lucide-user-check', value: 'outsiders' },
  { label: t('members.tabInherited'), icon: 'i-lucide-users-round', value: 'inherited' },
])

/**
 * 空态文案：区分页签（成员 / 外部贡献者）与是否带搜索词。
 * 外部贡献者单独一套文案：它的「空」更多是「这个仓库没人被加为外部贡献者」。
 */
const emptyText = computed(() => {
  if (tab.value === 'outsiders') {
    return keyword.value ? t('members.outsidersEmptyFiltered') : t('members.outsidersEmpty')
  }
  return keyword.value ? t('members.emptyFiltered') : t('members.empty')
})

/** 搜索框占位：成员按用户名搜，外部贡献者按仓库内贡献者搜 */
const searchPlaceholder = computed(() =>
  tab.value === 'outsiders' ? t('members.searchOutsidersPlaceholder') : t('members.searchPlaceholder'),
)

/** 成员管理外跳（成员页 → 组织主页成员区；贡献者页 → 组织主页） */
const manageUrl = computed(() => selectedGroup.value ? cnbGroupUrl(selectedGroup.value.path) : 'https://cnb.cool')

function openManage() {
  if ('__TAURI_INTERNALS__' in window) {
    void openUrl(manageUrl.value)
  }
  else {
    window.open(manageUrl.value, '_blank')
  }
}
</script>

<template>
  <UDashboardPanel id="members">
    <template #header>
      <UDashboardNavbar :title="t('members.title')">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <!-- 组织上下文（跟随侧边栏 GroupsMenu 切换） -->
      <div class="flex items-center gap-2 mb-3 flex-wrap">
        <UIcon name="i-lucide-users" class="size-5 text-muted" />
        <h2 class="text-lg font-semibold text-highlighted">
          {{ t('members.title') }}
        </h2>
        <UBadge
          v-if="selectedGroup"
          color="neutral"
          variant="subtle"
          :label="selectedGroup.path"
        />
        <div class="ms-auto flex items-center gap-2">
          <!-- 添加成员（仅「成员」页签 + 有管理权限；红线 2：写入口事前隐藏） -->
          <UButton
            v-if="tab === 'members' && canManage"
            size="sm"
            color="primary"
            icon="i-lucide-user-plus"
            :label="t('members.write.addMember')"
            @click="addOpen = true"
          />
          <UButton
            size="sm"
            color="neutral"
            variant="outline"
            icon="i-lucide-external-link"
            :label="t('members.manageInBrowser')"
            @click="openManage"
          />
        </div>
      </div>

      <UTabs
        :model-value="tab"
        :items="tabItems"
        color="neutral"
        class="mb-4"
        @update:model-value="(value: string | number) => switchTab(value as 'members' | 'outsiders')"
      />

      <!-- 搜索（透传服务端 search 参数；继承成员页签不需要搜索） -->
      <UInput
        v-if="tab !== 'inherited'"
        v-model="keywordDraft"
        size="sm"
        variant="soft"
        icon="i-lucide-search"
        :placeholder="searchPlaceholder"
        class="mb-3 max-w-sm"
        @keydown.enter="onKeywordEnter"
      />

      <!-- 仓库选择器（仅外部贡献者页签）：
           外部贡献者是仓库级权限，CNB 侧不支持按组织查询（400），
           所以先选仓库、再查该仓库的外部贡献者 -->
      <div
        v-if="tab === 'outsiders'"
        class="mb-3 flex items-center gap-2 flex-wrap"
      >
        <UIcon
          name="i-lucide-git-branch"
          class="size-4 text-dimmed"
        />
        <span class="text-sm text-muted">{{ t('members.outsidersRepoLabel') }}</span>
        <USelect
          :model-value="selectedRepo || undefined"
          :items="repoOptions"
          :disabled="reposLoading || repoOptions.length === 0"
          :placeholder="reposLoading ? t('members.outsidersRepoLoading') : t('members.outsidersRepoPlaceholder')"
          size="sm"
          class="w-80 max-w-full"
          @update:model-value="onRepoSelect"
        />
        <UTooltip :text="t('members.outsidersRepoHint')">
          <UIcon
            name="i-lucide-info"
            class="size-4 text-dimmed cursor-help"
          />
        </UTooltip>
      </div>

      <!-- 批量加载权限（R9：仅当存在未加载行时显示，串行 200ms 间隔） -->
      <div
        v-if="tab === 'members' && hasPendingPerms"
        class="mb-3"
      >
        <UButton
          size="sm"
          color="neutral"
          variant="outline"
          icon="i-lucide-shield-check"
          :loading="batchLoadingPerms"
          :label="t('members.batchLoadPerms')"
          @click="loadAllPerms"
        />
      </div>

      <!-- 继承成员页签：按 inherit_path 分区 + 来源路径 + 人数（T13 验收 5） -->
      <template v-if="tab === 'inherited'">
        <StateAlert
          v-if="inheritLoading"
          state="loading"
          loading-variant="list"
        />
        <StateAlert
          v-else-if="inheritError"
          state="error"
          :error="inheritError"
          :site-url="manageUrl"
          :retry="loadInherit"
        />
        <StateAlert
          v-else-if="inheritGroups.length === 0"
          state="empty"
          :empty-text="t('members.inheritedEmpty')"
          :empty-desc="t('members.inheritedEmptyDesc')"
        />
        <div
          v-else
          class="flex flex-col gap-5"
        >
          <section
            v-for="section in inheritGroups"
            :key="section.inheritPath"
            class="flex flex-col gap-2"
          >
            <div class="flex items-center gap-2">
              <UIcon
                name="i-lucide-building-2"
                class="size-4 text-dimmed"
              />
              <span class="text-sm font-semibold">{{ section.inheritPath }}</span>
              <UBadge
                color="neutral"
                variant="subtle"
                size="sm"
                :label="t('members.inheritedCount', { count: section.total })"
              />
            </div>
            <div class="flex flex-col gap-2">
              <div
                v-for="user in section.users"
                :key="`${section.inheritPath}|${user.username}`"
                class="flex items-center gap-3 px-4 py-3 rounded-lg border border-default"
              >
                <UAvatar
                  :src="user.avatar"
                  :alt="user.nickname"
                  size="md"
                />
                <div class="min-w-0 flex-1">
                  <p class="text-sm font-medium text-highlighted truncate">
                    {{ user.nickname }}
                    <span class="text-dimmed font-normal">@{{ user.username }}</span>
                  </p>
                  <p
                    v-if="user.joinTime"
                    class="text-xs text-dimmed"
                  >
                    {{ t('members.joined', { time: formatDateTime(user.joinTime) }) }}
                  </p>
                </div>
                <!-- 继承成员的角色（列表自带；缺失显示 —） -->
                <UBadge
                  v-if="user.accessLevel"
                  color="neutral"
                  variant="subtle"
                  size="sm"
                  :label="user.accessLevel"
                />
                <span
                  v-else
                  class="text-xs text-dimmed"
                >—</span>
              </div>
            </div>
          </section>
        </div>
      </template>

      <!-- 成员 / 外部贡献者页签：三态 + 403 降级 -->
      <template v-else>
        <!-- 引导态（非错误态）：服务端明确表示「组织不支持外部贡献者」，
             说明当前上下文没有落到仓库维度，给出可操作指引 -->
        <UAlert
          v-if="outsidersUnsupported"
          icon="i-lucide-info"
          color="neutral"
          variant="soft"
          :title="t('members.outsidersRepoOnly')"
          :description="t('members.outsidersRepoOnlyDesc')"
        >
          <template #actions>
            <UButton
              size="sm"
              color="neutral"
              variant="subtle"
              icon="i-lucide-external-link"
              @click="openManage"
            >
              {{ t('common.openInBrowser') }}
            </UButton>
          </template>
        </UAlert>
        <!-- 外部贡献者：仓库列表加载中也要显示骨架屏，避免先闪一下「请选择仓库」 -->
        <StateAlert
          v-else-if="loading || (tab === 'outsiders' && reposLoading)"
          state="loading"
          loading-variant="list"
        />
        <!-- 仓库列表拉取失败（403/网络）：只影响外部贡献者页签，可原地重试 -->
        <StateAlert
          v-else-if="tab === 'outsiders' && repoError"
          state="error"
          :error="repoError"
          :site-url="manageUrl"
          :retry="loadRepos"
        />
        <StateAlert
          v-else-if="error"
          state="error"
          :error="error"
          :site-url="manageUrl"
          :retry="load"
        />
        <!-- 组织下没有任何仓库：外部贡献者无从查起，给出说明而非「暂无成员」 -->
        <StateAlert
          v-else-if="tab === 'outsiders' && !selectedRepo"
          state="empty"
          :empty-text="t('members.outsidersNoRepo')"
          :empty-desc="t('members.outsidersNoRepoDesc')"
        />
        <StateAlert
          v-else-if="members.length === 0"
          state="empty"
          :empty-text="emptyText"
        />
        <div
          v-else
          class="flex flex-col gap-2"
        >
          <div
            v-for="member in members"
            :key="member.username"
            class="flex items-center gap-3 px-4 py-3 rounded-lg border border-default"
          >
            <UAvatar
              :src="member.avatar"
              :alt="member.nickname"
              size="md"
            />
            <div class="min-w-0 flex-1">
              <p class="text-sm font-medium text-highlighted truncate">
                {{ member.nickname }}
                <span class="text-dimmed font-normal">@{{ member.username }}</span>
              </p>
              <p
                v-if="member.joinTime"
                class="text-xs text-dimmed"
              >
                {{ t('members.joined', { time: formatDateTime(member.joinTime) }) }}
              </p>
            </div>
            <!-- 角色列：
                 - 外部贡献者（仓库级）：可管理时**始终**渲染 3 档下拉（列表可能没带
                   角色，此时显示占位符）；不可管理时只展示只读徽标；
                 - 组织成员：可管理且已有角色 → 5 档下拉；其余沿用 R9 按需加载展示：
                   列表自带 accessLevel / 已缓存 → 徽标；idle → 「查看权限」按钮
                   （点击才发单成员请求）；loading → 转圈；denied（403）→ 「无权限」tooltip -->
            <template v-if="tab === 'outsiders'">
              <USelect
                v-if="canManage"
                :model-value="toOutsiderRole(member.accessLevel)"
                :items="outsiderRoleItems"
                :disabled="roleUpdating[member.username]"
                :placeholder="t('members.write.roleUnknown')"
                size="xs"
                class="w-32"
                @update:model-value="(value: unknown) => onChangeOutsiderRole(member, value)"
              />
              <UBadge
                v-else-if="member.accessLevel"
                color="neutral"
                variant="subtle"
                size="sm"
                :label="member.accessLevel"
              />
              <!-- 外部贡献者无「组织成员权限」可查（access-level 是组织级端点），
                   列表没带角色时只显示占位符，不提供会 404/400 的按钮 -->
              <span
                v-else
                class="text-xs text-dimmed"
              >—</span>
            </template>
            <template v-else>
              <USelect
                v-if="canManage && permDisplay(member).state === 'ok' && permDisplay(member).value"
                :model-value="toMemberRole(permDisplay(member).value)"
                :items="memberRoleItems"
                :disabled="roleUpdating[member.username]"
                size="xs"
                class="w-32"
                @update:model-value="(value: unknown) => onChangeMemberRole(member, value)"
              />
              <UBadge
                v-else-if="permDisplay(member).state === 'ok' && permDisplay(member).value"
                color="neutral"
                variant="subtle"
                size="sm"
                :label="permDisplay(member).value"
              />
              <UTooltip
                v-else-if="permDisplay(member).state === 'ok'"
                :text="t('members.permUnknown')"
              >
                <span class="text-xs text-dimmed">—</span>
              </UTooltip>
              <UTooltip
                v-else-if="permDisplay(member).state === 'denied'"
                :text="t('members.permDenied')"
              >
                <span class="text-xs text-dimmed">—</span>
              </UTooltip>
              <UIcon
                v-else-if="permDisplay(member).state === 'loading'"
                name="i-lucide-loader-circle"
                class="size-4 text-dimmed animate-spin"
              />
              <UButton
                v-else
                size="xs"
                color="neutral"
                variant="ghost"
                icon="i-lucide-shield-question"
                :label="t('members.viewPerm')"
                @click="loadPerm(member.username)"
              />
            </template>

            <!-- 行操作：移除（仅可管理时显示）。破坏性操作 → ConfirmDialog +
                 typeToConfirm（输入 username）二次确认，见页面底部弹窗 -->
            <UButton
              v-if="canManage"
              size="xs"
              color="error"
              variant="ghost"
              icon="i-lucide-user-minus"
              :aria-label="t('members.write.remove')"
              :title="t('members.write.remove')"
              @click="openRemove(tab === 'outsiders' ? 'outsider' : 'member', member.username)"
            />
          </div>
        </div>
      </template>

      <!-- 添加成员弹窗（POST /{group}/-/members/{username}，scope group-manage:rw）。
           角色默认 Developer；「设为外部协作者」映射 body 的 is_outside_collaborator -->
      <UModal
        v-model:open="addOpen"
        :title="t('members.write.addTitle')"
        :ui="{ content: 'max-w-md' }"
      >
        <template #body>
          <div class="flex flex-col gap-4">
            <!-- 组织上下文（selectedGroup 只读展示） -->
            <div class="flex items-center gap-2 text-sm text-muted">
              <UIcon
                name="i-lucide-building-2"
                class="size-4 shrink-0"
              />
              <span>{{ selectedGroup?.path || '' }}</span>
            </div>

            <!-- 用户名（必填；它是路径段，禁止空白与斜杠） -->
            <UFormField
              :label="t('members.write.addUsername')"
              required
              :error="addUsernameError || undefined"
            >
              <UInput
                v-model="addForm.username"
                class="w-full"
                autocomplete="off"
                :placeholder="t('members.write.addUsernamePlaceholder')"
                @blur="addForm.username && validateAddUsername()"
              />
            </UFormField>

            <!-- 角色（5 档 AccessRole，大小写敏感，值为枚举原文） -->
            <UFormField :label="t('members.write.addRole')">
              <USelect
                v-model="addForm.role"
                class="w-full"
                :items="memberRoleItems"
                value-key="value"
              />
            </UFormField>

            <!-- 外部协作者标记（可选；缺省不改动服务端已有标记） -->
            <div class="flex flex-col gap-1">
              <USwitch
                v-model="addForm.isOutsideCollaborator"
                :label="t('members.write.addOutsideCollaborator')"
              />
              <p class="text-xs text-dimmed">
                {{ t('members.write.addOutsideCollaboratorHint') }}
              </p>
            </div>
          </div>
        </template>

        <template #footer>
          <div class="flex justify-end gap-2 w-full">
            <UButton
              color="neutral"
              variant="ghost"
              :label="t('common.cancel')"
              @click="addOpen = false"
            />
            <UButton
              color="primary"
              icon="i-lucide-plus"
              :loading="addSubmitting"
              :label="t('members.write.submit')"
              @click="onAddMember"
            />
          </div>
        </template>
      </UModal>

      <!-- 移除确认（成员 / 外部贡献者共用）：confirmColor=error + typeToConfirm
           输入 username 才能提交，防误删 -->
      <ConfirmDialog
        v-model:open="removeOpen"
        :title="removeTitle"
        :desc="removeDesc"
        :confirm-label="removeConfirmLabel"
        confirm-color="error"
        :loading="removing"
        :type-to-confirm="removeTarget?.username"
        :type-to-confirm-label="removeTypeLabel"
        @confirm="confirmRemove"
      />
    </template>
  </UDashboardPanel>
</template>
