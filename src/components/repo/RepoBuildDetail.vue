<script setup lang="ts">
/**
 * 构建详情（PRD P0-D2/D3，混合方案）。
 *
 * 主路径：GET /-/build/status/{sn} 的 pipelinesStatus 按
 * Record<pipelineId, dto.PipelineStatus> 解析 → pipeline→stage 两级树，
 * 点击阶段打开日志抽屉（fetchStageLog）。
 * 兜底路径：parseOk=false（结构为空/异常，R6/R10）→ 降级为只读说明 +
 * "在浏览器打开日志"外跳（buildLogUrl / eventUrl 由列表条目传入，
 * 直链不可得时退化为仓库构建页地址）。
 *
 * 本次增量（T04）：运行中构建（pending / start）显示「停止」按钮
 * （ConfirmDialog 确认 → stopBuild → 轮询状态直到终态，最多 30s）。
 * 归档仓库（archived）时停止入口禁用。
 *
 * 自动刷新（2026-11-20 用户需求）：详情打开且构建未到终态时，
 * 每 3s 自动重拉状态直到终态（success / error / cancel），到终态
 * 自动停止并 toast 提醒；连续 3 次拉取失败停止自动轮询（保留手动刷新）。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  fetchBuildStatus,
  repoSiteUrl,
  stopBuild,
  type BuildStatus,
} from '../../composables/useCnbRepo'
import { useRepoRoute } from '../../composables/useRepoRoute'
import { SCOPE_REPO_CNB_TRIGGER, useScopeGate } from '../../composables/useCnbWriteGate'
import { formatDuration } from '../../utils'
import StateAlert from './StateAlert.vue'
import BuildLogDrawer from './BuildLogDrawer.vue'
import AiUsagePanel from './AiUsagePanel.vue'
import ConfirmDialog from '../common/ConfirmDialog.vue'
import { useAppToast } from '../../composables/useAppToast'

const props = defineProps<{
  repoPath: string
  sn: string
  /** 列表条目携带的外跳直链（可选；直开 URL 时无此值） */
  buildLogUrl?: string
  eventUrl?: string
  /** 归档仓库：写入口（停止构建）禁用 */
  archived?: boolean
  /** 管理权限预判：停止构建/删除日志是写操作（repo-cnb-trigger:rw），
      无权限隐藏入口，防止点了才吃 403 */
  canManage?: boolean
}>()

const { t } = useI18n()
const { backToList } = useRepoRoute()
const toast = useAppToast()

/** scope 闸：令牌缺 repo-cnb-trigger:rw 时隐藏停止/删日志入口（令牌维度预判） */
const triggerScope = useScopeGate(SCOPE_REPO_CNB_TRIGGER)

/** 在系统浏览器打开链接（非 Tauri 环境兜底 window.open；模板内不直接碰 window） */
function openExternal(url: string) {
  if ('__TAURI_INTERNALS__' in window) {
    void import('@tauri-apps/plugin-opener').then(m => m.openUrl(url))
  }
  else {
    window.open(url, '_blank')
  }
}

const status = ref<BuildStatus | null>(null)
const loading = ref(false)
const error = ref<Error | null>(null)

// ---------------------------------------------------------------------------
// 自动刷新（2026-11-20 用户需求）：构建未到终态时每 3s 重拉状态直到终态
//
// ⚠️ 声明顺序红线：下面的 watch 是 immediate: true，setup 阶段同步执行，
// 回调会调用 stopAutoPoll() —— 若 pollTimer 等状态声明在 watch 之后，
// 会触发 TDZ ReferenceError 导致整个详情组件挂载失败（2026-11-20 回归：
// 「流水线流程没有正常显示」，typecheck/单测均抓不到）。
// 因此轮询状态与函数必须全部先于 watch 声明。
// ---------------------------------------------------------------------------

/** 自动轮询间隔（与停止构建的既有 3s 口径一致） */
const AUTO_POLL_INTERVAL_MS = 3000
/** 连续拉取失败上限：网络抖动容忍 2 次，超过即停（保留手动刷新入口） */
const AUTO_POLL_MAX_ERRORS = 3

/** 终态集合（useCnbBuildWatch 的既有口径：pending / success / error / cancel） */
const TERMINAL_STATUSES = new Set(['success', 'error', 'cancel'])

/** 轮询定时器句柄（组件卸载 / sn 切换时清理，防泄漏） */
let pollTimer: ReturnType<typeof setTimeout> | null = null

/** 连续轮询失败计数（成功即归零） */
const pollErrorCount = ref(0)

/** 是否处于自动轮询中（UI 显示刷新动效的依据：运行中 + 轮询存活） */
const autoPolling = ref(false)

