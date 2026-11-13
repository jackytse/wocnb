<script setup lang="ts">
/**
 * 通知面板（Home 页右上角铃铛图标点击打开）。
 *
 * 两个分区（自上而下）：
 * 1. **构建结果**：本应用自己的构建通知（useCnbBuildWatch 轮询产出）。
 *    CNB 没有推送通道，构建状态是本客户端轮询 + 快照比对得到的；
 *    条目点击跳转应用内仓库构建详情（/repos/<path>?tab=builds&sn=xxx）。
 * 2. **动态**：CNB Open API GET /users/{username}/activities?date=yyyyMM
 *    （用户动态，按类型分类：提交/合并请求/议题/代码评审/建仓/加组织）。
 *
 * 重要说明：CNB 目前没有独立的通知 API（OpenAPI 无 notification 端点，
 * CNB 网页端的通知拉取本身也是返回空数组的桩实现），因此"动态"分区以
 * "当前登录用户的本月动态"作为内容展示；构建通知则完全由本客户端生成。
 *
 * 加载时机：动态在面板打开时拉取（避免首页加载就发请求）；
 * 构建通知是轮询结果，常驻内存，打开面板时只做"标记已读"（清铃铛徽标）。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import {
  fetchCnbActivities,
  cnbUser,
  type CnbActivityItem,
} from '../composables/useCnbAuth'
import {
  buildNoticeFeed,
  markBuildNoticesRead,
  type BuildNotice,
} from '../composables/useCnbBuildWatch'
import { useDashboard } from '../composables/useDashboard'
import { formatRelativeTime, encodeRepoPathForRoute } from '../utils'

const { isNotificationsSlideoverOpen } = useDashboard()
// 界面文案翻译（面板标题随语言切换）
const { t } = useI18n()
const router = useRouter()

/** 动态条目列表 */
const activities = ref<CnbActivityItem[]>([])
/** 加载中状态（骨架屏） */
const loading = ref(false)
/** 加载失败标记（显示重试入口） */
const loadError = ref(false)

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
  loading.value = true
  loadError.value = false
  try {
    activities.value = await fetchCnbActivities(username, currentMonth())
  }
  catch {
    activities.value = []
    loadError.value = true
  }
  finally {
    loading.value = false
  }
}

// 面板打开时拉取最新动态（首次打开与每次重新打开都刷新），
// 同时清掉铃铛上的未读构建数（用户已经看到列表了）
watch(isNotificationsSlideoverOpen, (open) => {
  if (open) {
    markBuildNoticesRead()
    void loadActivities()
  }
})

/**
 * 构建状态徽标配色。
 * 遵循中文语境直觉：成功=绿色、失败=红色、取消=灰色、状态未知=中性。
 * （注意不要反过来：把失败标绿是这类通知最典型的事故）
 */
function statusColor(status: string): 'success' | 'error' | 'neutral' {
  switch (status) {
    case 'success':
      return 'success'
    case 'error':
      return 'error'
    default:
      // cancel 与 ''（状态未知）都用中性色
      return 'neutral'
  }
}

/** 构建状态文案（终态走既有 builds.status.* 文案，'' 为"状态未知"） */
function statusLabel(status: string): string {
  switch (status) {
    case 'success':
      return t('builds.status.success')
    case 'error':
      return t('builds.status.error')
    case 'cancel':
      return t('builds.status.cancel')
    default:
      return t('buildWatch.panel.statusUnknown')
  }
}

/** 相对时间：面板里的条目用"3 分钟前"比绝对时间更易读（复用全局工具函数） */
function timeLabel(time: number): string {
  if (!time) {
    return ''
  }
  return formatRelativeTime(new Date(time).toISOString())
}

/**
 * 仓库路径 -> 路由路径段：逐段 encodeURIComponent。
 *
 * 实现已抽到 src/utils/encodeRepoPathForRoute 全局共享（QA 缺陷 #7 的
 * 修复口径）：新增的"系统通知点击直达"是第二个消费方，编码规则属于
 * 跨模块契约，私有复制会让两处口径漂移，故这里只 import。
 */

/**
 * 点击构建通知：跳到该仓库的构建页签并展开对应构建。
 * 用 push（下钻语义）而非 replace，保证返回键能回到原页面。
 */
function openBuildNotice(notice: BuildNotice) {
  isNotificationsSlideoverOpen.value = false
  void router.push({
    path: `/repos/${encodeRepoPathForRoute(notice.repoPath)}`,
    query: { tab: 'builds', sn: notice.sn },
  })
}

/** 构建通知条目（最新在前；为空时展示空态文案） */
const notices = computed(() => buildNoticeFeed.value)
</script>

<template>
  <USlideover
    v-model:open="isNotificationsSlideoverOpen"
    :title="t('notifications.title')"
    :description="cnbUser ? t('notifications.monthlyDesc', { name: cnbUser.nickname }) : t('notifications.defaultDesc')"
  >
    <template #body>
      <div class="flex flex-col gap-6">
        <!-- —— 构建结果分区（本客户端轮询产出的通知）—— -->
        <section class="flex flex-col gap-2">
          <h3 class="text-sm font-semibold text-highlighted">
            {{ t('buildWatch.panel.sectionTitle') }}
          </h3>

          <p v-if="notices.length === 0" class="text-sm text-muted">
            {{ t('buildWatch.panel.empty') }}
          </p>

          <ul v-else class="flex flex-col gap-1">
            <li v-for="notice in notices" :key="notice.id">
              <button
                type="button"
                class="flex w-full items-start gap-3 rounded-md p-2 text-left hover:bg-elevated/60"
                @click="openBuildNotice(notice)"
              >
                <UBadge
                  :color="statusColor(notice.status)"
                  variant="subtle"
                  size="sm"
                  :label="statusLabel(notice.status)"
                  class="shrink-0"
                />
                <div class="min-w-0 flex-1">
                  <p class="text-sm font-medium text-highlighted truncate">
                    {{ notice.repoName }}
                  </p>
                  <p class="text-xs text-muted truncate">
                    <span v-if="notice.sourceRef">{{ notice.sourceRef }} · </span>{{ notice.commitTitle }}
                  </p>
                  <p class="text-xs text-dimmed">
                    {{ timeLabel(notice.time) }}
                    <span v-if="notice.leftover">· {{ t('buildWatch.panel.leftover') }}</span>
                  </p>
                </div>
              </button>
            </li>
          </ul>
        </section>

        <USeparator />

        <!-- —— 动态分区（CNB 用户动态）—— -->
        <section class="flex flex-col gap-2">
          <h3 class="text-sm font-semibold text-highlighted">
            {{ t('home.tabs.activities') }}
          </h3>
          <!-- 列表展示/空态/失败重试/点击跳转均由共享组件处理 -->
          <HomeActivityList
            :items="activities"
            :loading="loading"
            :load-error="loadError"
            @retry="loadActivities"
          />
        </section>
      </div>
    </template>
  </USlideover>
</template>
