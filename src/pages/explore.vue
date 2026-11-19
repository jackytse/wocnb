<script setup lang="ts">
/**
 * 探索页（T15）：公共仓库搜索 + 仓库排行榜，路由 /explore。
 *
 * 布局演进（用户反馈驱动）：搜索区从"页面内卡片"改为**弹窗** ——
 * 30~100 条搜索结果曾把榜单挤到一屏之外，也占掉整页文档流；改弹窗后
 * 页面只保留排行榜，搜索入口常驻导航栏。?q= 支持 ⌘K「跳转探索页」动作
 * 项带入关键词（验收 5）—— 命令面板**只带跳转动作**，远程搜索不进面板
 * （R14：会破坏 useOverlayUnlockGuard 守护的弹层生命周期，整窗点不动），
 * 跳到本页后自动打开搜索弹窗，把关键词交给弹窗内的组件承接。
 */
import { computed, ref } from 'vue'
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

/** 搜索弹窗开关：⌘K 带入关键词时自动打开（组件收到 initialKey 直接出结果） */
const searchOpen = ref(!!initialQuery.value)
</script>

<template>
  <UDashboardPanel id="explore">
    <template #header>
      <UDashboardNavbar :title="t('layout.explore')">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #right>
          <!-- 搜索入口常驻导航栏：弹窗承载完整搜索 UI（输入 + topN + 结果） -->
          <UButton
            icon="i-lucide-search"
            :label="t('explore.search.open')"
            color="primary"
            variant="soft"
            @click="searchOpen = true"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <!-- 页面主体只有排行榜（日/周/年 + 语言筛选），不再被搜索结果挤占 -->
      <ExploreRankList />

      <!-- 公共仓库搜索弹窗（300ms 防抖 / topN / 无分页，组件逻辑不变）；
           限宽 2xl：结果列表自身限高内滚，弹窗不会被撑满全屏 -->
      <UModal
        v-model:open="searchOpen"
        :title="t('explore.search.title')"
        :ui="{ content: 'max-w-2xl' }"
      >
        <template #body>
          <ExploreRepoSearch :initial-key="initialQuery" />
        </template>
      </UModal>
    </template>
  </UDashboardPanel>
</template>
