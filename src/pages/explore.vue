<script setup lang="ts">
/**
 * 探索页（T15）：公共仓库搜索 + 仓库排行榜，路由 /explore。
 *
 * 两区块独立加载独立降级。?q= 支持 ⌘K「跳转探索页」动作项带入关键词
 * （验收 5）—— 命令面板**只带跳转动作**，远程搜索不进面板（R14：
 * 会破坏 useOverlayUnlockGuard 守护的弹层生命周期，整窗点不动）。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import ExploreRepoSearch from '../components/explore/ExploreRepoSearch.vue'
import ExploreRankList from '../components/explore/ExploreRankList.vue'

const { t } = useI18n()
const route = useRoute()

/** ⌘K 带入的关键词（?q=，一次性用作初始值触发搜索） */
const initialQuery = computed(() =>
  typeof route.query.q === 'string' && route.query.q ? route.query.q : '',
)
</script>

<template>
  <UDashboardPanel id="explore">
    <template #header>
      <UDashboardNavbar :title="t('layout.explore')">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <!-- 宽屏左右分栏（搜索 | 榜单），窄屏上下堆叠：搜索结果 30 条全量
           展示曾把榜单挤到一屏之外，改为两栏后互不挤占文档流 -->
      <div class="grid grid-cols-1 xl:grid-cols-2 gap-6 items-start">
        <!-- 公共仓库搜索（300ms 防抖 / topN / 无分页） -->
        <ExploreRepoSearch :initial-key="initialQuery" />

        <!-- 仓库排行榜（日/周/年 + 语言筛选） -->
        <ExploreRankList />
      </div>
    </template>
  </UDashboardPanel>
</template>
