<script setup lang="ts">
/**
 * Home 页「组织概览」区块：所选组织的基本信息 + 统计信息 + 本月用量。
 *
 * 数据来源（CNB Open API）：
 * - 基本信息/统计：全局共享的 selectedGroup（GET /user/groups 归一化前的
 *   原始字段，dto.OrganizationAccess：成员数、子组织数、仓库数等），
 *   侧边栏 GroupsMenu 切换组织后自动联动；
 * - 用量：GET /{slug}/-/charge/volume（已用量）+ GET /{slug}/-/charge/quota
 *   （本月额度），两接口合并为逐资源的用量条目（需 group-resource:r 权限，
 *   无权限时展示错误提示，错误信息含服务器原始 errmsg）。
 *
 * 展示策略：GPU 两类资源在额度与用量均为 0 时不显示，避免占位噪音。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { format } from 'date-fns'
import {
  selectedGroup,
  fetchCnbGroupUsage,
  cnbGroupLogoUrl,
  cnbGroupUrl,
  type CnbGroupUsageItem,
} from '../composables/useCnbAuth'

const { t } = useI18n()

/** 用量条目列表 */
const usages = ref<CnbGroupUsageItem[]>([])
/** 加载中状态 */
const loading = ref(false)
/** 加载失败标记（显示重试入口） */
const loadError = ref(false)

/** 拉取选中组织的用量与额度（无选中组织时静默跳过） */
async function loadUsage() {
  const slug = selectedGroup.value?.path
  if (!slug) {
    return
  }
  loading.value = true
  loadError.value = false
  try {
    usages.value = await fetchCnbGroupUsage(slug)
  }
  catch {
    usages.value = []
    loadError.value = true
  }
  finally {
    loading.value = false
  }
}

// 选中组织变化（GroupsMenu 切换 / 刷新按钮重拉）后重新加载用量
watch(() => selectedGroup.value?.path, () => {
  void loadUsage()
}, { immediate: true })

/** 组织统计卡片数据（来自 selectedGroup 的原始统计字段） */
const statItems = computed(() => {
  const g = selectedGroup.value
  if (!g) {
    return []
  }
  return [
    { label: t('home.group.members'), value: g.member_count ?? 0, icon: 'i-lucide-users' },
    { label: t('home.group.allMembers'), value: g.all_member_count ?? 0, icon: 'i-lucide-users-round' },
    { label: t('home.group.subGroups'), value: g.sub_group_count ?? 0, icon: 'i-lucide-network' },
    { label: t('home.group.repos'), value: g.all_sub_repo_count ?? 0, icon: 'i-lucide-folder-git-2' },
    { label: t('home.group.missions'), value: g.sub_mission_count ?? 0, icon: 'i-lucide-list-todo' },
    { label: t('home.group.registries'), value: g.sub_registry_count ?? 0, icon: 'i-lucide-package' },
    { label: t('home.group.follows'), value: g.follow_count ?? 0, icon: 'i-lucide-heart' },
  ]
})

/** 组织创建时间展示格式（ISO -> yyyy-MM-dd，非法值返回原串） */
const createdAtText = computed(() => {
  const raw = selectedGroup.value?.created_at
  if (!raw) {
    return ''
  }
  try {
    return format(new Date(raw), 'yyyy-MM-dd')
  }
  catch {
    return raw
  }
})

/** 参与用量展示的资源条目：GPU 两类在额度与用量均为 0 时隐藏 */
const visibleUsages = computed(() =>
  usages.value.filter(u => !u.key.includes('gpu') || u.total > 0 || u.used > 0),
)

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

/** 核秒/milli_credit 等整型数值展示（千分位分隔） */
function formatNumber(n: number): string {
  return n.toLocaleString('en-US')
}

/** 资源类型显示名（i18n 键与 API 字段一一对应） */
function resLabel(key: string): string {
  return t(`home.group.res.${key}`)
}

/** 已用量的单位化展示（字节类资源人性化换算，其余千分位原值） */
function usageText(item: CnbGroupUsageItem): string {
  return item.key.endsWith('_in_byte') ? formatBytes(item.used) : formatNumber(item.used)
}

/** 额度的单位化展示 */
function quotaText(item: CnbGroupUsageItem): string {
  return item.key.endsWith('_in_byte') ? formatBytes(item.total) : formatNumber(item.total)
}

/** 冻结用量的单位化展示（> 0 才展示，见模板） */
function frozenText(item: CnbGroupUsageItem): string {
  return item.key.endsWith('_in_byte') ? formatBytes(item.frozen) : formatNumber(item.frozen)
}

/** 免费额度的单位化展示 */
function freeText(item: CnbGroupUsageItem): string {
  return item.key.endsWith('_in_byte') ? formatBytes(item.free) : formatNumber(item.free)
}

/** 已用占比（百分比，上限 100；无额度时返回 0，界面显示为"未获取到额度"） */
function percentOf(item: CnbGroupUsageItem): number {
  return item.total > 0 ? Math.min(100, Math.round((item.used / item.total) * 100)) : 0
}
</script>

