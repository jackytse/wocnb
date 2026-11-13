<script setup lang="ts">
/**
 * 组织页 —— 侧边栏「组织」（layout.group / Group）菜单对应页面，路由 /group。
 *
 * 页签结构（2026-11-11 第二轮组织能力扩展，沿用仓库页的 `?tab=` 约定）：
 * - overview（默认，URL 不带 tab）：概览卡 + 本月用量 + 仓库墙 + 子组织网格；
 * - settings：组织信息编辑 + 安全策略（33 个 SettingValue 开关）+ 危险区；
 * - protections：组织保护分支规则 CRUD（仅根组织生效）。
 *
 * 三个页签都是**独立加载独立降级**：任一区块 403 只影响自身（如仓库墙缺
 * group-manage:r 仅该区块降级），不会让整页白屏。
 *
 * slug 下钻语义（验收 3）：子组织点击 → /group?slug={path}，本页读取
 * slug 并**同步 selectedGroup**（与侧边栏 GroupsMenu 同一状态源，成员页/
 * 仓库页随联动刷新）。selectedGroup 变化（GroupsMenu 切换）时反向清除
 * slug query，保持双向一致 —— 但**保留当前 tab**（否则切组织会把用户
 * 从「设置」页签踢回概览页，体验上像被重置）。
 *
 * 路由沿革：本页原名 pages/org.vue（路由 /org），术语统一为 Group 后
 * 改为 pages/group.vue；旧链接 /org 由 main.ts 的 legacy-org 路由记录
 * 永久重定向到 /group，见 main.ts 的注释说明。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import type { TabsItem } from '@nuxt/ui'
import {
  canManageRole,
  selectedGroup,
  type CnbGroup,
} from '../composables/useCnbAuth'
import { fetchOrgOverview, type OrgOverview } from '../composables/useCnbOrg'
import OrgOverviewCard from '../components/org/OrgOverviewCard.vue'
import OrgUsageCard from '../components/org/OrgUsageCard.vue'
import PinnedRepoWall from '../components/org/PinnedRepoWall.vue'
import SubGroupGrid from '../components/org/SubGroupGrid.vue'
import OrgSettingsTab from '../components/org/OrgSettingsTab.vue'
import OrgProtectionsTab from '../components/org/OrgProtectionsTab.vue'
import CreateGroupModal from '../components/org/CreateGroupModal.vue'
import StateAlert from '../components/repo/StateAlert.vue'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()

/** 组织页页签取值（overview 为默认值，URL 中省略以保持链接干净） */
type OrgTab = 'overview' | 'settings' | 'protections'

/** 当前生效组织路径（selectedGroup 为唯一状态源） */
const slug = computed(() => selectedGroup.value?.path || '')

/** URL slug（子组织下钻） */
const slugQuery = computed(() =>
  typeof route.query.slug === 'string' && route.query.slug ? route.query.slug : '',
)

/**
 * 当前页签：从 URL 读取，非法值一律回落到 overview。
 * 用 computed 而非 ref，保证「浏览器后退 / 手改 URL」也能正确切页签。
 */
const tab = computed<OrgTab>(() => {
  const raw = route.query.tab
  return raw === 'settings' || raw === 'protections' ? raw : 'overview'
})

/** 页签定义（UTabs 受控模式） */
const tabItems = computed((): TabsItem[] => [
  { label: t('org.tabs.overview'), icon: 'i-lucide-layout-dashboard', value: 'overview' },
  { label: t('org.tabs.settings'), icon: 'i-lucide-settings-2', value: 'settings' },
  { label: t('org.tabs.protections'), icon: 'i-lucide-shield-check', value: 'protections' },
])

/**
 * 构造目标 query：overview 不写 tab（保持 /group 与 /group?slug=x 的原样），
 * slug 原样保留（切页签不丢当前下钻组织）。
 */
function buildQuery(nextTab: OrgTab): Record<string, string> {
  const query: Record<string, string> = {}
  if (slugQuery.value) {
    query.slug = slugQuery.value
  }
  if (nextTab !== 'overview') {
    query.tab = nextTab
  }
  return query
}

/** 切换页签（replace：不往历史栈里塞页签切换记录，后退仍按页面粒度回退） */
function switchTab(value: string | number) {
  const next: OrgTab = (value === 'settings' || value === 'protections') ? value : 'overview'
  void router.replace({ path: '/group', query: buildQuery(next) })
}