onBeforeUnmount(() => {
  stopAutoPoll()
})

/** 停止自动轮询（清定时器 + 熄灭动效标记） */
function stopAutoPoll() {
  if (pollTimer) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
  autoPolling.value = false
}

/** 调度下一次自动轮询（3s 后；setTimeout 链式避免请求重叠） */
function scheduleAutoPoll() {
  if (!status.value || TERMINAL_STATUSES.has(status.value.status)) {
    autoPolling.value = false
    return
  }
  autoPolling.value = true
  if (pollTimer) {
    clearTimeout(pollTimer)
  }
  pollTimer = setTimeout(() => void pollOnce(), AUTO_POLL_INTERVAL_MS)
}

/**
 * 单次自动轮询：重拉状态；失败不置整页 error（已有内容优先展示），
 * 连续超限即停；终态迁移时 toast 提醒用户。
 */
async function pollOnce() {
  pollTimer = null
  if (!props.repoPath || !props.sn) {
    return
  }
  const prevStatus = status.value?.status
  try {
    status.value = await fetchBuildStatus(props.repoPath, props.sn)
    pollErrorCount.value = 0
  }
  catch {
    // 轮询失败：静默累计，超限停止自动轮询（详情内容仍在，用户可手动刷新）
    pollErrorCount.value++
    if (pollErrorCount.value >= AUTO_POLL_MAX_ERRORS) {
      autoPolling.value = false
      return
    }
  }
  const nextStatus = status.value?.status
  // pending → 终态迁移：toast 提醒（仅自动轮询路径，停止构建路径有自己的提示）
  if (prevStatus === 'pending' && nextStatus && TERMINAL_STATUSES.has(nextStatus)) {
    autoPolling.value = false
    toast.add({
      title: t('builds.finishedTitle', { sn: props.sn }),
      description: t(`builds.status.${nextStatus}`),
      color: nextStatus === 'success' ? 'success' : 'warning',
      duration: 6000,
    })
    return
  }
  // 未到终态：继续下一轮
  scheduleAutoPoll()
}

async function load() {
  if (!props.repoPath || !props.sn) {
    return
  }
  loading.value = true
  error.value = null
  try {
    status.value = await fetchBuildStatus(props.repoPath, props.sn)
    // 首拉成功即重置容错计数；未到终态时启动自动轮询
    pollErrorCount.value = 0
    scheduleAutoPoll()
  }
  catch (err) {
    status.value = null
    error.value = err as Error
  }
  finally {
    loading.value = false
  }
}

watch(() => `${props.repoPath}|${props.sn}`, () => {
  // 构建号切换：先停掉旧 sn 的自动轮询，防止残留定时器把新状态写花
  stopAutoPoll()
  void load()
}, { immediate: true })

// ---------------------------------------------------------------------------
// 停止构建（T04）：ConfirmDialog → stopBuild → 轮询到终态（最多 30s）
// ---------------------------------------------------------------------------

const stopDialogOpen = ref(false)
const stopping = ref(false)

/** 构建是否处于可停止状态：pending（排队/运行中）视作运行中 */
const isRunning = computed(() => status.value?.status === 'pending')

/** 停止确认后执行：调用 stopBuild → 每 3s 重拉状态，终态即停（最多 10 次 ≈ 30s） */
async function doStop() {
  if (stopping.value) {
    return
  }
  stopping.value = true
  try {
    // 停止轮询有自己的 3s 循环：先停掉自动轮询，避免两路并发写 status
    stopAutoPoll()
    await stopBuild(props.repoPath, props.sn)
    toast.add({ title: t('builds.stopSuccess'), color: 'success', duration: 2500 })
    stopDialogOpen.value = false
    // 轮询直到终态：停止是异步操作，服务端需要时间把状态从 pending 迁移到 cancel
    for (let attempt = 0; attempt < 10; attempt++) {
      // 首次等待 3s 后再查（刚下发停止命令，立即查大概率还是 pending）
      await new Promise(resolve => setTimeout(resolve, 3000))
      const next = await fetchBuildStatus(props.repoPath, props.sn)
      status.value = next
      if (TERMINAL_STATUSES.has(next.status)) {
        return
      }
    }
    // 30s 内未到终态：恢复自动轮询接管（用户无需手动刷新），不报错
    scheduleAutoPoll()
  }
  catch (err) {
    // 403（缺 repo-cnb-trigger:rw）等：透出 message，绝不登出
    toast.add({
      title: t('builds.stopFailed'),
      description: (err as Error)?.message || '',
      color: 'error',
      duration: 6000,
    })
  }
  finally {
    stopping.value = false
    // 停止失败/中断时若构建仍在运行，恢复自动轮询（否则详情会停格在旧状态）
    if (status.value?.status === 'pending') {
      scheduleAutoPoll()
    }
  }
}

