<script setup lang="ts">
/**
 * AI 用量三级展示面板（REQ-06 / T07）。
 *
 * 层级：①汇总（ai-audit 的 content 按模型分组 + 总页数）→ ②分页明细（ai-request +
 * 分页按钮 / 表格）→ ③单次详情（ai-request-detail → UModal JSON 代码块）。
 *
 * 空态：数据层在 code!==0 时返回空结构；本组件以 pages===0 / 汇总内容为空判定
 * "本次构建无 AI 用量记录"（StateAlert empty），不报错。
 * 权限：repo-cnb-history:r 缺失 → 本卡片内 StateAlert forbidden（含 scope 提示），
 * 不影响构建日志主体（区块级降级，403 绝不登出）。
 *
 * pipelineId 来源（主理人 Q2 裁决）：由 RepoBuildDetail 从 fetchBuildStatus 的
 * pipelines[].id 取得；构建无流水线时以 sn 占位并需在真机验证（见 RepoBuildDetail
 * 注释）。本组件只按传入值拼请求，不臆造来源。
 *
 * 分页（BUG-03 修复）：页码是**面板内部 ref**，不与路由 ?page= 耦合 —— 构建详情
 * 页的构建列表也在用 ?page=，共用会导致翻 AI 明细时把构建列表一起翻走。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  fetchBuildAiAudit,
  fetchBuildAiRequestDetail,
  fetchBuildAiRequests,
  type AiRequestDetail,
  type AiRequestEntry,
  type AiUsageSummary,
} from '../../composables/useCnbBuildAi'
import { CnbApiError } from '../../composables/useCnbAuth'
// 本地化时间 / 耗时格式化工具（纯函数，无副作用）
import { formatDateTime, formatDuration } from '../../utils'
import StateAlert from './StateAlert.vue'

const props = defineProps<{
  /** 仓库完整路径（org/repo，逐段编码由数据层负责） */
  repoPath: string
  /** 构建序号 */
  sn: string
  /** 流水线 id（真机校验前可能是 sn 占位） */
  pipelineId: string
}>()

// i18n：界面文案与汇总 total 键的本地化
const { t } = useI18n()

// ---------------------------------------------------------------------------
// 分页（面板内部状态；BUG-03 修复：与路由 ?page= 解耦）
// ---------------------------------------------------------------------------

/** 明细分页页码：面板内部 ref，切构建/流水线时重置回第 1 页 */
const page = ref(1) // 不写 ?page=：该键归构建列表页所有（BUG-03）

/** 翻页：只改内部页码，watch(page) 触发重拉明细 */
function goPage(target: number) {
  // 边界由按钮 disabled 保证（首页禁后退 / 末页禁前进），此处直接赋值
  page.value = target
}

// ---------------------------------------------------------------------------
// 汇总（第 1 级）：ai-audit
// ---------------------------------------------------------------------------

/** 汇总数据（归一化后；null = 未加载或加载失败） */
const audit = ref<AiUsageSummary | null>(null)
/** 汇总加载中（渲染骨架屏） */
const auditLoading = ref(false)
/** 汇总加载异常（渲染错误态，可重试；独立降级不阻塞明细） */
const auditError = ref<Error | null>(null)

/** 拉取汇总：三要素任一缺失（详情未就绪）时静默跳过 */
async function loadAudit() {
  // 仓库 / 构建号 / 流水线 id 任一为空：不发起请求
  if (!props.repoPath || !props.sn || !props.pipelineId) {
    return
  }
  // 置 loading 并清掉上次的错误态（重试场景）
  auditLoading.value = true
  auditError.value = null
  try {
    audit.value = await fetchBuildAiAudit(props.repoPath, props.sn, props.pipelineId)
  }
  catch (err) {
    // 失败：清数据 + 记错误（StateAlert error 呈现，retry 调回本函数）
    audit.value = null
    auditError.value = err as Error
  }
  finally {
    auditLoading.value = false
  }
}

/** 单个统计值 → 展示文本：数字加千分位便于阅读，其余转字符串兜底 */
function formatStatValue(value: unknown): string {
  if (typeof value === 'number') {
    // request_count / milli_token 等通常是大数值，千分位分组
    return value.toLocaleString()
  }
  // null/undefined 兜底空串，避免界面出现 "null"/"undefined"
  return String(value ?? '')
}

