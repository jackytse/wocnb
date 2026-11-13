<script setup lang="ts">
/**
 * 组织用量卡（组织页区块，2026-11-11 恢复 + 增强）。
 *
 * 背景：旧实现 HomeGroupOverview.vue（基本信息 + 统计 + 用量三合一）在
 * T13 组织页重写时未随迁，成为无引用死代码。本组件把「用量」区块独立
 * 出来并做三项增强，基本信息/统计已由 OrgOverviewCard 承载（职责拆分，
 * 不再三合一）：
 *
 * 1. **阈值预警**：占用 ≥80% 进度条转橙、≥95% 转红（usageSeverity 纯函数），
 *    原实现只有默认单色进度条，临近超限无感知；
 * 2. **特权额度**（GET /{slug}/-/charge/special-amount）：特权核时/存储 +
 *    服务端说明文案 + 有效期（null → 「永久有效」），原实现未接入；
 * 3. **仓库粒度用量下钻**（GET /{slug}/-/charge/repos-volume，分页）：
 *    默认收起，展开后按用量列仓库，用于定位「谁在吃额度」，原实现未接入。
 *
 * 资源用量（volume + quota 合并）数据层复用 useCnbAuth.fetchCnbGroupUsage。
 *
 * 降级策略（与组织页其他区块一致的「独立降级」范式）：
 * - 403（缺 group-resource:r）→ StateAlert forbidden 变体，注明所需 scope；
 * - 网络/服务端错误 → StateAlert error 变体 + 重试；
 * - 特权额度失败只隐藏特权区块（用量主体不受影响），不整卡报错；
 * - 仓库用量失败仅在下拉内提示，不影响其他区块。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { format } from 'date-fns'
import {
  fetchCnbGroupUsage,
  type CnbGroupUsageItem,
  type CnbApiError,
} from '../../composables/useCnbAuth'
import {
  fetchGroupReposVolume,
  fetchGroupSpecialAmount,
  REPOS_VOLUME_PAGE_SIZE,
  usageSeverity,
  type CnbRepoVolumeItem,
  type CnbSpecialAmountItem,
} from '../../composables/useCnbOrg'
import StateAlert from '../repo/StateAlert.vue'

const props = defineProps<{
  /** 组织路径（空串 = 未选组织，组件静默不渲染） */
  slug: string
}>()

const { t } = useI18n()

// ---------------------------------------------------------------------------
// 资源用量（volume + quota 合并条目）
// ---------------------------------------------------------------------------

/** 用量条目列表 */
const usages = ref<CnbGroupUsageItem[]>([])
/** 加载中 */
const loading = ref(false)
/** 加载失败对象（null = 正常；CnbApiError.kind 决定 403/网络错误分支） */
const loadError = ref<CnbApiError | null>(null)

/** 拉取选中组织的用量与额度（无 slug 时静默跳过） */
async function loadUsage() {
  if (!props.slug) {
    return
  }
  loading.value = true
  loadError.value = null
  try {
    usages.value = await fetchCnbGroupUsage(props.slug)
  }
  catch (err) {
    usages.value = []
    // 保留原始错误对象交给 StateAlert：403（缺权限）有专属界面
    //（提示缺失 scope + 管理令牌外跳），网络错误走重试分支
    loadError.value = (err as CnbApiError) ?? new Error(String(err))
  }
  finally {
    loading.value = false
  }
}

/** GPU 两类资源在额度与用量均为 0 时隐藏（沿用原实现的降噪策略） */
const visibleUsages = computed(() =>
  usages.value.filter(u => !u.key.includes('gpu') || u.total > 0 || u.used > 0),
)

// ---------------------------------------------------------------------------
// 单位化展示（沿用 HomeGroupOverview 的格式化逻辑）
// ---------------------------------------------------------------------------

