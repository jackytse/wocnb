<script setup lang="ts">
/**
 * 仓库成员面板 —— 批次 2 · REQ-11。
 *
 * 为什么单独成组件而不是塞进 members.vue：组织成员页已有 ~1300 行（三页签 +
 * 权限按需加载 + 多种写操作），再叠加一套仓库维度会让条件分支互相污染。
 * 本面板自包含：仓库选择器 + 成员表格 + 增删改 + 权限列 + 继承来源，
 * 由 members.vue 以第 4 个页签挂载，互不干扰。
 *
 * ⚠️ 关键约束（PRD §6.1 踩坑#1）：`/{repo}/-/members` 是**仓库维度**端点，
 * 传组织路径会 400。因此本组件**必须先拿到完整仓库路径**才发请求；
 * 组织下无仓库时渲染引导空态，而不是拿组织路径去撞 400。
 *
 * 通道：三个写端点均返回 200 空 body → 数据层已用 cnbFetchVoid；
 * 权限列走批量端点优先、逐人降级（N7/R9，防 N+1）。
 */
// 数据层：仓库成员读端点 + 三个写端点（均为 200 空 body → cnbFetchVoid）
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
// MEMBER_ROLES：合法角色枚举（下拉选项与校验共用）；fetchAllMembers 含继承的有效成员
import {
  addRepoMember,
  fetchAllMembers,
  fetchRepoInheritMembers,
  fetchRepoMemberAccessLevel,
  fetchRepoMembers,
  fetchRepoMembersAccessLevel,
  MEMBER_ROLES,
  removeRepoMember,
  updateRepoMemberRole,
  type InheritMemberGroup,
  type MemberItem,
  type MemberRole,
} from '../../composables/useCnbMembers'
// 权限预判与组织仓库列表（复用组织页的同源状态，不另建数据通道）
import { canManageRole, fetchCnbGroupRepos, selectedGroup } from '../../composables/useCnbAuth'
// 通用弹窗：删除确认（输入用户名二次确认）与状态降级
import ConfirmDialog from '../common/ConfirmDialog.vue'
import StateAlert from '../repo/StateAlert.vue'

const { t } = useI18n()
const toast = useToast() // 成功/失败提示（写操作反馈）

/** 写入口权限预判：组织 Master/Owner 通常同时管仓库；真实 403 作兜底 */
const canManage = computed(() => canManageRole(selectedGroup.value?.access_role))

// ---------------------------------------------------------------------------
// 仓库选择（复用组织仓库列表端点 GET /{group}/-/repos）
// ---------------------------------------------------------------------------

/** 仓库下拉选项（label 展示名 + value 完整路径） */
const repoOptions = ref<{ label: string, value: string }[]>([])
/** 仓库列表加载中（下拉禁用态） */
const reposLoading = ref(false)
/** 仓库列表加载失败（错误条 + 重试） */
const repoError = ref<Error | null>(null)
/** 当前选项属于哪个组织（丢弃切组织瞬间的陈旧选项） */
const reposGroupPath = ref('')
/** 选中仓库（空串 = 还未选定；未选定时绝不发成员请求） */
const selectedRepo = ref('')

/** 加载当前组织下仓库列表，默认选中首个 */
async function loadRepos() {
  const slug = selectedGroup.value?.path // 当前组织路径（空 = 未选中任何组织）
  // 未选中组织：清空全部仓库态（不能拿空路径发请求）
  if (!slug) {
    repoOptions.value = []
    reposGroupPath.value = ''
    selectedRepo.value = ''
    return
  }
  reposLoading.value = true // 仓库下拉禁用中
  repoError.value = null
  repoOptions.value = [] // 先清旧选项：切组织瞬间不残留上一组织的仓库
  try {
    // 第一页拉 100 个：组织维度仓库数一般远小于此，不做分页
    const repos = await fetchCnbGroupRepos(slug, 1, 100)
    repoOptions.value = repos
      .filter(repo => repo.path) // 无路径的异常条目直接丢弃
      .map(repo => ({
        // 展示名与路径不同时都显示（CNB 仓库名可含中文，路径是 slug）
        label: repo.name && repo.name !== repo.path ? `${repo.name}（${repo.path}）` : repo.path,
        value: repo.path,
      }))
    reposGroupPath.value = slug // 记录来源组织：切组织瞬间用它与 slug 比对丢弃陈旧选项
    // 默认选首个仓库：进页签即有内容，不必先手动选一次
    if (repoOptions.value.length > 0) {
      selectedRepo.value = repoOptions.value[0].value
    }
  }
  catch (err) {
    repoOptions.value = [] // 失败清选项（错误条 + 重试接管）
    repoError.value = err as Error
  }
  finally {
    reposLoading.value = false
  }
}

