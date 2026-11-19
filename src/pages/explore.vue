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
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
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

/**
 * 斜线（/）快捷打开搜索弹窗（入口按钮右侧徽标承诺的交互）。
 * 输入框/文本域聚焦时不接管 —— 正在输入的"/"保持原语义（比如在
 * 排行榜筛选、搜索框里打字不会误触弹窗）。
 * 为什么不用 Enter：Enter 语义太泛（页面任意位置回车都弹窗，容易误触），
 * "/" 是代码搜索的通用惯例（GitHub / GitLab / Jira 同款），误触率低。
 */
function onGlobalKeydown(e: KeyboardEvent) {
  if (e.key !== '/') {
    return
  }
  const target = e.target as HTMLElement | null
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
    return
  }
  // preventDefault：拦下浏览器默认行为（Firefox 的快速查找），
  // 避免按 / 时同时弹出浏览器的查找栏
  e.preventDefault()
  searchOpen.value = true
}

onMounted(() => window.addEventListener('keydown', onGlobalKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKeydown))
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
      <div class="flex flex-col gap-4">
        <!-- 搜索入口在文档流中：仿真输入框样式（全宽、placeholder 文案、
             右侧 kbd 风格的斜线提示），点击打开搜索弹窗 —— 比孤立按钮
             更贴合"搜索"的视觉预期 -->
        <button
          type="button"
          class="w-full flex items-center gap-2.5 rounded-md ring ring-default bg-elevated px-3 py-2 text-sm text-dimmed hover:bg-elevated/70 hover:text-muted transition-colors cursor-pointer"
          :aria-label="t('explore.search.title')"
          @click="searchOpen = true"
        >
          <UIcon name="i-lucide-search" class="size-4 shrink-0" />
          <span class="flex-1 text-left truncate">{{ t('explore.search.placeholder') }}</span>
          <UBadge
            color="neutral"
            variant="subtle"
            size="sm"
            class="font-mono shrink-0"
            label="/"
          />
        </button>

        <!-- 页面主体只有排行榜（日/周/年 + 语言筛选），不再被搜索结果挤占 -->
        <ExploreRankList />
      </div>

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
