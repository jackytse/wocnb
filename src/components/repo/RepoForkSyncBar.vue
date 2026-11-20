<script setup lang="ts">
/**
 * fork 仓库「同步更新」提示条。
 *
 * 显示位置：仓库详情页 head 区下方（仅 fork 仓库渲染）。
 * 行为：
 * - 挂载 / 分支变化时静默检测 fork 分支与上游同名分支的 SHA 差异；
 * - same / upstream-missing / unknown → 不渲染（不打扰）；
 * - outdated → 显示提示条 +「同步更新」按钮；
 * - 点击按钮 → 二次确认弹窗（merge 语义说明）→ 触发同步构建 →
 *   toast 成功并附「查看构建」入口（应用内构建详情页）。
 *
 * 同步通过动态注入流水线实现（见 useCnbFork.ts 头注释），构建为异步
 * 执行 —— 本组件只负责「触发 + 引导查看」，不等待构建完成（同步结果
 * 以构建日志为准，成功后刷新仓库即可看到新提交）。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'

import { fetchForkSyncState, startForkSync, type ForkSyncState } from '../../composables/useCnbFork'
import { useAppToast } from '../../composables/useAppToast'
import { encodeRepoPathForRoute } from '../../utils'

const props = defineProps<{
  /** fork 仓库完整路径 */
  repoPath: string
  /** 上游仓库完整路径（forkedFromPath，空串 = 非 fork 仓库不渲染） */
  upstreamPath: string
  /** 要同步的分支名（当前 head / 默认分支） */
  branch: string
}>()

const emit = defineEmits<{
  /** 同步构建触发成功（父组件可据此刷新数据提示用户） */
  (e: 'syncStarted', sn: string): void
}>()

const { t } = useI18n()
const toast = useAppToast()
const router = useRouter()

/** 检测状态：null = 检测中/不显示；outdated 才显示提示条 */
const syncState = ref<ForkSyncState | null>(null)
/** 检测中标志（防闪烁：已 outdated 再重查时保留提示条） */
const checking = ref(false)
/** 触发同步中（按钮 loading） */
const starting = ref(false)
/** 确认弹窗显隐 */
const confirmVisible = ref(false)

/** 上游路径兜底：正常必有值（父组件已判空才挂载） */
const upstream = computed(() => props.upstreamPath.trim())

/**
 * 检测同步状态。
 * 失败（网络/403）静默归 unknown 不显示 —— fork 同步是增强功能，
 * 不该因为检测失败打断仓库页浏览。
 */
async function checkSyncState() {
  if (!props.upstreamPath || !props.branch) {
    syncState.value = null
    return
  }
  checking.value = true
  try {
    syncState.value = await fetchForkSyncState(props.repoPath, upstream.value, props.branch)
  }
  catch {
    syncState.value = 'unknown'
  }
  finally {
    checking.value = false
  }
}

// 仓库或分支变化时重新检测（切仓库 / 切 head 都可能改变上游关系）
watch(
  () => [props.repoPath, props.upstreamPath, props.branch] as const,
  () => {
    // 立即复位为 null：切仓库瞬间隐藏旧提示，避免新仓库闪现旧状态
    syncState.value = null
    checkSyncState()
  },
  { immediate: true },
)

/** 是否渲染提示条：仅「上游有更新」时显示 */
const showBar = computed(() => syncState.value === 'outdated')

/** 应用内构建详情路由（同步构建触发成功后引导查看） */
function buildDetailRoute(sn: string): string {
  return `/repos/${encodeRepoPathForRoute(props.repoPath)}?tab=builds&sn=${encodeURIComponent(sn)}`
}

/** 点击「同步更新」→ 打开确认弹窗 */
function openConfirm() {
  confirmVisible.value = true
}

/** 确认弹窗「开始同步」→ 触发构建 */
async function doSync() {
  starting.value = true
  try {
    const build = await startForkSync(props.repoPath, upstream.value, props.branch)
    confirmVisible.value = false
    // 触发成功即认为「同步已排队」，隐藏提示条避免重复点击；
    // 构建完成与否由构建详情页反馈
    syncState.value = 'same'
    // 成功 toast 带「查看构建」动作：跳应用内构建详情页跟踪同步进度
    toast.add({
      title: t('repo.forkSync.startedTitle'),
      description: t('repo.forkSync.startedDesc', { sn: build.sn }),
      color: 'success',
      duration: 8000,
      actions: [
        {
          label: t('repo.forkSync.viewBuild'),
          onClick: () => router.push(buildDetailRoute(build.sn)),
        },
      ],
    })
    emit('syncStarted', build.sn)
  }
  catch (err) {
    // 触发失败（网络 / 无 repo-cnb-trigger 权限等）：warning toast，
    // 提示条保持显示可重试
    console.error('[wocnb] fork 同步触发失败：', err)
    toast.add({
      title: t('repo.forkSync.startFailed'),
      color: 'warning',
      duration: 5000,
    })
  }
  finally {
    starting.value = false
  }
}
</script>

<template>
  <div
    v-if="showBar"
    class="flex items-center gap-3 rounded-[10px] border border-amber-500/30 bg-amber-500/10 px-4 py-2.5"
  >
    <UIcon name="i-lucide-arrow-down-to-line" class="shrink-0 size-4 text-amber-500" />
    <div class="min-w-0 flex-1 leading-snug">
      <p class="text-[13px] text-highlighted">
        {{ t('repo.forkSync.outdatedTitle') }}
      </p>
      <p class="mt-0.5 truncate text-[12px] text-muted">
        {{ t('repo.forkSync.outdatedDesc', { upstream: upstreamPath }) }}
      </p>
    </div>
    <UButton
      size="xs"
      color="warning"
      variant="solid"
      :loading="starting"
      @click="openConfirm"
    >
      {{ t('repo.forkSync.syncButton') }}
    </UButton>
  </div>

  <!-- 同步确认弹窗：merge 语义说明（独有提交不会被丢弃，冲突需网页端处理） -->
  <UModal v-model:open="confirmVisible" :title="t('repo.forkSync.confirmTitle')">
    <template #body>
      <div class="space-y-2 text-[13px] leading-relaxed">
        <p>{{ t('repo.forkSync.confirmDesc', { branch, upstream: upstreamPath }) }}</p>
        <p class="text-muted">
          {{ t('repo.forkSync.confirmHint') }}
        </p>
      </div>
    </template>
    <template #footer>
      <div class="flex justify-end gap-2">
        <UButton
          variant="ghost"
          :disabled="starting"
          @click="confirmVisible = false"
        >
          {{ t('common.cancel') }}
        </UButton>
        <UButton
          color="warning"
          :loading="starting"
          @click="doSync"
        >
          {{ t('repo.forkSync.syncButton') }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