/** USelect 回传可能是字符串或对象，统一取路径 */
function onRepoSelect(value: unknown) {
  const path = typeof value === 'string'
    ? value
    : (value as { value?: string } | null)?.value || ''
  // 切换仓库成功后 toast 告知用户：仅在实际变更时提示，避免默认选中 /
  // 重复点击同仓库时弹无意义的通知（列表重载由 selectedRepo watch 驱动）
  if (path && path !== selectedRepo.value) {
    toast.add({
      title: t('repo.members.repoSwitched', { repo: path }),
      color: 'success',
      duration: 2500,
    })
  }
  selectedRepo.value = path // 写入后由 selectedRepo watch 驱动成员区重载
}

// ---------------------------------------------------------------------------
// 成员列表
// ---------------------------------------------------------------------------

/** 仓库直属成员列表 */
const members = ref<MemberItem[]>([])
/** 成员列表加载中（骨架屏） */
const loading = ref(false)
/** 成员列表加载失败（错误条 + 重试） */
const error = ref<Error | null>(null)

/** 拉取仓库直属成员（必须已选仓库） */
async function loadMembers() {
  // 未选仓库：清列表直接返回（组织路径打仓库端点会 400，见头注释）
  if (!selectedRepo.value) {
    members.value = []
    error.value = null
    return
  }
  loading.value = true // 成员区骨架屏
  error.value = null
  try {
    // 单页 100：仓库成员数一般在此量级，超出部分后续可加翻页
    members.value = await fetchRepoMembers(selectedRepo.value, { pageSize: 100 })
  }
  catch (err) {
    members.value = [] // 失败清列表（错误条 + 重试接管展示）
    error.value = err as Error
  }
  finally {
    loading.value = false
  }
}

// ---------------------------------------------------------------------------
// 权限列：批量优先，逐人降级
// ---------------------------------------------------------------------------

/** username → 角色（批量端点返回；空 Map 时降级逐人） */
const permMap = ref<Record<string, string>>({})
/** 逐人加载中的用户名集合 */
const permLoading = ref<Record<string, boolean>>({})
/** 逐人 403 标记（展示"无权限"而不是空白） */
const permDenied = ref<Record<string, boolean>>({})
/** 批量加载进行中（按钮 loading） */
const batchLoading = ref(false)

/** 展示值：列表自带角色优先 → 批量缓存 → 逐人缓存 */
function permDisplay(member: MemberItem): string {
  // 三级回退：接口自带字段最准，其次是批量/逐人请求的缓存
  return member.accessLevel || permMap.value[member.username] || ''
}

/** 批量加载权限（一次请求，避免对每行发 GET） */
async function loadAllPerms() {
  // 未选仓库 / 已在批量加载：直接返回
  if (!selectedRepo.value || batchLoading.value) {
    return
  }
  batchLoading.value = true // 批量按钮 loading（防并发重复拉取）
  try {
    // 第二参数 false：只取直属成员（继承成员在独立折叠区展示）
    const map = await fetchRepoMembersAccessLevel(selectedRepo.value, false)
    if (map.size === 0) {
      // 结构无法识别（单对象形态）→ 降级逐人，但只在用户点批量时触发一次
      toast.add({ title: t('repo.members.batchFallback'), color: 'neutral', duration: 4000 })
      return
    }
    // 合并进缓存（不覆盖已逐人取得的值以外的键）
    const next: Record<string, string> = { ...permMap.value }
    for (const [username, level] of map.entries()) {
      next[username] = level
    }
    permMap.value = next
  }
  catch (err) {
    // 批量失败：toast 透出，表格主体不受影响（可改用逐人查看）
    toast.add({
      title: t('repo.members.permFailed'),
      description: (err as Error)?.message || '',
      color: 'error',
      duration: 6000,
    })
  }
  finally {
    batchLoading.value = false
  }
}