/**
 * 汇总 content（自由对象）→ 结构化卡片列表（nit 修复）。
 * 实测形态（swagger 无 schema，"List AI usage by model"）：content 为
 * `{ total: { request_count, milli_token, ... }, [模型名]: { 同结构 } }`。
 * 对象值按子字段逐项展示（request_count / milli_token / milli_credit 等），
 * 不再整段 JSON.stringify；total 键用本地化文案，模型名原样展示。
 */
const summaryCards = computed(() => {
  // content 缺失（code!==0 空结构）时按空对象处理 → 空态
  const content = audit.value?.content ?? {}
  return Object.entries(content)
    .map(([key, value]) => {
      // 卡片标题：total 特判本地化，其余（模型名/未知键）原样展示
      const name = key === 'total' ? t('repo.build.aiUsage.totalLabel') : key
      if (typeof value === 'object' && value !== null) {
        // 结构化对象：逐子字段生成统计行（下划线转空格便于阅读）
        const stats = Object.entries(value as Record<string, unknown>)
          .map(([subKey, subValue]) => ({
            label: subKey.replace(/_/g, ' '),
            value: formatStatValue(subValue),
          }))
        return { name, stats }
      }
      // 标量值：单行展示（key 即说明，label 留空不渲染）
      return { name, stats: [{ label: '', value: formatStatValue(value) }] }
    })
    // 全空对象的卡片不渲染（防御 content 为 { a: {} } 的异常形态）
    .filter(card => card.stats.length > 0)
})

/** 是否无用量：code!==0（数据层空结构）或 pages=0 或汇总内容为空 → 空态而非报错 */
const hasNoUsage = computed(() => {
  if (!audit.value) {
    // 未加载完成前不判定（避免闪烁空态）
    return false
  }
  return audit.value.code !== 0 || audit.value.pages === 0 || summaryCards.value.length === 0 // 任一即空态
})

// ---------------------------------------------------------------------------
// 404 语义纠正（2026-11-20 用户反馈「显示不准确」，截图回归）
// ---------------------------------------------------------------------------

/**
 * 404 语义（2026-11-20 二次校正）：
 * AI 用量端点对「该构建/流水线没有 AI 用量记录」返回 404 —— 这是**常态**，
 * 因为用量只统计流水线中 NPC / AI 能力（@npc 派活、AI 代码评审、npc:go
 * 阶段等）的 Token 消耗，普通 CI 构建不会产生任何 AI 用量。
 * 因此 404 不再显示中性「数据不可用」提示（会被误读为故障），
 * 而是按空态语义展示并附一句原因说明。真正的网络/服务错误仍走 error 态。
 */
function isNotFound(err: Error | null): boolean {
  return err instanceof CnbApiError && err.kind === 'notFound'
}

/** 汇总 404（渲染中性提示） */
const auditNotFound = computed(() => isNotFound(auditError.value))
/** 明细 404（同上） */
const requestsNotFound = computed(() => isNotFound(requestsError.value))

// ---------------------------------------------------------------------------
// 分页明细（第 2 级）：ai-request
// ---------------------------------------------------------------------------

/** 当前页的明细列表（归一化后；空数组由数据层兜底） */
const requests = ref<AiRequestEntry[]>([])
/** 明细加载中（列表骨架屏） */
const requestsLoading = ref(false)
/** 明细加载异常（错误态 + 可重试） */
const requestsError = ref<Error | null>(null)

/** 按当前页码拉取明细列表 */
async function loadRequests() {
  // 三要素任一为空：不发请求（与 loadAudit 相同的就绪判定）
  if (!props.repoPath || !props.sn || !props.pipelineId) {
    return
  }
  requestsLoading.value = true
  requestsError.value = null
  try {
    // page 是路径末段（GET ai-request/{sn}/{pipelineId}/{page}），内部 ref 直传
    requests.value = await fetchBuildAiRequests(props.repoPath, props.sn, props.pipelineId, page.value)
  }
  catch (err) {
    // 失败：清列表 + 记错误，翻页重试时 loadRequests 会恢复
    requests.value = []
    requestsError.value = err as Error
  }
  finally {
    requestsLoading.value = false
  }
}