/** 兜底外跳地址：列表直链优先，缺失时退化为仓库构建页 */
const externalLogUrl = computed(() =>
  props.buildLogUrl || props.eventUrl || repoSiteUrl(props.repoPath, '/-/builds'),
)

/** 构建状态徽标色 */
const statusColor = computed(() => {
  switch (status.value?.status) {
    case 'success':
      return 'success'
    case 'error':
      return 'error'
    case 'pending':
      return 'warning'
    default:
      return 'neutral'
  }
})

/** 阶段状态徽标色（dto.BuildStageResult 的 status 枚举） */
function stageColor(value: string): 'neutral' | 'success' | 'error' | 'warning' | 'info' {
  switch (value) {
    case 'success':
      return 'success'
    case 'error':
      return 'error'
    case 'start':
      return 'info'
    case 'pending':
      return 'warning'
    default:
      return 'neutral'
  }
}

// ---------------------------------------------------------------------------
// 日志抽屉
// ---------------------------------------------------------------------------

/** 当前打开日志的阶段（pipelineId + stageId + 展示名） */
const activeStage = ref<{ pipelineId: string, stageId: string, title: string } | null>(null)
const drawerOpen = ref(false)

function openStageLog(pipelineId: string, stageId: string, pipelineName: string, stageName: string) {
  activeStage.value = {
    pipelineId,
    stageId,
    title: `${pipelineName} / ${stageName} · ${props.sn}`,
  }
  drawerOpen.value = true
}

// ---------------------------------------------------------------------------
// AI 用量子区（REQ-06；主理人 Q2 裁决落实）
// ---------------------------------------------------------------------------

/**
 * AI 用量端点的 pipelineId 来源：
 * - pipelineId 必须与构建状态里的流水线 id 一致（即 pipelinesStatus 的 key，
 *   归一化时写入 `p.id || key`）。每条流水线各挂一个 AiUsagePanel，互不串数据。
 * - **不再用 sn 占位兜底**（2026-11-20）：占位值必然打不中 AI 用量端点，
 *   实测表现为详情页出现「资源不存在」误导提示；无流水线时干脆不渲染该区块。
 */
const aiPipelineIds = computed<string[]>(() =>
  (status.value?.pipelines ?? []).map(p => p.id).filter(Boolean),
)
</script>