/** 单人权限（批量不可用时的按需加载） */
async function loadPerm(username: string) {
  // 未选仓库 / 该用户已在加载：直接返回（按钮自带 loading 态）
  if (!selectedRepo.value || permLoading.value[username]) {
    return
  }
  permLoading.value = { ...permLoading.value, [username]: true } // 按用户名粒度 loading
  try {
    const levels = await fetchRepoMemberAccessLevel(selectedRepo.value, username)
    if (levels.length > 0) {
      // 取第一个角色（用户在同一仓库只有一个有效角色）
      permMap.value = { ...permMap.value, [username]: levels[0] }
    }
  }
  catch (err) {
    // 403 表示令牌缺 repo-manage:r：标 denied（不阻塞成员表主体）
    const status = (err as { status?: number }).status
    if (status === 403) {
      permDenied.value = { ...permDenied.value, [username]: true }
    }
  }
  finally {
    permLoading.value = { ...permLoading.value, [username]: false } // 复位该行 loading
  }
}

// ---------------------------------------------------------------------------
// 写操作：改角色 / 添加 / 移除
//
// 改角色用乐观更新（高频小操作，整表重拉会让 UI 闪烁）；添加/移除走
// 弹窗确认 + 成功后重拉（低频且改变成员集合，以服务端结果为准）。
// ---------------------------------------------------------------------------

/** 角色下拉选项（与组织成员页同一套角色枚举） */
const roleItems = MEMBER_ROLES.map(role => ({ label: role, value: role })) // value 即提交给服务端的角色名
/** 角色更新中标记（按 username，防重复点击） */
const roleUpdating = ref<Record<string, boolean>>({})

/** 改角色：OPTIMISTIC 更新 + 失败回滚（与组织页同一交互范式） */
async function onChangeRole(member: MemberItem, value: unknown) {
  // USelect 回传可能是对象/空值：归一为 MemberRole
  const role = (typeof value === 'string' ? value : '') as MemberRole
  // 无角色 / 未选仓库 / 该行已在更新：直接返回
  if (!role || !selectedRepo.value || roleUpdating.value[member.username]) {
    return
  }
  const previous = member.accessLevel // 回滚基准（乐观更新失败时还原）
  // 先乐观更新：下拉立即反馈，失败再回滚（避免整表闪烁）
  member.accessLevel = role
  roleUpdating.value = { ...roleUpdating.value, [member.username]: true } // 该行下拉禁用中
  try {
    await updateRepoMemberRole(selectedRepo.value, member.username, role)
    toast.add({ title: t('repo.members.roleUpdated'), color: 'success', duration: 2000 })
  }
  catch (err) {
    // 失败回滚到原角色，并透出服务端原因
    member.accessLevel = previous
    toast.add({
      title: t('repo.members.roleUpdateFailed'),
      description: (err as Error)?.message || '',
      color: 'error',
      duration: 6000,
    })
  }
  finally {
    roleUpdating.value = { ...roleUpdating.value, [member.username]: false }
  }
}

/** 添加成员弹窗 */
const addOpen = ref(false)
const addUsername = ref('') // 新成员用户名（trim 后提交）
const addRole = ref<MemberRole>('Developer') // 默认 Developer（最低可写角色）
const adding = ref(false) // 提交中（按钮 loading）

/** 打开添加弹窗：清空草稿、角色回落默认值 */
function openAdd() {
  addUsername.value = ''
  addRole.value = 'Developer'
  addOpen.value = true
}

/** 提交新增：POST（200 空 body → cnbFetchVoid）成功后重拉列表 */
async function submitAdd() {
  const username = addUsername.value.trim()
  // 空用户名 / 未选仓库 / 提交中：直接返回
  if (!username || !selectedRepo.value || adding.value) {
    return
  }
  adding.value = true // 提交中（按钮 loading）
  try {
    await addRepoMember(selectedRepo.value, username, addRole.value)
    addOpen.value = false // 成功才关弹窗（失败保留草稿）
    toast.add({ title: t('repo.members.added'), color: 'success', duration: 2500 })
    await loadMembers() // 重拉列表呈现新成员
  }
  catch (err) {
    // 失败保留弹窗与输入，便于修正后重试
    toast.add({
      title: t('repo.members.addFailed'),
      description: (err as Error)?.message || '',
      color: 'error',
      duration: 6000,
    })
  }
  finally {
    adding.value = false
  }
}

/** 移除成员确认（输入用户名二次确认，不可逆） */
const removeOpen = ref(false)
/** 待移除成员（null = 未选中） */
const removeTarget = ref<MemberItem | null>(null)
/** 二次确认输入（需与用户名完全一致） */
const removeTyped = ref('')
const removing = ref(false)

/** 打开移除确认（清空上次输入，避免残留） */
function askRemove(member: MemberItem) {
  removeTyped.value = ''
  removeTarget.value = member
  removeOpen.value = true
}

