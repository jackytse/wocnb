<script setup lang="ts">
/**
 * 构建历史列表（PRD P0-D1）。
 *
 * 字段：状态徽标 / sn / commitTitle / nickName / sourceRef / event /
 * duration（人类可读）/ createTime；status 筛选（pending/success/error/cancel）。
 * 空态带引导文案（"推送代码后会出现在这里"）。
 *
 * 本次增量（T04）：顶部「触发构建」按钮（BuildTriggerModal）；触发成功后
 * 重拉列表并高亮新 sn 行 3s。归档仓库（archived）时按钮禁用（写入口统一
 * 按 detail.archived 禁用，§8.5 / R4）。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { fetchBuildLogs, repoSiteUrl, type BuildLogItem } from '../../composables/useCnbRepo'
import { useRepoRoute } from '../../composables/useRepoRoute'
import { formatDateTime, formatDuration } from '../../utils'
import StateAlert from './StateAlert.vue'
import BuildTriggerModal from './BuildTriggerModal.vue'

const props = defineProps<{
  repoPath: string
  /** 归档仓库：写入口（触发构建）禁用 */
  archived?: boolean
}>()

const { t } = useI18n()
const { state, page, setState, setPage, openBuild } = useRepoRoute()

const PAGE_SIZE = 30

/**
 * 「全部状态」在下拉里的哨兵值。
 *
 * 为什么不用空串（踩坑记录，2026-10-27）：Nuxt UI 的 USelect 底层是 Reka UI，
 * 其 SelectItem 明确禁止 `value` 为空字符串（空串被保留给"未选中 / 显示
 * placeholder"语义），一旦 items 里出现 `value: ''`，渲染期会直接抛
 * "A <SelectItem /> must have a value prop that is not an empty string"，
 * 该异常发生在 Tabs 内容的 watcher 渲染阶段 → 整块内容渲染中断，页面表现为
 * "点击 Builds 后卡住 / 空白"。因此这里用 'all' 作为哨兵，URL query 里仍然
 * 不写 state（哨兵只在组件内部流转）。
 */
const STATUS_ALL = 'all'

/** 状态下拉选项允许的取值集合（不含哨兵） */
const STATUS_VALUES = ['pending', 'success', 'error', 'cancel']

/** 状态筛选（哨兵 STATUS_ALL 表示不过滤；非法值同样归一为哨兵） */
const currentStatus = computed(() => {
  const value = state.value
  return STATUS_VALUES.includes(value) ? value : STATUS_ALL
})

/** 状态筛选下拉选项（value 一律非空，见 STATUS_ALL 注释） */
const statusItems = computed(() => [
  { label: t('builds.statusAll'), value: STATUS_ALL },
  { label: t('builds.status.pending'), value: 'pending' },
  { label: t('builds.status.success'), value: 'success' },
  { label: t('builds.status.error'), value: 'error' },
  { label: t('builds.status.cancel'), value: 'cancel' },
])

/**
 * 下拉变更 → 写回 query。
 * 哨兵还原为空串（useRepoRoute.setState('') 会删除 state 参数），
 * 保证 URL 里不出现 `state=all` 这种无意义参数。
 */
function onStatusChange(value: string | number) {
  const next = String(value)
  setState(next === STATUS_ALL ? '' : next)
}

const items = ref<BuildLogItem[]>([])
const total = ref(0)
const loading = ref(false)
const error = ref<Error | null>(null)
const hasNext = computed(() => page.value * PAGE_SIZE < total.value)

async function load() {
  if (!props.repoPath) {
    return
  }
  loading.value = true
  error.value = null
  try {
    const result = await fetchBuildLogs(props.repoPath, {
      // 哨兵不参与请求：不传 status 即"全部状态"
      status: currentStatus.value === STATUS_ALL ? undefined : currentStatus.value,
      page: page.value,
      pageSize: PAGE_SIZE,
    })
    items.value = result.items
    total.value = result.total
  }
  catch (err) {
    items.value = []
    total.value = 0
    error.value = err as Error
  }
  finally {
    loading.value = false
  }
}

watch(() => `${props.repoPath}|${currentStatus.value}|${page.value}`, () => void load(), { immediate: true })

/** 构建状态徽标（pending 中性 / success 绿 / error 红 / cancel 灰） */
function statusColor(status: string): 'neutral' | 'success' | 'error' | 'warning' {
  switch (status) {
    case 'success':
      return 'success'
    case 'error':
      return 'error'
    case 'pending':
      return 'warning'
    default:
      return 'neutral'
  }
}

const siteUrl = computed(() => repoSiteUrl(props.repoPath, '/-/builds'))

// ---------------------------------------------------------------------------
// 触发构建（T04）：弹窗 + 成功后刷新并高亮新 sn
// ---------------------------------------------------------------------------

