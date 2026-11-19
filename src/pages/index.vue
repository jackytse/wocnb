<script setup lang="ts">
/**
 * Home 页 —— 应用首页。
 *
 * 页面主体为三个选项卡（动态 / 待办 / 我创建的）：
 * - 动态：当前用户本月动态（GET /users/{username}/activities）；
 * - 待办：分配给当前用户的开启中 Issue（GET /user/issues?filter=assigned）；
 * - 我创建的：当前用户创建的开启中 Issue（GET /user/issues?filter=created）。
 *
 * 懒加载策略：选项卡内容保持挂载（v-show 切换），首次激活时才拉取
 * 数据（避免首页加载就发三个请求，且切回选项卡不重复请求）。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { TabsItem } from '@nuxt/ui'
import {
  fetchCnbActivities,
  cnbUser,
  type CnbActivityItem,
} from '../composables/useCnbAuth'

// 通知入口（铃铛 + 未读徽标）已从本页 header 移到侧边栏左下角用户名旁
// （components/NotificationsButton.vue）—— 通知是全局能力，不该只在首页
// 露出。本页不再引用未读状态与面板开关。

// 页面文案随语言切换（computed 包裹保证热切换生效）
const { t } = useI18n()

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 选项卡
// ---------------------------------------------------------------------------

/** 当前激活的选项卡（value 与 tabItems 对应） */
const active = ref('activities')

/** 选项卡定义（label 随语言切换，用 computed 保证热切换生效） */
const tabItems = computed((): TabsItem[] => [{
  label: t('home.tabs.activities'),
  icon: 'i-lucide-activity',
  value: 'activities'
}, {
  label: t('home.tabs.todo'),
  icon: 'i-lucide-list-todo',
  value: 'todo'
}, {
  label: t('home.tabs.mine'),
  icon: 'i-lucide-user-pen',
  value: 'mine'
}])

// ---------------------------------------------------------------------------
// 「动态」选项卡数据（Issue 列表的数据加载在 HomeIssueList 内部处理）
// ---------------------------------------------------------------------------

/** 动态条目列表 */
const activities = ref<CnbActivityItem[]>([])
/** 加载中状态（骨架屏） */
const activitiesLoading = ref(false)
/** 加载失败标记（显示重试入口） */
const activitiesError = ref(false)
/** 是否已完成首次加载（懒加载只发生一次，切回选项卡不重复请求） */
const activitiesLoadedOnce = ref(false)

/** 当前月份（yyyyMM，CNB activities 接口的 date 参数格式） */
function currentMonth(): string {
  const now = new Date()
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`
}

/** 拉取本月动态（仅登录后执行） */
async function loadActivities() {
  const username = cnbUser.value?.username
  if (!username) {
    return
  }
  activitiesLoading.value = true
  activitiesError.value = false
  try {
    activities.value = await fetchCnbActivities(username, currentMonth())
    activitiesLoadedOnce.value = true
  }
  catch {
    activities.value = []
    activitiesError.value = true
  }
  finally {
    activitiesLoading.value = false
  }
}

// 「动态」选项卡首次激活时懒加载（immediate 覆盖默认激活的场景）
watch(active, (value) => {
  if (value === 'activities' && !activitiesLoadedOnce.value) {
    void loadActivities()
  }
}, { immediate: true })
</script>

<template>
  <UDashboardPanel id="home">
    <template #header>
      <UDashboardNavbar :title="t('home.title')" :ui="{ right: 'gap-3' }">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <!-- 三个选项卡：动态 / 待办 / 我创建的。
           内容保持挂载（v-show）+ 首次激活懒加载：切回选项卡不丢数据、
           不重复请求，也比 UTabs 默认卸载行为更平滑 -->
      <UTabs
        v-model="active"
        :items="tabItems"
        color="neutral"
        class="mb-4"
      />

      <div v-show="active === 'activities'">
        <HomeActivityList
          :items="activities"
          :loading="activitiesLoading"
          :load-error="activitiesError"
          @retry="loadActivities"
        />
      </div>
      <div v-show="active === 'todo'">
        <HomeIssueList filter="assigned" :active="active === 'todo'" />
      </div>
      <div v-show="active === 'mine'">
        <HomeIssueList filter="created" :active="active === 'mine'" />
      </div>
    </template>
  </UDashboardPanel>
</template>