/** 字节数人性化展示（B/KB/MB/GB/TB/PB，1024 进制） */
function formatBytes(n: number): string {
  if (n <= 0) {
    return '0 B'
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

/** 核秒 / milli_credit 等整型数值展示（千分位分隔） */
function formatNumber(n: number): string {
  return n.toLocaleString('en-US')
}

/** 已用量展示：字节类资源人性化换算，其余千分位原值 */
function usageText(item: CnbGroupUsageItem): string {
  return item.key.endsWith('_in_byte') ? formatBytes(item.used) : formatNumber(item.used)
}

/** 额度展示（同上规则） */
function quotaText(item: CnbGroupUsageItem): string {
  return item.key.endsWith('_in_byte') ? formatBytes(item.total) : formatNumber(item.total)
}

/** 冻结用量展示（> 0 才展示，见模板） */
function frozenText(item: CnbGroupUsageItem): string {
  return item.key.endsWith('_in_byte') ? formatBytes(item.frozen) : formatNumber(item.frozen)
}

/** 免费额度展示（> 0 才展示） */
function freeText(item: CnbGroupUsageItem): string {
  return item.key.endsWith('_in_byte') ? formatBytes(item.free) : formatNumber(item.free)
}

/** 已用占比（百分比上限 100；无额度返回 0，界面显示「未获取到额度」） */
function percentOf(item: CnbGroupUsageItem): number {
  return item.total > 0 ? Math.min(100, Math.round((item.used / item.total) * 100)) : 0
}

/** 占用率 → UProgress 颜色映射（阈值预警：80% 橙 / 95% 红） */
function progressColor(item: CnbGroupUsageItem): string {
  const severity = usageSeverity(percentOf(item))
  return severity === 'danger' ? 'error' : severity === 'warning' ? 'warning' : 'primary'
}

// ---------------------------------------------------------------------------
// 特权额度（special-amount）
// ---------------------------------------------------------------------------

/** 特权额度条目（空数组 = 无特权，整个区块隐藏） */
const specialAmounts = ref<CnbSpecialAmountItem[]>([])
/** 特权区块加载中 */
const specialLoading = ref(false)
/** 特权区块是否已尝试加载（失败只静默隐藏区块，不打扰用量主体） */
const specialLoaded = ref(false)

async function loadSpecialAmount() {
  if (!props.slug) {
    return
  }
  specialLoading.value = true
  try {
    specialAmounts.value = await fetchGroupSpecialAmount(props.slug)
    specialLoaded.value = true
  }
  catch {
    // 特权额度是增强维度：失败静默隐藏区块（不与用量主体强绑定）
    specialAmounts.value = []
    specialLoaded.value = false
  }
  finally {
    specialLoading.value = false
  }
}

/** 特权条目显示名：i18n 键优先，未知 key 回退显示原文（服务端新增资源不白屏） */
function specialLabel(key: string): string {
  const path = `org.usage.special.${key}`
  const translated = t(path)
  // vue-i18n 对缺失键返回键路径本身 —— 以此判断未知 key，回退原文
  return translated === path ? key : translated
}

/** 特权有效期展示：空串 → 「永久有效」；其余格式化为 yyyy-MM-dd */
function expireText(expire: string): string {
  if (!expire) {
    return t('org.usage.permanent')
  }
  try {
    return t('org.usage.expireAt', { date: format(new Date(expire), 'yyyy-MM-dd') })
  }
  catch {
    return expire
  }
}

// ---------------------------------------------------------------------------
// 仓库粒度用量（repos-volume，分页下钻）
// ---------------------------------------------------------------------------

/** 仓库用量条目累计（跨「加载更多」追加） */
const repoVolumes = ref<CnbRepoVolumeItem[]>([])
/** 下拉是否展开（默认收起，按需加载） */
const repoVolumeOpen = ref(false)
/** 仓库用量加载中 */
const repoVolumeLoading = ref(false)
/** 仓库用量加载失败标记 */
const repoVolumeError = ref(false)
/** 当前已加载页码（用于「加载更多」取下一页） */
const repoVolumePage = ref(0)
/**
 * 是否还有下一页：本页返回条数 == pageSize 则假定还有
 * （swagger 无总数/hasMore 字段，见 fetchGroupReposVolume 注释）
 */
const repoVolumeHasMore = ref(false)

/** 切换下钻展开/收起：首次展开时触发首次加载 */
function toggleRepoVolume() {
  repoVolumeOpen.value = !repoVolumeOpen.value
  if (repoVolumeOpen.value && repoVolumePage.value === 0) {
    void loadRepoVolumes()
  }
}

/** 拉取仓库用量；page > 1 时追加到列表（「加载更多」语义） */
async function loadRepoVolumes() {
  if (!props.slug || repoVolumeLoading.value) {
    return
  }
  const nextPage = repoVolumePage.value + 1
  repoVolumeLoading.value = true
  repoVolumeError.value = false
  try {
    const items = await fetchGroupReposVolume(props.slug, nextPage)
    // 按用量降序（服务端未承诺顺序，前端排序保证「大户在前」）
    const sorted = [...items].sort((a, b) => b.volume - a.volume)
    repoVolumes.value = nextPage === 1 ? sorted : [...repoVolumes.value, ...sorted]
    repoVolumePage.value = nextPage
    repoVolumeHasMore.value = items.length >= REPOS_VOLUME_PAGE_SIZE
  }
  catch {
    repoVolumeError.value = true
  }
  finally {
    repoVolumeLoading.value = false
  }
}

/** 仓库用量数值展示：字节类（slug 无法判断资源类型）统一千分位原值 —— 服务端
 * volume 无单位元数据，保留原始数值避免误换算（表格列头注明单位见 API 说明） */
function repoVolumeText(item: CnbRepoVolumeItem): string {
  return formatNumber(item.volume)
}

// ---------------------------------------------------------------------------
// 生命周期：slug 变化（切组织 / 子组织下钻）→ 全部区块重置并重拉
// ---------------------------------------------------------------------------

watch(() => props.slug, () => {
  usages.value = []
  specialAmounts.value = []
  repoVolumes.value = []
  repoVolumePage.value = 0
  repoVolumeHasMore.value = false
  repoVolumeOpen.value = false
  repoVolumeError.value = false
  void loadUsage()
  void loadSpecialAmount()
}, { immediate: true })

/** 刷新按钮：三个区块全部重拉（仓库用量已展开才刷新，收起态不预加载） */
function refreshAll() {
  void loadUsage()
  void loadSpecialAmount()
  if (repoVolumeOpen.value) {
    repoVolumePage.value = 0
    repoVolumes.value = []
    void loadRepoVolumes()
  }
}
</script>

<template>
  <!-- 未选组织时不渲染（父级已有引导空态） -->
  <UCard
    v-if="slug"
    variant="subtle"
    :ui="{ body: 'flex flex-col gap-4' }"
  >
    <template #header>
      <div class="flex items-center gap-2">
        <UIcon name="i-lucide-gauge" class="size-4 text-muted" />
        <span class="font-semibold text-highlighted">{{ t('org.usage.title') }}</span>
        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          icon="i-lucide-refresh-cw"
          :loading="loading"
          :aria-label="t('common.retry')"
          @click="refreshAll"
        />
      </div>
    </template>

    <!-- 403（缺 group-resource:r）/ 网络错误：StateAlert 按 error.kind 自动分支，
         403 态含「管理令牌」外跳，且绝不引导登出（红线） -->
    <StateAlert
      v-if="loadError"
      state="error"
      :error="loadError"
      :retry="refreshAll"
    />

    <!-- 加载中：骨架屏 -->
    <div v-else-if="loading" class="flex flex-col gap-3">
      <USkeleton v-for="i in 4" :key="i" class="h-10 w-full rounded-md" />
    </div>

    <!-- 用量主体 -->
    <template v-else>
      <!-- ① 逐资源用量：进度条（阈值变色）+ 已用/额度/冻结/免费 -->
      <div class="flex flex-col gap-4">
        <div
          v-for="item in visibleUsages"
          :key="item.key"
          class="flex flex-col gap-1.5"
        >
          <div class="flex items-center justify-between gap-2 flex-wrap text-sm">
            <span class="font-medium text-highlighted">{{ t(`org.usage.res.${item.key}`) }}</span>
            <span class="text-muted text-xs flex items-center gap-2">
              <span>
                {{ usageText(item) }} / {{ item.total > 0 ? quotaText(item) : t('org.usage.noQuota') }}
              </span>
              <span v-if="item.frozen > 0" class="text-dimmed">
                {{ t('org.usage.frozen', { value: frozenText(item) }) }}
              </span>
              <span v-if="item.free > 0" class="text-dimmed">
                {{ t('org.usage.freeQuota', { value: freeText(item) }) }}
              </span>
            </span>
          </div>
          <UProgress
            v-if="item.total > 0"
            :model-value="percentOf(item)"
            :max="100"
            size="sm"
            :color="progressColor(item)"
          />
        </div>
      </div>

      <!-- ② 特权额度（有内容才渲染；加载中显示骨架；失败静默隐藏） -->
      <div v-if="specialLoading || specialAmounts.length > 0" class="flex flex-col gap-2 border-t border-default pt-4">
        <div class="flex items-center gap-1.5 text-sm font-medium text-highlighted">
          <UIcon name="i-lucide-gift" class="size-4 text-muted" />
          {{ t('org.usage.specialTitle') }}
        </div>
        <template v-if="specialLoading">
          <USkeleton class="h-8 w-full rounded-md" />
        </template>
        <ul v-else class="flex flex-col gap-1.5">
          <li
            v-for="entry in specialAmounts"
            :key="entry.key"
            class="flex items-center justify-between gap-2 flex-wrap text-sm"
          >
            <span class="flex items-center gap-2 min-w-0">
              <span class="font-medium text-highlighted">{{ specialLabel(entry.key) }}</span>
              <!-- 服务端说明文案（如「赠送 100 核时」），截断防长文撑爆布局 -->
              <span
                v-if="entry.desc"
                class="text-xs text-dimmed truncate max-w-60"
                :title="entry.desc"
              >{{ entry.desc }}</span>
            </span>
            <span class="text-muted text-xs flex items-center gap-2">
              <span class="font-medium text-highlighted">{{ formatNumber(entry.value) }}</span>
              <UBadge
                :color="entry.expire ? 'warning' : 'neutral'"
                variant="subtle"
                size="sm"
                :label="expireText(entry.expire)"
              />
            </span>
          </li>
        </ul>
      </div>

      <!-- ③ 仓库粒度用量下钻（默认收起，按需加载） -->
      <div class="flex flex-col gap-2 border-t border-default pt-4">
        <UButton
          color="neutral"
          variant="ghost"
          size="sm"
          :icon="repoVolumeOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
          trailing-icon=""
          @click="toggleRepoVolume"
        >
          <span class="inline-flex items-center gap-1.5">
            {{ t('org.usage.repoVolumeTitle') }}
            <UIcon
              :name="repoVolumeOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
              class="size-3.5"
            />
          </span>
        </UButton>

        <div v-if="repoVolumeOpen" class="flex flex-col gap-2">
          <!-- 下钻加载失败：仅本区块提示，可重试 -->
          <UAlert
            v-if="repoVolumeError"
            icon="i-lucide-cloud-alert"
            color="error"
            variant="soft"
            :title="t('org.usage.repoVolumeFailed')"
          >
            <template #actions>
              <UButton
                size="sm"
                color="error"
                variant="soft"
                icon="i-lucide-refresh-cw"
                @click="loadRepoVolumes"
              >
                {{ t('common.retry') }}
              </UButton>
            </template>
          </UAlert>

          <USkeleton v-else-if="repoVolumeLoading && repoVolumes.length === 0" class="h-24 w-full rounded-md" />

          <template v-else>
            <!-- 空态：组织内无任何仓库用量记录 -->
            <p
              v-if="repoVolumes.length === 0"
              class="text-sm text-dimmed"
            >
              {{ t('org.usage.repoVolumeEmpty') }}
            </p>

            <!-- 仓库用量表：地址 + 用量（按用量降序）；已删除条目灰显 -->
            <table
              v-else
              class="w-full text-sm"
            >
              <thead>
                <tr class="text-left text-xs text-dimmed border-b border-default">
                  <th class="py-1.5 font-normal">
                    {{ t('org.usage.repoCol') }}
                  </th>
                  <th class="py-1.5 font-normal text-right">
                    {{ t('org.usage.volumeCol') }}
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="entry in repoVolumes"
                  :key="entry.slug"
                  class="border-b border-default last:border-b-0"
                  :class="entry.isDeleted ? 'opacity-50' : ''"
                >
                  <td class="py-1.5 font-mono text-xs truncate max-w-80" :title="entry.slug">
                    {{ entry.slug }}
                    <UBadge
                      v-if="entry.isDeleted"
                      color="neutral"
                      variant="subtle"
                      size="sm"
                      :label="t('org.usage.deleted')"
                      class="ms-1"
                    />
                  </td>
                  <td class="py-1.5 text-right tabular-nums">
                    {{ repoVolumeText(entry) }}
                  </td>
                </tr>
              </tbody>
            </table>

            <!-- 加载更多（hasMore 近似判断：本页满页则假定还有下一页） -->
            <div
              v-if="repoVolumeHasMore"
              class="flex justify-center"
            >
              <UButton
                size="xs"
                color="neutral"
                variant="soft"
                :loading="repoVolumeLoading"
                @click="loadRepoVolumes"
              >
                {{ t('org.usage.loadMore') }}
              </UButton>
            </div>
          </template>
        </div>
      </div>
    </template>
  </UCard>
</template>