/** sn / pipelineId / 仓库变化：页码重置回 1 并重拉（汇总与明细独立降级） */
watch(
  () => `${props.repoPath}|${props.sn}|${props.pipelineId}`,
  () => {
    // 切换构建/流水线：回第 1 页，旧页码对新列表无意义
    page.value = 1
    void loadAudit()
    void loadRequests()
  },
  { immediate: true },
)

/** 翻页：只重拉明细（汇总与页码无关，避免重复请求） */
watch(page, () => {
  void loadRequests()
})

// ---------------------------------------------------------------------------
// 单次详情（第 3 级）：页内 UModal，不新增路由下钻键
// ---------------------------------------------------------------------------

/** 详情弹窗开关与加载状态（页内模态，不写路由） */
const detailOpen = ref(false) // 弹窗开关（v-model:open 由 UModal 维护）
const detailLoading = ref(false) // 详情加载中（弹窗内骨架屏）
const detailError = ref<Error | null>(null) // 详情加载异常（弹窗内错误态）
/** 详情数据（归一化后；content 为自由对象原样保留） */
const detailData = ref<AiRequestDetail | null>(null)
/** 当前查看的请求 id（弹窗顶部回显，便于与表格行对上） */
const activeRequestId = ref('')

/** 打开单次请求详情：requestId 为空（数据缺失）时忽略点击 */
async function openDetail(requestId: string) {
  // 列表项 requestId 兜底缺失：无可请求的 id，忽略本次点击
  if (!requestId) {
    return
  }
  activeRequestId.value = requestId
  detailOpen.value = true // 先开弹窗展示骨架屏，数据到达后替换
  detailLoading.value = true
  detailError.value = null
  detailData.value = null // 清掉上一次的详情，避免串数据
  try {
    detailData.value = await fetchBuildAiRequestDetail(
      props.repoPath, props.sn, props.pipelineId, requestId,
    )
  }
  catch (err) {
    detailError.value = err as Error
  }
  finally {
    detailLoading.value = false
  }
}

/** 详情 content 友好化：字段未定义 schema，JSON 代码块完整呈现不猜语义 */
const detailJson = computed(() => {
  const content = detailData.value?.content ?? {} // 未载入时兜底空对象
  return JSON.stringify(content, null, 2) // 缩进 2 空格便于阅读
})
</script>