/** 确认移除：DELETE 成功后重拉列表 */
async function confirmRemove() {
  const target = removeTarget.value
  // 无目标 / 未选仓库 / 移除中：直接返回
  if (!target || !selectedRepo.value || removing.value) {
    return
  }
  removing.value = true // 删除进行中（确认按钮 loading，防重复）
  try {
    await removeRepoMember(selectedRepo.value, target.username)
    removeOpen.value = false // 成功才关确认框
    removeTarget.value = null // 清目标：下次打开不残留
    toast.add({ title: t('repo.members.removed'), color: 'success', duration: 2500 })
    await loadMembers()
  }
  catch (err) {
    toast.add({
      title: t('repo.members.removeFailed'),
      description: (err as Error)?.message || '',
      color: 'error',
      duration: 6000,
    })
  }
  finally {
    removing.value = false
  }
}

// ---------------------------------------------------------------------------
// 有效成员（含继承）与继承来源
// ---------------------------------------------------------------------------

/** 继承来源分组（按继承路径分组的成员） */
const inheritGroups = ref<InheritMemberGroup[]>([])
/** 继承区加载中 */
const inheritLoading = ref(false)
/** 继承区加载失败（行内提示） */
const inheritError = ref<Error | null>(null)
/**
 * 是否展开"继承来源"折叠区。
 * 默认展开（用户要求）：数据随仓库选定自动加载，不等用户手动展开；
 * 折叠区仍保留开关，收起只是隐藏内容（缓存不清）。
 */
const inheritOpen = ref(true)

/** 拉取继承来源（失败降级空数组 + 行内错误） */
async function loadInherit() {
  // 未选仓库：清空直接返回
  if (!selectedRepo.value) {
    inheritGroups.value = []
    return
  }
  inheritLoading.value = true // 继承区加载中
  inheritError.value = null
  try {
    inheritGroups.value = await fetchRepoInheritMembers(selectedRepo.value)
  }
  catch (err) {
    inheritGroups.value = [] // 失败降级空数组（行内错误提示）
    inheritError.value = err as Error
  }
  finally {
    inheritLoading.value = false
  }
}

// 展开时首次加载（空且不在加载中才请求；写操作后已缓存的直接复用）。
// immediate：默认展开的场景下挂载即判定一次（此刻仓库未定 → loadInherit
// 内部直接返回，真正的首载由下方 selectedRepo watch 驱动）
watch(inheritOpen, (value) => {
  if (value && inheritGroups.value.length === 0 && !inheritLoading.value) {
    void loadInherit() // 首次展开才请求（缓存命中直接展示）
  }
}, { immediate: true })

/** 有效成员（含继承）：复用 /list-members，展示在独立折叠区 */
const effectiveMembers = ref<MemberItem[]>([])
/** 有效成员加载中 */
const effectiveLoading = ref(false)
/** 有效成员折叠区开关：默认展开（与继承来源同一口径，随仓库自动加载） */
const effectiveOpen = ref(true)

/** 拉取有效成员（失败静默降级空列表：折叠区只显示空态文案） */
async function loadEffective() {
  // 未选仓库：不发请求
  if (!selectedRepo.value) {
    return
  }
  effectiveLoading.value = true // 有效成员区加载中
  try {
    effectiveMembers.value = await fetchAllMembers(selectedRepo.value)
  }
  catch {
    // 失败静默：这是辅助信息区，不打断主表格
    effectiveMembers.value = []
  }
  finally {
    effectiveLoading.value = false
  }
}// 展开时首次加载（同继承区口径，immediate 覆盖默认展开的挂载场景）
watch(effectiveOpen, (value) => {
  if (value && effectiveMembers.value.length === 0 && !effectiveLoading.value) {
    void loadEffective() // 首次展开才请求（缓存命中直接展示）
  }
}, { immediate: true })

// ---------------------------------------------------------------------------
// 生命周期：切组织 → 重拉仓库列表；切仓库 → 重拉成员并清缓存
// ---------------------------------------------------------------------------

// 切组织：仓库列表必重拉；权限/继承/有效成员缓存全部作废（新仓库未定）
watch(() => selectedGroup.value?.path, () => {
  permMap.value = {} // 权限缓存按仓库维度，切组织必须清
  permDenied.value = {}
  inheritGroups.value = []
  effectiveMembers.value = []
  void loadRepos() // 仓库列表按新组织重拉
}, { immediate: true })