<template>
  <!-- 未选中组织（组织列表尚未加载完）时不渲染，避免空卡片闪烁 -->
  <div v-if="selectedGroup" class="flex flex-col gap-4">
    <!-- —— 基本信息：logo + 名称 + 描述 + 元信息 —— -->
    <UCard variant="subtle">
      <div class="flex items-start gap-4 flex-wrap">
        <UAvatar
          :src="cnbGroupLogoUrl(selectedGroup.path)"
          :alt="selectedGroup.name"
          size="3xl"
        />
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <h2 class="text-lg font-semibold text-highlighted">
              {{ selectedGroup.name }}
            </h2>
            <UBadge
              color="neutral"
              variant="subtle"
              :label="selectedGroup.path"
            />
            <!-- 当前用户在组织内的权限角色 -->
            <UBadge
              color="primary"
              variant="subtle"
              :label="selectedGroup.access_role"
            />
          </div>
          <p v-if="selectedGroup.description" class="mt-1 text-sm text-muted line-clamp-2">
            {{ selectedGroup.description }}
          </p>
          <div class="mt-2 flex items-center gap-4 text-xs text-muted flex-wrap">
            <span v-if="createdAtText" class="inline-flex items-center gap-1">
              <UIcon name="i-lucide-calendar" class="size-3.5" />
              {{ t('home.group.createdAt', { date: createdAtText }) }}
            </span>
            <a
              v-if="selectedGroup.site"
              :href="selectedGroup.site"
              class="inline-flex items-center gap-1 hover:text-primary"
            >
              <UIcon name="i-lucide-globe" class="size-3.5" />
              {{ selectedGroup.site }}
            </a>
            <span v-if="selectedGroup.domain" class="inline-flex items-center gap-1">
              <UIcon name="i-lucide-at-sign" class="size-3.5" />
              {{ selectedGroup.domain }}
            </span>
            <!-- 在系统浏览器打开组织主页（经 main.ts 全局外链拦截器） -->
            <a
              :href="cnbGroupUrl(selectedGroup.path)"
              class="ms-auto inline-flex items-center gap-1 hover:text-primary"
            >              <UIcon name="i-lucide-external-link" class="size-3.5" />
              {{ t('home.group.visit') }}
            </a>
          </div>
        </div>
      </div>
    </UCard>

    <!-- —— 统计信息：成员/子组织/仓库/任务集/制品库/关注 —— -->
    <div class="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
      <UCard
        v-for="stat in statItems"
        :key="stat.label"
        variant="subtle"
        class="p-1"
      >
        <div class="flex flex-col gap-1">
          <div class="flex items-center gap-1.5 text-xs text-muted">
            <UIcon :name="stat.icon" class="size-3.5" />
            {{ stat.label }}
          </div>
          <div class="text-xl font-semibold text-highlighted">
            {{ stat.value.toLocaleString('en-US') }}
          </div>
        </div>
      </UCard>
    </div>

    <!-- —— 本月用量：逐资源 已用/额度 + 进度条 —— -->
    <UCard variant="subtle">
      <template #header>
        <div class="flex items-center gap-2">
          <UIcon name="i-lucide-gauge" class="size-4 text-muted" />
          <span class="font-semibold text-highlighted">{{ t('home.group.monthlyUsage') }}</span>
          <UButton
            size="xs"
            color="neutral"
            variant="ghost"
            icon="i-lucide-refresh-cw"
            :loading="loading"
            :aria-label="t('common.retry')"
            @click="loadUsage"
          />
        </div>
      </template>

      <!-- 加载失败：提示 + 重试（常见原因：令牌缺少 group-resource:r 权限） -->
      <UAlert
        v-if="loadError"
        icon="i-lucide-cloud-alert"
        color="error"
        variant="soft"
        :title="t('home.group.usageLoadFailedTitle')"
        :description="t('home.group.usageLoadFailedDesc')"
      >
        <template #actions>
          <UButton
            size="sm"
            color="error"
            variant="soft"
            icon="i-lucide-refresh-cw"
            @click="loadUsage"
          >
            {{ t('common.retry') }}
          </UButton>
        </template>
      </UAlert>

      <!-- 加载中：骨架屏 -->
      <div v-else-if="loading" class="flex flex-col gap-3">
        <USkeleton v-for="i in 4" :key="i" class="h-10 w-full rounded-md" />
      </div>

      <!-- 用量条目：资源名 + 已用/额度 + 占比进度条（used + frozen 与 total 对比） -->
      <div v-else class="flex flex-col gap-4">
        <div v-for="item in visibleUsages" :key="item.key" class="flex flex-col gap-1.5">
          <div class="flex items-center justify-between gap-2 flex-wrap text-sm">
            <span class="font-medium text-highlighted">{{ resLabel(item.key) }}</span>
            <span class="text-muted text-xs flex items-center gap-2">
              <span>
                {{ usageText(item) }} / {{ item.total > 0 ? quotaText(item) : t('home.group.noQuota') }}
              </span>
              <span v-if="item.frozen > 0" class="text-dimmed">
                {{ t('home.group.frozen', { value: frozenText(item) }) }}
              </span>
              <span v-if="item.free > 0" class="text-dimmed">
                {{ t('home.group.freeQuota', { value: freeText(item) }) }}
              </span>
            </span>
          </div>
          <!-- 有额度才渲染进度条：已用占比（冻结部分计入总量消耗的预估） -->
          <UProgress
            v-if="item.total > 0"
            :model-value="percentOf(item)"
            :max="100"
            size="sm"
          />
        </div>
      </div>
    </UCard>
  </div>
</template>
