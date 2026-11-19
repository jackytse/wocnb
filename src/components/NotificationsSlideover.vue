<script setup lang="ts">
/**
 * 通知面板（侧边栏左下角铃铛 / 快捷键 N 打开）。
 * 铃铛入口见 components/NotificationsButton.vue（2026-11-18 从首页 header
 * 迁到用户名旁，所有页面常驻；侧边栏折叠时隐藏，快捷键仍可用）。
 *
 * 两个分区（自上而下）：
 * 1. **构建结果**：本应用自己的构建通知（useCnbBuildWatch 轮询产出）。
 *    CNB 没有推送通道，构建状态是本客户端轮询 + 快照比对得到的；
 *    条目点击跳转应用内仓库构建详情（/repos/<path>?tab=builds&sn=xxx）。
 * 2. **应用通知**：更新检测等应用级事件（useAppNotices），点击直达
 *    「设置 · 关于」页。
 *
 * 重要说明：CNB 目前没有独立的通知 API（OpenAPI 无 notification 端点，
 * CNB 网页端的通知拉取本身也是返回空数组的桩实现），构建通知完全由
 * 本客户端生成。曾经的"动态"分区（CNB 用户动态）已按用户要求移除 ——
 * 用户动态仍在首页展示（HomeActivityList + fetchCnbActivities）。
 *
 * 布局（2026-11-19 重设计）：分区标题 = 色底图标 + 标题 + 计数徽标；
 * 条目 = 卡片式（左侧状态色圆形图标容器 + 内容 + 右上相对时间），
 * 替代旧版"纯文本行 + 徽标"的松散排版；空态居中呈现。
 *
 * 加载时机：两个分区的数据都常驻内存（轮询/事件产物），打开面板时
 * 只做"标记已读"（清铃铛徽标），无网络请求。
 */
import { computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import {
  buildNoticeFeed,
  markBuildNoticesRead,
  type BuildNotice,
} from '../composables/useCnbBuildWatch'
import {
  appNoticeFeed,
  markAppNoticesRead,
} from '../composables/useAppNotices'
import { useDashboard } from '../composables/useDashboard'
import { formatRelativeTime, encodeRepoPathForRoute } from '../utils'

const { isNotificationsSlideoverOpen } = useDashboard()
// 界面文案翻译（面板标题随语言切换）
const { t } = useI18n()
const router = useRouter()

// 面板打开时清掉铃铛上的未读数（构建通知 + 应用通知两类都已展示给用户）
watch(isNotificationsSlideoverOpen, (open) => {
  if (open) {
    markBuildNoticesRead()
    markAppNoticesRead()
  }
})

/**
 * 构建状态 → 图标配色与图元。
 * 遵循中文语境直觉：成功=绿色对勾、失败=红色叉、取消/未知=灰色横线。
 * （注意不要反过来：把失败标绿是这类通知最典型的事故）
 */
function statusIcon(status: string): { color: 'success' | 'error' | 'neutral', icon: string } {
  switch (status) {
    case 'success':
      return { color: 'success', icon: 'i-lucide-check' }
    case 'error':
      return { color: 'error', icon: 'i-lucide-x' }
    default:
      // cancel 与 ''（状态未知）都用中性色
      return { color: 'neutral', icon: 'i-lucide-minus' }
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

/** 应用通知条目（最新在前；当前仅更新检测产生记录） */
const appNotices = computed(() => appNoticeFeed.value)

/**
 * 点击应用通知：直达「设置 · 关于」页（版本信息与「前往下载」入口都在那里）。
 * 与构建通知点击同为 push 下钻语义，返回键可回到原页面。
 * 目前应用通知点击目标统一为关于页（条目本身不含独立路由信息），
 * 因此不消费条目参数；未来 kind 扩展出各自目标时再按 notice 分流。
 */
function openAppNotice() {
  isNotificationsSlideoverOpen.value = false
  void router.push('/settings/about')
}
</script>

<template>
  <USlideover
    v-model:open="isNotificationsSlideoverOpen"
    :title="t('notifications.title')"
    :description="t('notifications.subtitle')"
  >
    <template #body>
      <div class="flex flex-col gap-6">
        <!-- ==================================================================
             分区 ①：构建结果（本客户端轮询产出的通知）
             布局：分区头（色底图标 + 标题 + 计数徽标）→ 卡片化条目列表 /
             居中空态。条目左侧圆形图标容器按构建结果着色，一眼区分成败。
             ================================================================== -->
        <section class="flex flex-col gap-2.5">
          <!-- 分区头 -->
          <div class="flex items-center gap-2">
            <span class="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/10">
              <UIcon name="i-lucide-hammer" class="size-3.5 text-primary" />
            </span>
            <h3 class="text-sm font-semibold text-highlighted">
              {{ t('buildWatch.panel.sectionTitle') }}
            </h3>
            <UBadge
              :label="String(notices.length)"
              size="sm"
              variant="subtle"
              :color="notices.length > 0 ? 'primary' : 'neutral'"
              class="ms-auto"
            />
          </div>

          <!-- 空态：居中弱化呈现，不打断分区节奏 -->
          <div
            v-if="notices.length === 0"
            class="flex flex-col items-center gap-1.5 rounded-lg border border-dashed border-default py-6"
          >
            <UIcon name="i-lucide-bell-off" class="size-5 text-dimmed" />
            <p class="text-xs text-muted">
              {{ t('buildWatch.panel.empty') }}
            </p>
          </div>

          <!-- 条目列表：卡片式，状态色图标容器 + 内容 + 右上时间 -->
          <ul v-else class="flex flex-col gap-2">
            <li v-for="notice in notices" :key="notice.id">
              <button
                type="button"
                class="group flex w-full items-start gap-3 rounded-lg border border-default bg-elevated/40 p-3 text-left transition-colors hover:bg-elevated hover:ring hover:ring-default"
                @click="openBuildNotice(notice)"
              >
                <!-- 状态图标容器：success=绿勾 / error=红叉 / 其他=灰横线 -->
                <span
                  class="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full"
                  :class="{
                    'bg-success/15 text-success': statusIcon(notice.status).color === 'success',
                    'bg-error/15 text-error': statusIcon(notice.status).color === 'error',
                    'bg-neutral/15 text-muted': statusIcon(notice.status).color === 'neutral',
                  }"
                >
                  <UIcon :name="statusIcon(notice.status).icon" class="size-4" />
                </span>

                <span class="min-w-0 flex-1 flex flex-col gap-0.5">
                  <span class="flex items-center gap-2 min-w-0">
                    <!-- 状态词 + 仓库名同行；时间推到行尾 -->
                    <span
                      class="text-xs font-medium shrink-0"
                      :class="{
                        'text-success': statusIcon(notice.status).color === 'success',
                        'text-error': statusIcon(notice.status).color === 'error',
                        'text-muted': statusIcon(notice.status).color === 'neutral',
                      }"
                    >{{ statusLabel(notice.status) }}</span>
                    <span class="text-sm font-medium text-highlighted truncate min-w-0">
                      {{ notice.repoName }}
                    </span>
                    <span class="text-xs text-dimmed ms-auto shrink-0">
                      {{ timeLabel(notice.time) }}
                    </span>
                  </span>
                  <span class="text-xs text-muted truncate">
                    <span v-if="notice.sourceRef" class="font-mono">{{ notice.sourceRef }}</span>
                    <span v-if="notice.sourceRef"> · </span>{{ notice.commitTitle }}
                  </span>
                  <span
                    v-if="notice.leftover"
                    class="text-xs text-dimmed"
                  >{{ t('buildWatch.panel.leftover') }}</span>
                </span>
              </button>
            </li>
          </ul>
        </section>

        <USeparator />

        <!-- ==================================================================
             分区 ②：应用通知（更新检测等应用级事件）
             布局与分区 ① 完全同构（info 色系），保持两分区视觉一致。
             ================================================================== -->
        <section class="flex flex-col gap-2.5">
          <!-- 分区头 -->
          <div class="flex items-center gap-2">
            <span class="flex size-6 shrink-0 items-center justify-center rounded-md bg-info/10">
              <UIcon name="i-lucide-rocket" class="size-3.5 text-info" />
            </span>
            <h3 class="text-sm font-semibold text-highlighted">
              {{ t('notifications.updatesSection') }}
            </h3>
            <UBadge
              :label="String(appNotices.length)"
              size="sm"
              variant="subtle"
              :color="appNotices.length > 0 ? 'info' : 'neutral'"
              class="ms-auto"
            />
          </div>

          <!-- 空态：居中弱化呈现 -->
          <div
            v-if="appNotices.length === 0"
            class="flex flex-col items-center gap-1.5 rounded-lg border border-dashed border-default py-6"
          >
            <UIcon name="i-lucide-inbox" class="size-5 text-dimmed" />
            <p class="text-xs text-muted">
              {{ t('notifications.updatesEmpty') }}
            </p>
          </div>

          <!-- 条目列表：与构建通知同构（info 色系） -->
          <ul v-else class="flex flex-col gap-2">
            <li v-for="notice in appNotices" :key="notice.id">
              <button
                type="button"
                class="group flex w-full items-start gap-3 rounded-lg border border-default bg-elevated/40 p-3 text-left transition-colors hover:bg-elevated hover:ring hover:ring-default"
                @click="openAppNotice()"
              >
                <!-- 应用通知统一 info 色圆形图标容器 -->
                <span class="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-info/15 text-info">
                  <UIcon name="i-lucide-arrow-up-circle" class="size-4" />
                </span>

                <span class="min-w-0 flex-1 flex flex-col gap-0.5">
                  <span class="flex items-center gap-2 min-w-0">
                    <span class="text-sm font-medium text-highlighted truncate min-w-0">
                      {{ notice.title }}
                    </span>
                    <span class="text-xs text-dimmed ms-auto shrink-0">
                      {{ timeLabel(notice.time) }}
                    </span>
                  </span>
                  <span class="text-xs text-muted line-clamp-2">{{ notice.body }}</span>
                </span>
              </button>
            </li>
          </ul>
        </section>
      </div>
    </template>
  </USlideover>
</template>