/**
 * slug 下钻同步（验收 3）：URL slug 与 selectedGroup 不一致时，拉取该
 * 组织概览并写入 selectedGroup（GroupsMenu/成员页/仓库页随之联动）。
 * 概览拉取失败仍同步基本信息（path 兜底），保证下钻不白屏。
 *
 * ⚠️ access_role 必须从概览接口带过来（dto.OrganizationAccess 含该字段）。
 * 早期实现硬编码空串，导致子组织下钻后 canManage 恒为 false ——
 * 用户对自己的子组织三个页签全部只读（2026-11-11 QA 回归抓到的 P1）。
 */
const resolving = ref(false)

watch(slugQuery, async (value) => {
  if (!value || value === selectedGroup.value?.path) {
    return
  }
  // 解析期间显示骨架而非「请先选择组织」空态（深链刷新时不会闪一下空页）
  resolving.value = true
  try {
    const overview = await fetchOrgOverview(value)
    const group: CnbGroup = {
      id: value,
      name: overview.name,
      path: overview.path,
      description: overview.description,
      member_count: overview.memberCount,
      all_sub_repo_count: overview.allSubRepoCount,
      sub_group_count: overview.subGroupCount,
      // 用户在该组织的角色：决定设置/保护分支/成员写入口是否出现
      access_role: overview.accessRole,
    }
    selectedGroup.value = group
  }
  catch {
    // 概览拉取失败（403/404）：仍同步 path，页面各区块各自降级；
    // 角色置空 → 写入口隐藏（403 兜底仍在），等用户有权限时再出现
    selectedGroup.value = {
      id: value,
      name: value,
      path: value,
      description: '',
      member_count: 0,
      all_sub_repo_count: 0,
      access_role: '',
    }
  }
  finally {
    resolving.value = false
  }
}, { immediate: true })

// GroupsMenu 切换组织（selectedGroup 变化且与 URL slug 不一致）→ 清 slug，
// 但保留 tab：用户正在看「设置」时切组织，期望停留在这个页签换组织看。
//
// 注意这里**不能复用 buildQuery** —— 它会把旧 slug 原样写回，replace 变成
// no-op，URL 与状态就不一致了（刷新/复制链接会回到旧组织）。这是 QA 回归
// 抓到的 P1，别再改回去。
watch(() => selectedGroup.value?.path, (value) => {
  if (slugQuery.value && value && slugQuery.value !== value) {
    void router.replace({
      path: '/group',
      query: tab.value === 'overview' ? {} : { tab: tab.value },
    })
  }
})

/** 是否有组织管理权限（仓库墙编辑入口 / 设置页写入口 / 新建子组织入口） */
const canManage = computed(() => canManageRole(selectedGroup.value?.access_role))

// ---------------------------------------------------------------------------
// 概览（GET /{group}，独立降级：失败回退 selectedGroup 概要字段）
// ---------------------------------------------------------------------------

const overview = ref<OrgOverview | null>(null)
const overviewLoading = ref(false)

async function loadOverview() {
  if (!slug.value) {
    overview.value = null
    return
  }
  overviewLoading.value = true
  try {
    overview.value = await fetchOrgOverview(slug.value)
  }
  catch {
    // 403（缺 group-resource:r）/失败：回退 selectedGroup 概要展示，
    // 不阻塞仓库墙/子组织区块
    overview.value = null
  }
  finally {
    overviewLoading.value = false
  }
}

watch(slug, () => void loadOverview(), { immediate: true })

/** 概览 403 时的回退展示数据（来自 /user/groups 概要字段；缺失显示 —） */
const fallbackOverview = computed<OrgOverview | null>(() => {
  const group = selectedGroup.value
  if (!group) {
    return null
  }
  return {
    name: group.name,
    path: group.path,
    description: group.description,
    memberCount: group.member_count ?? 0,
    allMemberCount: group.all_member_count ?? group.member_count ?? 0,
    subGroupCount: group.sub_group_count ?? 0,
    allSubRepoCount: group.all_sub_repo_count ?? 0,
    // /user/groups 的 follow_count 缺省为 undefined → -1（「—」）
    followCount: typeof group.follow_count === 'number' ? group.follow_count : -1,
    site: group.site || '',
    updatedAt: group.updated_at || '',
    // 回退数据来自 /user/groups（CnbGroup 概要），本身带 access_role ——
    // 缺它会导致概览接口偶发失败时写入口误隐藏
    accessRole: group.access_role || '',
    // CnbGroup 未承载以下 5 个字段：概览接口失败时信息表单回填为空，
    // 用户仍可填写（增量提交语义保证不会误清空服务端已有值）
    email: '',
    domain: '',
    remark: '',
    wechatMp: '',
    readmeRepoPath: '',
  }
})