// 切仓库：成员与全部辅助缓存重置；折叠区保持默认展开（用户要求），
// 展开状态下立即重载新仓库的继承/有效成员（不再等用户手动展开）
watch(selectedRepo, () => {
  permMap.value = {} // 新仓库的权限/成员与旧仓库毫无交集
  permDenied.value = {}
  inheritGroups.value = []
  effectiveMembers.value = []
  void loadMembers() // 直属成员列表按新仓库重拉
  if (inheritOpen.value) {
    void loadInherit() // 默认展开：随仓库切换自动加载
  }
  if (effectiveOpen.value) {
    void loadEffective()
  }
})
</script>

<template>
  <div class="flex flex-col gap-3">
    <!-- 仓库选择器：必须先选完整仓库路径（组织路径打仓库端点会 400） -->
    <div class="flex items-center gap-2 flex-wrap">
      <UIcon name="i-lucide-book-marked" class="size-4 text-dimmed" />
      <span class="text-sm text-muted">{{ t('repo.members.repoLabel') }}</span>
      <USelect
        :model-value="selectedRepo || undefined"
        :items="repoOptions"
        :disabled="reposLoading || repoOptions.length === 0"
        :placeholder="reposLoading ? t('members.outsidersRepoLoading') : t('members.outsidersRepoPlaceholder')"
        size="sm"
        class="w-80 max-w-full"
        @update:model-value="onRepoSelect"
      />
      <UButton
        v-if="canManage && selectedRepo"
        size="sm"
        color="primary"
        variant="soft"
        icon="i-lucide-user-plus"
        :label="t('repo.members.add')"
        @click="openAdd"
      />
      <UButton
        v-if="selectedRepo"
        size="sm"
        color="neutral"
        variant="outline"
        icon="i-lucide-shield-check"
        :loading="batchLoading"
        :label="t('repo.members.batchLoadPerms')"
        @click="loadAllPerms"
      />
    </div>

    <!-- 仓库列表加载失败（403/网络）：仅本区块降级 -->
    <StateAlert
      v-if="repoError"
      state="error"
      :error="repoError"
      :retry="loadRepos"
    />
    <!-- 组织下无仓库：明确引导，而不是"暂无成员" -->
    <StateAlert
      v-else-if="!reposLoading && repoOptions.length === 0"
      state="empty"
      :empty-text="t('members.outsidersNoRepo')"
      :empty-desc="t('members.outsidersNoRepoDesc')"
    />

    <template v-else-if="selectedRepo">
      <StateAlert v-if="loading" state="loading" loading-variant="list" />
      <StateAlert
        v-else-if="error"
        state="error"
        :error="error"
        :retry="loadMembers"
      />
      <StateAlert
        v-else-if="members.length === 0"
        state="empty"
        :empty-text="t('repo.members.empty')"
      />

      <!-- 成员表格 -->
      <div v-else class="flex flex-col gap-2">
        <div
          v-for="member in members"
          :key="member.username"
          class="flex items-center gap-3 px-4 py-3 rounded-lg border border-default"
        >
          <UAvatar :src="member.avatar" :alt="member.nickname" size="md" />
          <div class="min-w-0 flex-1">
            <p class="text-sm font-medium text-highlighted truncate">
              {{ member.nickname }}
              <span class="text-dimmed font-normal">@{{ member.username }}</span>
            </p>
            <p v-if="member.joinTime" class="text-xs text-dimmed">
              {{ t('members.joined', { time: member.joinTime }) }}
            </p>
          </div>

          <!-- 权限列：批量/逐人缓存 → 徽标；未加载 → 查看按钮；403 → 无权限 -->
          <UBadge
            v-if="permDisplay(member)"
            color="neutral"
            variant="subtle"
            size="sm"
            :label="permDisplay(member)"
          />
          <UBadge
            v-else-if="permDenied[member.username]"
            color="warning"
            variant="subtle"
            size="sm"
            :label="t('members.permDenied')"
          />
          <UButton
            v-else
            size="xs"
            color="neutral"
            variant="ghost"
            :loading="permLoading[member.username]"
            :label="t('members.viewPerm')"
            @click="loadPerm(member.username)"
          />

          <!-- 角色下拉：canManage 时渲染，失败回滚 -->
          <USelect
            v-if="canManage"
            :model-value="(member.accessLevel as MemberRole) || undefined"
            :items="roleItems"
            :disabled="roleUpdating[member.username]"
            :placeholder="t('members.write.roleUnknown')"
            size="xs"
            class="w-32"
            @update:model-value="(value: unknown) => onChangeRole(member, value)"
          />

          <UButton
            v-if="canManage"
            size="xs"
            color="error"
            variant="ghost"
            icon="i-lucide-user-minus"
            :aria-label="t('members.write.remove')"
            @click="askRemove(member)"
          />
        </div>
      </div>

      <!-- 有效成员（含继承）/ 继承来源：两个折叠区，展开才请求 -->
      <div class="flex flex-col gap-2 pt-2 border-t border-default">
        <div class="flex items-center gap-2">
          <UIcon name="i-lucide-users-round" class="size-4 text-muted" />
          <span class="text-sm font-medium text-highlighted">{{ t('repo.members.inheritTitle') }}</span>
          <UButton
            size="xs"
            color="neutral"
            variant="ghost"
            :icon="inheritOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
            :aria-label="t('repo.annotations.toggle')"
            class="ms-auto"
            @click="inheritOpen = !inheritOpen"
          />
        </div>
        <div v-if="inheritOpen" class="flex flex-col gap-2">
          <StateAlert v-if="inheritLoading" state="loading" loading-variant="plain" />
          <p v-else-if="inheritError" class="text-xs text-error">
            {{ (inheritError as Error).message }}
          </p>
          <p v-else-if="inheritGroups.length === 0" class="text-xs text-dimmed">
            {{ t('repo.members.inheritEmpty') }}
          </p>
          <div v-else class="flex flex-col gap-2">
            <section
              v-for="group in inheritGroups"
              :key="group.inheritPath"
              class="rounded-md border border-default p-2"
            >
              <p class="text-xs text-dimmed font-mono">
                {{ group.inheritPath }} · {{ group.total }}
              </p>
              <div class="flex flex-wrap gap-2 mt-1">
                <span
                  v-for="user in group.users"
                  :key="user.username"
                  class="text-xs text-muted"
                >{{ user.nickname }}（{{ user.accessLevel || '-' }}）</span>
              </div>
            </section>
          </div>
        </div>

        <div class="flex items-center gap-2">
          <UIcon name="i-lucide-users" class="size-4 text-muted" />
          <span class="text-sm font-medium text-highlighted">{{ t('repo.members.effectiveTitle') }}</span>
          <UButton
            size="xs"
            color="neutral"
            variant="ghost"
            :icon="effectiveOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
            :aria-label="t('repo.annotations.toggle')"
            class="ms-auto"
            @click="effectiveOpen = !effectiveOpen"
          />
        </div>
        <div v-if="effectiveOpen" class="flex flex-col gap-1">
          <p v-if="effectiveLoading" class="text-xs text-dimmed">
            {{ t('common.loading') }}
          </p>
          <p v-else-if="effectiveMembers.length === 0" class="text-xs text-dimmed">
            {{ t('repo.members.inheritEmpty') }}
          </p>
          <div v-else class="flex flex-wrap gap-2">
            <span
              v-for="user in effectiveMembers"
              :key="user.username"
              class="text-xs text-muted"
            >{{ user.nickname }}（{{ user.accessLevel || '-' }}）</span>
          </div>
        </div>
      </div>
    </template>

    <!-- 添加成员弹窗 -->
    <UModal v-model:open="addOpen" :title="t('repo.members.add')">
      <template #body>
        <div class="flex flex-col gap-3">
          <UFormField :label="t('members.write.addUsername')" required>
            <UInput v-model="addUsername" class="w-full" autocomplete="off" />
          </UFormField>
          <UFormField :label="t('members.write.addRole')">
            <USelect v-model="addRole" :items="roleItems" class="w-full" />
          </UFormField>
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
            :loading="adding"
            :disabled="!addUsername.trim()"
            :label="t('repo.members.add')"
            @click="submitAdd"
          />
        </div>
      </template>
    </UModal>

    <!-- 移除确认（输入用户名） -->
    <ConfirmDialog
      v-model:open="removeOpen"
      v-model:typed="removeTyped"
      :title="t('members.write.remove')"
      :desc="t('members.write.removeDesc')"
      :confirm-label="t('members.write.remove')"
      confirm-color="error"
      :loading="removing"
      :type-to-confirm="removeTarget?.username || ''"
      :type-to-confirm-label="t('members.write.removeTypeLabel', { username: removeTarget?.username || '' })"
      @confirm="confirmRemove"
    />
  </div>
</template>