<template>
  <div class="flex flex-col gap-3">
    <!-- 汇总（第 1 级）：按模型分组的结构化统计卡片 -->
    <StateAlert v-if="auditLoading" state="loading" loading-variant="plain" />
    <!-- 404 = 该构建没有 AI 用量记录（普通构建必然如此），按空态语义展示并说明原因 -->
    <UAlert
      v-else-if="auditNotFound"
      icon="i-lucide-info"
      color="neutral"
      variant="soft"
      :title="t('repo.build.aiUsage.empty')"
      :description="t('repo.build.aiUsage.emptyDesc')"
    />
    <StateAlert
      v-else-if="auditError"
      state="error"
      :error="auditError"
      :retry="loadAudit"
      :show-back="false"
    />
    <template v-else-if="audit && !hasNoUsage">
      <div class="flex flex-wrap gap-2">
        <div
          v-for="card in summaryCards"
          :key="card.name"
          class="border border-default rounded-lg px-3 py-2 min-w-40 flex-1"
        >
          <p class="text-xs font-semibold text-highlighted truncate">
            {{ card.name }}
          </p>
          <div class="mt-1 flex flex-col gap-0.5">
            <p
              v-for="stat in card.stats"
              :key="stat.label"
              class="text-xs text-dimmed flex items-baseline justify-between gap-2"
            >
              <span class="capitalize truncate">{{ stat.label }}</span>
              <span class="text-highlighted font-medium shrink-0">{{ stat.value }}</span>
            </p>
          </div>
        </div>
      </div>
      <p v-if="audit.pages > 0" class="text-xs text-dimmed">
        {{ t('repo.build.aiUsage.totalPages', { count: audit.pages }) }}
      </p>
    </template>

    <!-- 无 AI 用量：空态（不报错） -->
    <StateAlert
      v-if="!auditLoading && !auditError && hasNoUsage"
      state="empty"
      :empty-text="t('repo.build.aiUsage.empty')"
    />

    <!-- 分页明细（第 2 级）：无汇总用量时不再请求表格 -->
    <template v-if="audit && !hasNoUsage">
      <StateAlert v-if="requestsLoading" state="loading" loading-variant="list" />
      <!-- 明细 404（汇总有数据但明细缺失的异常边角）：同样按空态展示 -->
      <StateAlert
        v-else-if="requestsNotFound"
        state="empty"
        :empty-text="t('repo.build.aiUsage.empty')"
      />
      <StateAlert
        v-else-if="requestsError"
        state="error"
        :error="requestsError"
        :retry="loadRequests"
        :show-back="false"
      />
      <StateAlert
        v-else-if="requests.length === 0"
        state="empty"
        :empty-text="t('repo.build.aiUsage.empty')"
      />
      <div v-else class="flex flex-col border border-default rounded-lg divide-y divide-default overflow-hidden">
        <button
          v-for="entry in requests"
          :key="entry.requestId || entry.timestamp"
          type="button"
          class="flex items-center gap-3 px-3 py-2 text-left hover:bg-elevated/50 cursor-pointer"
          @click="openDetail(entry.requestId)"
        >
          <UIcon name="i-lucide-bot" class="size-3.5 text-muted shrink-0" />
          <span class="text-sm text-highlighted truncate flex-1">{{ entry.model || '-' }}</span>
          <UBadge
            :color="entry.success ? 'success' : 'error'"
            variant="subtle"
            size="sm"
            :label="entry.success ? t('repo.build.aiUsage.success') : t('repo.build.aiUsage.failed')"
          />
          <span class="text-xs text-dimmed shrink-0">
            {{ t('repo.build.aiUsage.tokens', { count: entry.totalTokens }) }}
          </span>
          <span class="text-xs text-dimmed shrink-0">{{ entry.milliCredit }}</span>
          <span class="text-xs text-dimmed shrink-0">
            {{ formatDuration(entry.responseEndDurationMs) || t('repo.build.aiUsage.durationNone') }}
          </span>
          <span class="text-xs text-dimmed shrink-0">{{ formatDateTime(entry.timestamp) }}</span>
        </button>
      </div>

      <!-- 分页（第 2 级）：面板内部页码，不写 ?page=（BUG-03） -->
      <div
        v-if="!requestsLoading && !requestsError && requests.length > 0 && (audit.pages > 1 || page > 1)"
        class="flex items-center justify-center gap-3"
      >
        <UButton
          size="sm"
          color="neutral"
          variant="outline"
          icon="i-lucide-arrow-left"
          :disabled="page <= 1"
          @click="goPage(page - 1)"
        >
          {{ t('common.prevPage') }}
        </UButton>
        <span class="text-xs text-dimmed">{{ t('common.pageInfo', { page }) }}</span>
        <UButton
          size="sm"
          color="neutral"
          variant="outline"
          trailing-icon="i-lucide-arrow-right"
          :disabled="page >= audit.pages"
          @click="goPage(page + 1)"
        >
          {{ t('common.nextPage') }}
        </UButton>
      </div>
    </template>

    <!-- 单次详情（第 3 级）：UModal + JSON 代码块 -->
    <UModal
      v-model:open="detailOpen"
      :title="t('repo.build.aiUsage.detail')"
      :ui="{ content: 'max-w-3xl' }"
    >
      <template #body>
        <p class="text-xs text-dimmed mb-2 font-mono">
          {{ activeRequestId }}
        </p>
        <StateAlert v-if="detailLoading" state="loading" loading-variant="plain" />
        <StateAlert v-else-if="detailError" state="error" :error="detailError" />
        <pre
          v-else-if="detailData"
          class="text-xs bg-elevated/50 rounded-lg p-3 overflow-auto max-h-96 whitespace-pre-wrap break-all"
        >{{ detailJson }}</pre>
      </template>
    </UModal>
  </div>
</template>
