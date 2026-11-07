<script setup lang="ts">
/**
 * 仓库页 —— 侧边栏「仓库」菜单对应页面。
 *
 * 展示侧边栏 GroupsMenu 当前选中组织下的仓库列表（跟随组织切换联动）。
 * 内容由 HomeRepos 组件承载（卡片点击进应用内详情，右侧按钮外跳兜底）。
 *
 * 迁移说明：原 src/pages/repos.vue 原地迁至 src/pages/repos/index.vue，
 * 使 /repos 成为静态路由（优先级高于 catch-all /repos/:repoPath(.*)*），
 * 内容不变。
 */
import { useI18n } from 'vue-i18n'

// 页面标题随语言切换（layout.repos）
const { t } = useI18n()
</script>

<template>
  <UDashboardPanel id="repos">
    <template #header>
      <UDashboardNavbar :title="t('layout.repos')">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <!-- 组织仓库列表：数据与选中状态来自 useCnbAuth 共享的 selectedGroup -->
      <HomeRepos />
    </template>
  </UDashboardPanel>
</template>
