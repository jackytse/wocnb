<script setup lang="ts">
/**
 * 仓库页 —— 侧边栏「仓库」菜单对应页面。
 *
 * 展示侧边栏 GroupsMenu 当前选中组织下的仓库列表（跟随组织切换联动）。
 * 内容由 HomeRepos 组件承载（卡片点击进应用内详情，右侧按钮外跳兜底）。
 *
 * 本次增量（T05 / REQ-A6，P0）：右上「新建仓库」按钮 + ReposCreateModal
 * （组织取当前 selectedGroup；201 后跳转新仓库详情页）。
 * 写入口权限预判：仅组织权限 Master/Owner 可见可用（group-resource:rw 的
 * 常见持有角色）——权限不足时按钮**置灰 + tooltip 注明所需 scope**
 * （事前隐藏优于事后 403，§8.2）；403 仍作兜底，绝不登出。
 *
 * 迁移说明：原 src/pages/repos.vue 原地迁至 src/pages/repos/index.vue，
 * 使 /repos 成为静态路由（优先级高于 catch-all /repos/:repoPath(.*)*）。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import ReposCreateModal from '../../components/ReposCreateModal.vue'
import { canManageRole, selectedGroup } from '../../composables/useCnbAuth'

const { t } = useI18n()

/** 创建仓库弹窗开关 */
const createOpen = ref(false)

/**
 * 是否可创建仓库：组织权限角色 ∈ {Master, Owner}（判定单点实现 §8.2）。
 * 假设说明：group-resource:rw 在 CNB 的角色映射与仓库 canManage 一致
 * （Master/Owner），Developer 及以下一律置灰 —— 若实测 Developer 也可
 * 创建，放宽此处即可（403 兜底仍在）。
 */
const canCreate = computed(() => canManageRole(selectedGroup.value?.access_role))

/**
 * 置灰按钮的 tooltip 三态（架构师 UX 边界修正）：
 * 未选组织 ≠ 无权限 —— 前者引导去侧边栏选组织，后者才提示 scope 不足，
 * 避免用户误以为要去翻令牌设置；可创建时不显示 tooltip。
 */
const createTooltip = computed(() => {
  if (!selectedGroup.value) {
    return t('repos.create.noGroup')
  }
  return canCreate.value ? '' : t('repos.create.noPermission')
})
</script>

<template>
  <UDashboardPanel id="repos">
    <template #header>
      <UDashboardNavbar :title="t('layout.repos')">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #right>
          <!-- 新建仓库（REQ-A6）：三态 tooltip（未选组织/无权限/可用）+ 置灰 -->
          <UTooltip :text="createTooltip">
            <UButton
              size="sm"
              color="primary"
              variant="soft"
              icon="i-lucide-plus"
              :label="t('repos.create.button')"
              :disabled="!canCreate"
              @click="createOpen = true"
            />
          </UTooltip>
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <!-- 组织仓库列表：数据与选中状态来自 useCnbAuth 共享的 selectedGroup -->
      <HomeRepos />

      <!-- 创建仓库弹窗（成功后跳转新仓库详情，返回时列表自动重拉）。
           ⚠️ 必须留在 UDashboardPanel **内部**：Nuxt UI 的 DashboardPanel 以
           「默认 slot 包裹 header/body 命名插槽」的方式渲染，页面模板一旦出现
           第二个根节点（例如把弹窗与面板并列为兄弟节点），命名插槽会被整体丢弃
           —— 表现为侧边栏正常、内容区完全空白（2026-11-11 定位的真实事故）。
           UModal 自身走 teleport 挂到 body，放在这里不影响面板布局。 -->
      <ReposCreateModal v-model:open="createOpen" />
    </template>
  </UDashboardPanel>
</template>
