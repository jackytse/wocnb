<script setup lang="ts">
/**
 * 阶段日志抽屉（PRD P0-D3）。
 *
 * 渲染：等宽按行（保留空白）；行数 > 2000 默认只渲染尾部 2000 行、
 * 可"展开全部"；提供复制全文与"在浏览器打开日志"兜底出口；内容更新
 * 后自动滚动到底部（最新日志通常在末尾）。
 *
 * 本次增量（T04）：头部右上新增「删除日志」入口（DELETE /-/build/logs/{sn}，
 * scope repo-cnb-trigger:rw）—— ConfirmDialog 输入 sn 确认（高危写操作）；
 * 删除的是**日志**而非构建记录，删除后重拉呈空态。归档仓库禁用。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { openUrl } from '@tauri-apps/plugin-opener'
import { deleteBuildLogs, fetchStageLog, type StageLog } from '../../composables/useCnbRepo'
import ConfirmDialog from '../common/ConfirmDialog.vue'

const props = defineProps<{
  open: boolean
  /** 阶段标题（pipeline / 阶段名） */
  title: string
  repoPath: string
  sn: string
  pipelineId: string
  stageId: string
  /** 浏览器兜底日志地址（列表条目携带；直链不可得时留空隐藏按钮） */
  externalLogUrl?: string
  /** 归档仓库：删除日志入口禁用 */
  archived?: boolean
}>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
}>()

const { t } = useI18n()
// useToast 为 Nuxt UI 全局自动导入
const toast = useToast()

/** 日志数据与加载状态 */
const log = ref<StageLog | null>(null)
const loading = ref(false)
const error = ref<Error | null>(null)

/** 超长日志默认只渲染尾部（PRD：>2000 行默认尾 2000 行可展开） */
const MAX_LINES = 2000
/** 是否展开全部行 */
const showFull = ref(false)

const allLines = computed(() => log.value?.lines ?? [])
/** 实际渲染的行（>2000 且未展开 → 尾部 2000 行） */
const visibleLines = computed(() =>
  showFull.value || allLines.value.length <= MAX_LINES
    ? allLines.value
    : allLines.value.slice(-MAX_LINES),
)
/** 是否被截断（显示提示与展开按钮） */
const truncated = computed(() => allLines.value.length > MAX_LINES)

const openModel = computed({
  get: () => props.open,
  set: (value: boolean) => emit('update:open', value),
})

/** 滚动容器引用（自动滚底用） */
const scrollContainer = ref<HTMLElement | null>(null)

/** 滚动到底部（最新日志在末尾；nextTick 等 DOM 渲染完成） */
async function scrollToBottom() {
  await nextTick()
  const el = scrollContainer.value
  if (el) {
    el.scrollTop = el.scrollHeight
  }
}

async function load() {
  if (!props.repoPath || !props.sn || !props.pipelineId || !props.stageId) {
    return
  }
  loading.value = true
  error.value = null
  showFull.value = false
  try {
    log.value = await fetchStageLog(props.repoPath, props.sn, props.pipelineId, props.stageId)
    await scrollToBottom()
  }
  catch (err) {
    log.value = null
    error.value = err as Error
  }
  finally {
    loading.value = false
  }
}

// 抽屉打开即拉取（每次打开都刷新，日志可能已更新）
watch(() => props.open, (value) => {
  if (value) {
    void load()
  }
})

/** 展开全部后滚到底部 */
watch(showFull, (value) => {
  if (value) {
    void scrollToBottom()
  }
})

/** 复制全文（截断时也复制完整内容，取自完整 allLines） */
async function copyAll() {
  const text = allLines.value.join('\n')
  if (!text) {
    return
  }
  try {
    await navigator.clipboard.writeText(text)
    toast.add({ title: t('builds.logCopied'), color: 'success', duration: 1500 })
  }
  catch {
    toast.add({ title: t('state.error'), color: 'error', duration: 2000 })
  }
}

/** 在系统浏览器打开日志（兜底出口，日志接口不可用时仍可用） */
function openExternal() {
  const url = props.externalLogUrl
  if (!url) {
    return
  }
  if ('__TAURI_INTERNALS__' in window) {
    void openUrl(url)
  }
  else {
    window.open(url, '_blank')
  }
}

// ---------------------------------------------------------------------------
// 删除日志（T04）：ConfirmDialog 输入 sn 确认 → DELETE → 重拉呈空态
// ---------------------------------------------------------------------------

const deleteDialogOpen = ref(false)
/** 删除进行中（防重复提交） */
const deleting = ref(false)