/** 子组织数（优先概览接口，回退 selectedGroup；控制子组织网格显隐） */
const subGroupCount = computed(() =>
  overview.value?.subGroupCount ?? selectedGroup.value?.sub_group_count ?? 0,
)

/** 子组织点击：进下级组织（slug 写入 URL，selectedGroup 由上方 watch 同步） */
function onSelectSubGroup(path: string) {
  void router.push({ path: '/group', query: { slug: path, ...(tab.value === 'overview' ? {} : { tab: tab.value }) } })
}

// ---------------------------------------------------------------------------
// 新建子组织（POST /groups，path 预填 {当前组织}/）
// ---------------------------------------------------------------------------

const createOpen = ref(false)

/**
 * 创建成功后跳转到新组织。
 *
 * 为什么必须写 `?slug=新路径`：CreateGroupModal 已把 selectedGroup 设成新组织，
 * 若 URL 还停在父组织，刷新后会跳回父组织（URL 与状态不一致）。写入 slug 后
 * 上方的 slugQuery watch 会发现「已相等」直接返回，不会重复拉概览。
 */
function onCreateGroup(path: string) {
  void router.replace({ path: '/group', query: { slug: path } })
}
</script>

<template>
  <!-- 面板持久化 id 刻意保留旧值 "org"：UDashboardGroup 以 storage="local"
       持久化面板尺寸，key 形如 `<storageKey>-panel-org`；改成 "group" 会让
       老用户已保存的布局静默失效。该 id 仅用于 localStorage 与 aria-controls，
       不出现在用户可见文案中，故不属本次术语统一范围（设计 §4.5）。 -->
  <UDashboardPanel id="org">
    <template #header>
      <UDashboardNavbar :title="t('layout.group')">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #right>
          <UBadge
            v-if="slug"
            color="neutral"
            variant="subtle"
            :label="slug"
            class="font-mono"
          />
          <!-- 新建子组织：仅在有管理权限时出现（写入口事前隐藏，不做事后报错） -->
          <UButton
            v-if="slug && canManage"
            icon="i-lucide-folder-plus"
            color="neutral"
            variant="outline"
            size="xs"
            :label="t('org.createGroup.entry')"
            @click="createOpen = true"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <!-- 未选组织：slug 下钻解析中先显示骨架，避免深链刷新时闪一下空态 -->
      <StateAlert
        v-if="!slug && resolving"
        state="loading"
        loading-variant="list"
      />
      <StateAlert
        v-else-if="!slug"
        state="empty"
        :empty-text="t('org.noGroup')"
      />

      <div
        v-else
        class="flex flex-col gap-6"
      >
        <!-- 页签：概览 / 设置 / 保护分支 -->
        <UTabs
          :model-value="tab"
          :items="tabItems"
          color="neutral"
          @update:model-value="switchTab"
        />

        <!-- 概览：原有四个区块，保持「独立加载独立降级」的既有语义 -->
        <template v-if="tab === 'overview'">
          <OrgOverviewCard
            :overview="overview || fallbackOverview"
            :loading="overviewLoading"
          />

          <OrgUsageCard :slug="slug" />

          <PinnedRepoWall
            :slug="slug"
            mode="manage"
            :can-manage="canManage"
          />

          <SubGroupGrid
            :slug="slug"
            :sub-group-count="subGroupCount"
            @select="onSelectSubGroup"
          />
        </template>

        <!-- 设置：组织信息 / 安全策略 / 危险区（组件内部自闭环加载与降级） -->
        <OrgSettingsTab
          v-else-if="tab === 'settings'"
          :slug="slug"
          :can-manage="canManage"
        />

        <!-- 保护分支：仅根组织生效，子组织由组件内部给引导 -->
        <OrgProtectionsTab
          v-else
          :slug="slug"
          :can-manage="canManage"
        />
      </div>

      <!-- 弹窗必须放在 UDashboardPanel 内部：DashboardPanel 用「默认 <slot>
           包裹 header/body 命名插槽」渲染，页面根节点多一个兄弟节点会导致
           命名插槽被整体丢弃（仓库页踩过，页面白屏） -->
      <CreateGroupModal
        v-model:open="createOpen"
        :parent-path="slug"
        @created="onCreateGroup"
      />
    </template>
  </UDashboardPanel>
</template>