const triggerOpen = ref(false)
/** 触发成功后待高亮的 sn（3s 后清除） */
const highlightSn = ref('')
let highlightTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 触发成功回调：重拉列表 → 滚动到新 sn 行并高亮 3s。
 * 状态更新交由 useCnbBuildWatch 的既有轮询（本组件不新增轮询，
 * 避免双通道重复请求 —— 设计文档 §6.1 Note）。
 */
async function onTriggered(sn: string) {
  await load()
  if (!sn) {
    return
  }
  highlightSn.value = sn
  await nextTick()
  // 滚动到新构建行（列表首屏通常已包含它；翻页后回到第 1 页也能看到）
  document.querySelector(`[data-build-sn="${CSS.escape(sn)}"]`)?.scrollIntoView({ block: 'center' })
  if (highlightTimer) {
    clearTimeout(highlightTimer)
  }
  highlightTimer = setTimeout(() => {
    highlightSn.value = ''
  }, 3000)
}
</script>

<template>
  <div>
    <!-- 筛选条：状态下拉 + 触发构建按钮 -->
    <div class="flex items-center gap-2 mb-3">
      <USelect
        :model-value="currentStatus"
        :items="statusItems"
        value-key="value"
        size="sm"
        class="w-40"
        @update:model-value="onStatusChange"
      />
      <span v-if="total && !loading" class="text-xs text-dimmed">
        {{ total }}
      </span>
      <!-- 触发构建：归档仓库禁用（archived 单向下发） -->
      <UButton
        class="ms-auto"
        size="sm"
        color="primary"
        variant="soft"
        icon="i-lucide-play"
        :label="t('builds.trigger')"
        :disabled="archived"
        @click="triggerOpen = true"
      />
    </div>

    <StateAlert
      v-if="loading"
      state="loading"
      loading-variant="list"
    />
    <StateAlert
      v-else-if="error"
      state="error"
      :error="error"
      :site-url="siteUrl"
      :retry="load"
    />
    <!-- 空态：区分"无构建"引导文案 -->
    <StateAlert
      v-else-if="items.length === 0"
      state="empty"
      :empty-text="t('builds.empty')"
      :empty-desc="t('builds.emptyDesc')"
    />
    <div v-else class="flex flex-col border border-default rounded-lg divide-y divide-default overflow-hidden">
      <button
        v-for="item in items"
        :key="item.sn"
        type="button"
        :data-build-sn="item.sn"
        class="flex items-center gap-3 px-4 py-3 text-left hover:bg-elevated/50 cursor-pointer transition-colors"
        :class="item.sn === highlightSn ? 'bg-primary/5 ring-1 ring-primary/40 rounded-none' : ''"
        @click="openBuild(item.sn)"
      >
        <UBadge
          :color="statusColor(item.status)"
          variant="subtle"
          size="sm"
          :label="t(`builds.status.${item.status}`)"
          class="shrink-0"
        />
        <div class="flex-1 min-w-0">
          <p class="text-sm text-highlighted truncate">
            {{ item.commitTitle || item.sn }}
            <span class="text-dimmed font-mono text-xs">{{ item.sn }}</span>
          </p>
          <p class="mt-0.5 flex items-center gap-2 text-xs text-dimmed flex-wrap">
            <span>{{ item.nickName || '-' }}</span>
            <span v-if="item.sourceRef" class="font-mono">{{ item.sourceRef }}</span>
            <span>{{ item.event }}</span>
          </p>
        </div>
        <div class="text-xs text-dimmed shrink-0 text-end">
          <p>{{ formatDuration(item.durationMs) || '-' }}</p>
          <p>{{ formatDateTime(item.createTime) }}</p>
        </div>
      </button>
    </div>

    <!-- 分页 -->
    <div
      v-if="!loading && !error && items.length > 0 && (page > 1 || hasNext)"
      class="flex items-center justify-center gap-3 mt-4"
    >
      <UButton
        size="sm"
        color="neutral"
        variant="outline"
        icon="i-lucide-arrow-left"
        :disabled="page <= 1"
        @click="setPage(page - 1)"
      >
        {{ t('common.prevPage') }}
      </UButton>
      <span class="text-xs text-dimmed">{{ t('common.pageInfo', { page }) }}</span>
      <UButton
        size="sm"
        color="neutral"
        variant="outline"
        trailing-icon="i-lucide-arrow-right"
        :disabled="!hasNext"
        @click="setPage(page + 1)"
      >
        {{ t('common.nextPage') }}
      </UButton>
    </div>

    <!-- 触发构建弹窗 -->
    <BuildTriggerModal
      v-model:open="triggerOpen"
      :repo-path="repoPath"
      :disabled="archived"
      @triggered="onTriggered"
    />
  </div>
</template>
