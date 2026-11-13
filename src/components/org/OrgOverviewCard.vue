<script setup lang="ts">
/**
 * 组织概览卡（T13 验收 1）：头像 / 描述 / 仓库数 / 成员数 / 子组织数 /
 * 关注数。
 *
 * 数据源：useCnbOrg.fetchOrgOverview（GET /{group}，scope group-resource:r）；
 * 403/加载失败时由父级回退到 selectedGroup（侧边栏 /user/groups 已有
 * 的概要字段）展示，仅缺项显示「—」—— 概览区块失败不阻塞仓库墙等区块。
 *
 * 缺失语义（重点）：followCount === -1 表示服务端未返回该字段，显示
 * 「—」；0 是合法值（无人关注），与缺失**不能混用**（§3.7）。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { cnbGroupLogoUrl } from '../../composables/useCnbAuth'
import type { OrgOverview } from '../../composables/useCnbOrg'

const props = defineProps<{
  /** 组织概览（null 时显示骨架屏） */
  overview: OrgOverview | null
  loading: boolean
}>()

const { t } = useI18n()

/** 组织图标（CNB 规则 URL，未自定义同样返回占位图，不会 404） */
const logoUrl = computed(() =>
  props.overview ? cnbGroupLogoUrl(props.overview.path) : '',
)

/** 计数展示：-1（服务端缺失）→ 「—」，其余原样 */
function displayCount(value: number): string {
  return value < 0 ? '—' : String(value)
}

/** 统计项（顺序即展示顺序） */
const stats = computed(() => props.overview
  ? [
      { label: t('org.overview.repos'), value: displayCount(props.overview.allSubRepoCount), icon: 'i-lucide-folder-git-2' },
      { label: t('org.overview.members'), value: displayCount(props.overview.memberCount), icon: 'i-lucide-users' },
      { label: t('org.overview.subGroups'), value: displayCount(props.overview.subGroupCount), icon: 'i-lucide-building-2' },
      { label: t('org.overview.followers'), value: displayCount(props.overview.followCount), icon: 'i-lucide-heart' },
    ]
  : [])
</script>

<template>
  <UCard :ui="{ body: 'flex flex-col gap-3' }">
    <!-- 加载中：骨架 -->
    <template v-if="loading && !overview">
      <USkeleton class="h-16 w-full rounded-md" />
    </template>

    <template v-else-if="overview">
      <!-- 头像 + 名称 + 描述 -->
      <div class="flex items-start gap-3">
        <UAvatar
          :src="logoUrl"
          :alt="overview.name"
          size="lg"
          class="shrink-0 rounded-md"
        />
        <div class="min-w-0 flex flex-col gap-1">
          <div class="flex items-center gap-2 min-w-0">
            <h2 class="text-base font-semibold text-highlighted truncate">
              {{ overview.name }}
            </h2>
            <UBadge
              color="neutral"
              variant="subtle"
              size="sm"
              :label="overview.path"
              class="font-mono shrink-0"
            />
          </div>
          <p
            v-if="overview.description"
            class="text-sm text-muted line-clamp-2"
          >
            {{ overview.description }}
          </p>
        </div>
      </div>

      <!-- 统计行 -->
      <div class="flex items-center gap-5 flex-wrap">
        <div
          v-for="stat in stats"
          :key="stat.label"
          class="flex items-center gap-1.5 text-sm"
        >
          <UIcon
            :name="stat.icon"
            class="size-4 text-dimmed"
          />
          <span class="text-dimmed">{{ stat.label }}</span>
          <span class="font-medium text-highlighted">{{ stat.value }}</span>
        </div>
      </div>
    </template>
  </UCard>
</template>