/** 执行删除：成功后重拉日志（呈空态）并提示 */
async function doDeleteLogs() {
  if (!props.repoPath || !props.sn || deleting.value) {
    return
  }
  deleting.value = true
  try {
    await deleteBuildLogs(props.repoPath, props.sn)
    toast.add({ title: t('builds.deleteLogsSuccess'), color: 'success', duration: 2500 })
    deleteDialogOpen.value = false
    // 重拉当前阶段日志：服务端已删除，呈空态（T04-4 验收点）
    await load()
  }
  catch (err) {
    toast.add({
      title: t('builds.deleteLogsFailed'),
      description: (err as Error)?.message || '',
      color: 'error',
      duration: 6000,
    })
  }
  finally {
    deleting.value = false
  }
}
</script>

<template>
  <UDrawer
    v-model:open="openModel"
    direction="right"
    :ui="{ content: 'max-w-2xl' }"
  >
    <template #header>
      <div class="flex items-center gap-2 min-w-0">
        <UIcon name="i-lucide-scroll-text" class="size-4 text-muted shrink-0" />
        <h3 class="text-sm font-semibold text-highlighted truncate">
          {{ title }}
        </h3>
        <div class="ms-auto flex items-center gap-1.5 shrink-0">
          <!-- 删除日志：高危写操作（输入 sn 确认）；归档仓库禁用 -->
          <UButton
            size="xs"
            color="error"
            variant="ghost"
            icon="i-lucide-trash-2"
            :label="t('builds.deleteLogs')"
            :disabled="archived"
            @click="deleteDialogOpen = true"
          />
          <UButton
            size="xs"
            color="neutral"
            variant="ghost"
            icon="i-lucide-copy"
            :label="t('builds.copyLog')"
            @click="copyAll"
          />
          <!-- 浏览器兜底出口（错误态下仍可用，PRD P0-D4） -->
          <UButton
            v-if="externalLogUrl"
            size="xs"
            color="neutral"
            variant="ghost"
            icon="i-lucide-external-link"
            :label="t('builds.openBuildLog')"
            @click="openExternal"
          />
        </div>
      </div>
    </template>

    <template #body>
      <!-- 加载骨架 -->
      <div v-if="loading" class="flex flex-col gap-2">
        <USkeleton
          v-for="i in 8"
          :key="i"
          class="h-4 rounded-md"
          :class="i % 3 ? 'w-full' : 'w-3/4'"
        />
      </div>

      <!-- 失败：提示 + 重试 + 外跳兜底 -->
      <UAlert
        v-else-if="error"
        icon="i-lucide-cloud-alert"
        color="error"
        variant="soft"
        :title="t('builds.stageLogFailed')"
        :description="error.message"
      >
        <template #actions>
          <UButton
            size="sm"
            color="error"
            variant="soft"
            icon="i-lucide-refresh-cw"
            @click="load"
          >
            {{ t('common.retry') }}
          </UButton>
          <UButton
            v-if="externalLogUrl"
            size="sm"
            color="neutral"
            variant="soft"
            icon="i-lucide-external-link"
            :label="t('builds.openBuildLog')"
            @click="openExternal"
          />
        </template>
      </UAlert>

      <p v-else-if="allLines.length === 0" class="text-sm text-dimmed text-center py-8">
        {{ t('builds.logEmpty') }}
      </p>

      <!-- 日志正文：等宽按行、保留空白、可滚动、自动滚底 -->
      <template v-else>
        <!-- 截断提示 + 展开按钮 -->
        <UAlert
          v-if="truncated && !showFull"
          icon="i-lucide-filter"
          color="neutral"
          variant="soft"
          :title="t('builds.logTruncated', { count: MAX_LINES })"
          class="mb-3"
        >
          <template #actions>
            <UButton
              size="sm"
              color="neutral"
              variant="soft"
              :label="t('builds.showFull')"
              @click="showFull = true"
            />
          </template>
        </UAlert>

        <div
          ref="scrollContainer"
          class="font-mono text-xs leading-5 bg-default border border-default rounded-lg p-3 overflow-auto max-h-[60vh]"
        >
          <div v-for="(line, index) in visibleLines" :key="index" class="whitespace-pre-wrap break-all">
            {{ line }}
          </div>
        </div>
      </template>
    </template>
  </UDrawer>

  <!-- 删除日志二次确认：普通确认（主理人裁决 —— 日志可重新构建再生，
       不值得输入长 sn 的摩擦；文案保留"删除后不可恢复"后果说明） -->
  <ConfirmDialog
    v-model:open="deleteDialogOpen"
    :title="t('builds.deleteLogs')"
    :desc="t('builds.deleteLogsConfirm', { sn })"
    :confirm-label="t('builds.deleteLogs')"
    confirm-color="error"
    :loading="deleting"
    @confirm="doDeleteLogs"
  />
</template>
