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
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  fetchBuildStatus,
  repoSiteUrl,
  type BuildStatus,
} from '../../composables/useCnbRepo'
import { useRepoRoute } from '../../composables/useRepoRoute'
import { formatDuration } from '../../utils'
import StateAlert from './StateAlert.vue'
import BuildLogDrawer from './BuildLogDrawer.vue'

const props = defineProps<{
  repoPath: string
  sn: string
  /** 列表条目携带的外跳直链（可选；直开 URL 时无此值） */
  buildLogUrl?: string
  eventUrl?: string
}>()

const { t } = useI18n()
const { backToList } = useRepoRoute()

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

async function load() {
  if (!props.repoPath || !props.sn) {
    return
  }
  loading.value = true
  error.value = null
  try {
    status.value = await fetchBuildStatus(props.repoPath, props.sn)
  }
  catch (err) {
    status.value = null
    error.value = err as Error
  }
  finally {
    loading.value = false
  }
}

watch(() => `${props.repoPath}|${props.sn}`, () => void load(), { immediate: true })

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

    <!-- 阶段日志抽屉（混合方案的内嵌路径） -->
    <BuildLogDrawer
      v-if="activeStage"
      v-model:open="drawerOpen"
      :title="activeStage.title"
      :repo-path="repoPath"
      :sn="sn"
      :pipeline-id="activeStage.pipelineId"
      :stage-id="activeStage.stageId"
      :external-log-url="externalLogUrl"
    />
  </div>
</template>