<template>
  <div>
    <!-- 顶部：返回 + 构建号 + 总状态徽标 -->
    <div class="flex items-center gap-2 mb-3 flex-wrap">
      <UButton
        size="xs"
        color="neutral"
        variant="ghost"
        icon="i-lucide-arrow-left"
        :label="t('state.backToList')"
        @click="backToList"
      />
      <UBadge
        color="neutral"
        variant="subtle"
        size="sm"
        :label="sn"
        class="font-mono"
      />
      <UBadge
        v-if="status?.status"
        :color="statusColor"
        variant="subtle"
        size="sm"
        :label="t(`builds.status.${status.status}`)"
      />
      <!-- 自动刷新动效：自动轮询存活时显示（构建运行中即常驻，
           到终态或连续失败停止后熄灭） -->
      <UTooltip
        v-if="autoPolling"
        :text="t('builds.autoRefreshing')"
      >
        <UIcon
          name="i-lucide-refresh-cw"
          class="size-3.5 text-dimmed animate-spin"
          :aria-label="t('builds.autoRefreshing')"
        />
      </UTooltip>
      <!-- 停止按钮：仅运行中显示；归档仓库禁用；canManage（角色）+ scope 闸
           （令牌缺 repo-cnb-trigger:rw 时隐藏，写入口统一方案）双预判 -->
      <UButton
        v-if="canManage && isRunning && !triggerScope.denied.value"
        size="xs"
        color="error"
        variant="soft"
        icon="i-lucide-octagon-pause"
        :label="t('builds.stop')"
        :disabled="archived || stopping"
        :loading="stopping"
        class="ms-auto"
        @click="stopDialogOpen = true"
      />
    </div>

    <StateAlert
      v-if="loading"
      state="loading"
      loading-variant="detail"
    />
    <StateAlert
      v-else-if="error"
      state="error"
      :error="error"
      :site-url="externalLogUrl"
      :retry="load"
      @back="backToList"
    />

    <template v-else-if="status">
      <!-- 主路径：pipeline → stage 两级树 -->
      <div v-if="status.parseOk" class="flex flex-col gap-4">
        <div
          v-for="pipeline in status.pipelines"
          :key="pipeline.id"
          class="border border-default rounded-lg overflow-hidden"
        >
          <!-- 流水线级 -->
          <div class="flex items-center gap-2 px-4 py-2.5 bg-elevated/40">
            <UIcon name="i-lucide-workflow" class="size-4 text-muted shrink-0" />
            <span class="text-sm font-medium text-highlighted truncate">{{ pipeline.name }}</span>
            <UBadge
              color="neutral"
              variant="subtle"
              size="sm"
              :label="pipeline.status"
              class="shrink-0"
            />
            <span v-if="pipeline.durationMs" class="ms-auto text-xs text-dimmed shrink-0">
              {{ t('builds.duration') }}: {{ formatDuration(pipeline.durationMs) }}
            </span>
          </div>
          <!-- 阶段级（可点开日志抽屉；无 id 的阶段不可点——无法定位日志端点） -->
          <div class="divide-y divide-default">
            <button
              v-for="stage in pipeline.stages"
              :key="`${pipeline.id}-${stage.id}`"
              type="button"
              class="flex items-center gap-3 w-full px-5 py-2.5 text-left hover:bg-elevated/50 cursor-pointer"
              :disabled="!stage.id"
              :class="!stage.id ? 'opacity-60' : ''"
              @click="openStageLog(pipeline.id, stage.id, pipeline.name, stage.name)"
            >
              <UIcon name="i-lucide-corner-down-right" class="size-3.5 text-dimmed shrink-0" />
              <span class="text-sm text-highlighted truncate flex-1">{{ stage.name }}</span>
              <UBadge
                :color="stageColor(stage.status)"
                variant="subtle"
                size="sm"
                :label="stage.status ? t(`builds.stageStatus.${stage.status}`) : '-'"
                class="shrink-0"
              />
              <span v-if="stage.durationMs" class="text-xs text-dimmed shrink-0">
                {{ formatDuration(stage.durationMs) }}
              </span>
              <!-- 有 id 才有日志入口 -->
              <UIcon
                v-if="stage.id"
                name="i-lucide-scroll-text"
                class="size-4 text-dimmed shrink-0"
              />
            </button>
          </div>
        </div>
      </div>

      <!-- 兜底路径：pipelinesStatus 解析失败 → 只读说明 + 外跳（不崩不白屏） -->
      <UAlert
        v-else
        icon="i-lucide-file-warning"
        color="warning"
        variant="soft"
        :title="t('builds.parseFailedTitle')"
        :description="t('builds.parseFailedDesc')"
        class="max-w-xl"
      >
        <template #actions>
          <UButton
            size="sm"
            color="warning"
            variant="soft"
            icon="i-lucide-external-link"
            :label="t('builds.openBuildLog')"
            @click="openExternal(externalLogUrl)"
          />
        </template>
      </UAlert>
    </template>

    <!-- AI 用量子区（REQ-06）：每条流水线一个面板；无流水线时用 sn 占位（Q2 需真机验证） -->
    <div
      v-if="status && aiPipelineIds.length > 0"
      class="mt-4 border border-default rounded-lg p-4"
    >
      <h3 class="text-sm font-semibold text-highlighted mb-3 flex items-center gap-2">
        <UIcon name="i-lucide-bot" class="size-4 text-muted" />
        {{ t('repo.build.aiUsage.title') }}
      </h3>
      <div class="flex flex-col gap-5">
        <div
          v-for="pipelineId in aiPipelineIds"
          :key="pipelineId"
          class="flex flex-col gap-2"
        >
          <div
            v-if="status.pipelines.length > 1"
            class="text-xs text-dimmed font-mono"
          >
            {{ t('repo.build.aiUsage.pipeline') }}: {{ pipelineId }}
          </div>
          <AiUsagePanel
            :repo-path="repoPath"
            :sn="sn"
            :pipeline-id="pipelineId"
          />
        </div>
      </div>
    </div>

    <!-- 阶段日志抽屉（混合方案的内嵌路径） -->
    <BuildLogDrawer
      v-if="activeStage"
      v-model:open="drawerOpen"
      :can-manage="canManage"
      :title="activeStage.title"
      :repo-path="repoPath"
      :sn="sn"
      :pipeline-id="activeStage.pipelineId"
      :stage-id="activeStage.stageId"
      :external-log-url="externalLogUrl"
      :archived="archived"
    />

    <!-- 停止构建二次确认（破坏性操作：error 色） -->
    <ConfirmDialog
      v-model:open="stopDialogOpen"
      :title="t('builds.stop')"
      :desc="t('builds.stopConfirm', { sn })"
      :confirm-label="t('builds.stop')"
      confirm-color="error"
      :loading="stopping"
      @confirm="doStop"
    />
  </div>
</template>
