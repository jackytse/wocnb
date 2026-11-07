<script setup lang="ts">
/**
 * 组织页 —— 侧边栏「组织」（layout.group / Group）菜单对应页面，路由 /group。
 *
 * 展示侧边栏 GroupsMenu 当前选中组织的基本信息、统计信息与本月用量
 * （跟随组织切换联动）。内容由 HomeGroupOverview 组件承载（该组件
 * 原位于首页，现移至本页独立展示；组件内部：组织信息卡 / 统计卡 /
 * 逐资源用量进度条，数据来自 CNB Open API 的 charge/volume 与
 * charge/quota 端点）。
 *
 * 路由沿革：本页原名 pages/org.vue（路由 /org），术语统一为 Group 后
 * 改为 pages/group.vue；旧链接 /org 由 main.ts 的 legacy-org 路由记录
 * 永久重定向到 /group，见 main.ts 的注释说明。
 */
import { useI18n } from 'vue-i18n'

// 页面标题随语言切换（layout.group）
const { t } = useI18n()
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
      </UDashboardNavbar>
    </template>

    <template #body>
      <!-- 组织概览：数据与选中状态来自 useCnbAuth 共享的 selectedGroup -->
      <HomeGroupOverview />
    </template>
  </UDashboardPanel>
</template>
