<script setup lang="ts">
/**
 * 社区页签容器（T09）：贡献者头像墙 / 周趋势图 / Fork 表格 / Star 用户，
 * 四区块**独立加载、独立降级**（验收 5）—— 任一区块 403 只影响自身
 * （StateAlert forbidden），绝不拖垮整页。
 *
 * 各区块端点与 scope：
 * - 贡献者 GET /{slug}/-/contributor/simply（公开统计接口）
 * - 趋势图 GET /{slug}/-/contributor/trend（repo_data 周度数据）
 * - Fork GET /{repo}/-/forks（repo-basic-info:r）
 * - Star GET /{slug}/-/stars（repo-basic-info:r；filter_type 必填，
 *   枚举 all | followed —— 「全部 / 仅关注」切换，PRD v1.1 REQ-C7）
 *
 * Fork 行点击 → 应用内跳转该 Fork 仓库（router.push /repos/{path}?tab=code）。
 */
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import {
  fetchContributors,
  fetchContributorTrend,
  fetchForks,
  fetchStarUsers,
  starUserAvatar,
  type ContributorsResult,
  type ForkItem,
  type StarFilterType,
  type StarUsersResult,
  type TrendResult,
} from '../../composables/useCnbSocial'
import { cnbAvatarUrl } from '../../composables/useCnbAuth'
import { formatDateTime } from '../../utils'
import StateAlert from './StateAlert.vue'
import ContributorTrendChart from './ContributorTrendChart.vue'

const props = defineProps<{
  repoPath: string
}>()

const { t } = useI18n()
const router = useRouter()

// ---------------------------------------------------------------------------
// 区块一：贡献者头像墙
// ---------------------------------------------------------------------------

const contributorsResult = ref<ContributorsResult | null>(null)
const contributorsLoading = ref(false)
const contributorsError = ref<Error | null>(null)

async function loadContributors() {
  contributorsLoading.value = true
  contributorsError.value = null
  try {
    contributorsResult.value = await fetchContributors(props.repoPath)
  }
  catch (err) {
    contributorsResult.value = null
    contributorsError.value = err as Error
  }
  finally {
    contributorsLoading.value = false
  }
}

// ---------------------------------------------------------------------------
// 区块二：周趋势图
// ---------------------------------------------------------------------------

const trendResult = ref<TrendResult | null>(null)
const trendLoading = ref(false)
const trendError = ref<Error | null>(null)

async function loadTrend() {
  trendLoading.value = true
  trendError.value = null
  try {
    trendResult.value = await fetchContributorTrend(props.repoPath)
  }
  catch (err) {
    trendResult.value = null
    trendError.value = err as Error
  }
  finally {
    trendLoading.value = false
  }
}

// ---------------------------------------------------------------------------
// 区块三：Fork 表格
// ---------------------------------------------------------------------------

const forks = ref<ForkItem[]>([])
const forkTreeCount = ref(0)
const forksLoading = ref(false)
const forksError = ref<Error | null>(null)

async function loadForks() {
  forksLoading.value = true
  forksError.value = null
  try {
    const result = await fetchForks(props.repoPath)
    forks.value = result.forks
    forkTreeCount.value = result.forkTreeCount
  }
  catch (err) {
    forks.value = []
    forkTreeCount.value = 0
    forksError.value = err as Error
  }
  finally {
    forksLoading.value = false
  }
}

/** 跳转到 Fork 仓库（应用内详情页） */
function openFork(item: ForkItem) {
  void router.push(`/repos/${item.path}?tab=code`)
}

// ---------------------------------------------------------------------------
// 区块四：Star 用户（filter_type 必填：all | followed）
// ---------------------------------------------------------------------------

/** 「全部 / 仅关注」切换（默认 all；切换只重拉本区块） */
const starFilter = ref<StarFilterType>('all')
const starResult = ref<StarUsersResult | null>(null)
const starLoading = ref(false)
const starError = ref<Error | null>(null)

async function loadStars() {
  starLoading.value = true
  starError.value = null
  try {
    starResult.value = await fetchStarUsers(props.repoPath, starFilter.value)
  }
  catch (err) {
    starResult.value = null
    starError.value = err as Error
  }
  finally {
    starLoading.value = false
  }
}

// 切换筛选重拉 Star 区块
watch(starFilter, () => void loadStars())

/** Star 用户展示名（nickname 缺省回退 username） */
function starDisplayName(username: string, nickname: string): string {
  return nickname || username
}

/** 头像墙条目的头像地址（服务端 avatar 空 → CNB 规则 URL 兜底） */
function contributorAvatar(username: string): string {
  return cnbAvatarUrl(username)
}

// 仓库切换：四区块全部重拉（watch 一处统一触发）
watch(
  () => props.repoPath,
  () => {
    void loadContributors()
    void loadTrend()
    void loadForks()
    void loadStars()
  },
  { immediate: true },
)
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- 区块一：贡献者头像墙（验收 1） -->
    <UCard :ui="{ body: 'flex flex-col gap-3' }">
      <h3 class="text-sm font-semibold">
        {{ t('repo.community.contributors') }}
        <span
          v-if="contributorsResult && contributorsResult.total > 0"
          class="font-normal text-xs text-dimmed"
        >
          {{ t('repo.community.contributorCount', { count: contributorsResult.total }) }}
        </span>
      </h3>
      <StateAlert
        v-if="contributorsLoading"
        state="loading"
        loading-variant="plain"
      />
      <StateAlert
        v-else-if="contributorsError"
        state="error"
        :error="contributorsError"
        :retry="loadContributors"
      />
      <StateAlert
        v-else-if="!contributorsResult || contributorsResult.contributors.length === 0"
        state="empty"
        :empty-text="t('repo.community.noContributors')"
      />
      <!-- 头像墙：tooltip 显示用户名 + 提交数（withNpcCounts 时区分 NPC） -->
      <div
        v-else
        class="flex flex-wrap gap-2"
      >
        <UTooltip
          v-for="person in contributorsResult.contributors"
          :key="person.username"
          :text="contributorsResult.withNpcCounts
            ? t('repo.community.contributorTipNpc', {
              name: person.username,
              commits: person.commitCount,
              npc: person.npcCommitCount,
            })
            : t('repo.community.contributorTip', { name: person.username, commits: person.commitCount })"
        >
          <UAvatar
            :src="contributorAvatar(person.username)"
            :alt="person.username"
            size="md"
          />
        </UTooltip>
      </div>
    </UCard>

    <!-- 区块二：周趋势图（验收 2：空数组不渲染图表容器） -->
    <UCard :ui="{ body: 'flex flex-col gap-3' }">
      <h3 class="text-sm font-semibold">
        {{ t('repo.community.trend') }}
      </h3>
      <StateAlert
        v-if="trendLoading"
        state="loading"
        loading-variant="plain"
      />
      <StateAlert
        v-else-if="trendError"
        state="error"
        :error="trendError"
        :retry="loadTrend"
      />
      <!-- weeks 为空：不渲染图表容器（ContributorTrendChart 内部同样有空态守卫） -->
      <ContributorTrendChart
        v-else-if="trendResult && trendResult.weeks.length > 0"
        :weeks="trendResult.weeks"
        :with-line-counts="trendResult.withLineCounts"
      />
      <p
        v-else
        class="text-xs text-dimmed"
      >
        {{ t('repo.community.noTrend') }}
      </p>
    </UCard>

    <!-- 区块三：Fork 表格（验收 3：路径/用户/时间，点击跳转） -->
    <UCard :ui="{ body: 'flex flex-col gap-3' }">
      <h3 class="text-sm font-semibold">
        {{ t('repo.community.forks') }}
        <span
          v-if="forkTreeCount > 0"
          class="font-normal text-xs text-dimmed"
        >
          {{ t('repo.community.forkCount', { count: forkTreeCount }) }}
        </span>
      </h3>
      <StateAlert
        v-if="forksLoading"
        state="loading"
      />
      <StateAlert
        v-else-if="forksError"
        state="error"
        :error="forksError"
        :retry="loadForks"
      />
      <StateAlert
        v-else-if="forks.length === 0"
        state="empty"
        :empty-text="t('repo.community.noForks')"
      />
      <!-- Fork 表格：路径 / 用户 / 时间（语义 table，行可点击跳转该 Fork 仓库） -->
      <div
        v-else
        class="overflow-x-auto"
      >
        <table class="w-full text-sm">
          <thead>
            <tr class="text-left text-xs text-dimmed border-b border-default">
              <th class="py-2 pr-3 font-medium">
                {{ t('repo.community.forkRepo') }}
              </th>
              <th class="py-2 pr-3 font-medium">
                {{ t('repo.community.forkUser') }}
              </th>
              <th class="py-2 font-medium">
                {{ t('repo.community.forkTime') }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="item in forks"
              :key="item.path"
              class="border-b border-default last:border-0 cursor-pointer hover:bg-elevated/50 transition"
              @click="openFork(item)"
            >
              <td class="py-2 pr-3 font-mono text-xs truncate max-w-0">
                {{ item.path }}
              </td>
              <td class="py-2 pr-3 truncate max-w-0">
                {{ item.nickname || item.username }}
              </td>
              <td class="py-2 text-xs text-dimmed whitespace-nowrap">
                {{ item.createdAt ? formatDateTime(item.createdAt) : '' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </UCard>

    <!-- 区块四：Star 用户（验收 4：filter_type 切换生效；403 独立降级） -->
    <UCard :ui="{ body: 'flex flex-col gap-3' }">
      <div class="flex items-center justify-between gap-2 flex-wrap">
        <h3 class="text-sm font-semibold">
          {{ t('repo.community.stars') }}
          <span
            v-if="starResult"
            class="font-normal text-xs text-dimmed"
          >
            {{ t('repo.community.starCount', { count: starResult.total, followed: starResult.myFollowCount }) }}
          </span>
        </h3>
        <USelect
          v-model="starFilter"
          size="sm"
          class="w-32"
          :items="[{
            label: t('repo.community.starFilterAll'),
            value: 'all',
          }, {
            label: t('repo.community.starFilterFollowed'),
            value: 'followed',
          }]"
          value-key="value"
          :aria-label="t('repo.community.starFilterLabel')"
        />
      </div>
      <StateAlert
        v-if="starLoading"
        state="loading"
        loading-variant="plain"
      />
      <StateAlert
        v-else-if="starError"
        state="error"
        :error="starError"
        :retry="loadStars"
      />
      <StateAlert
        v-else-if="!starResult || starResult.users.length === 0"
        state="empty"
        :empty-text="t('repo.community.noStars')"
      />
      <!-- Star 用户列表：头像 + 昵称 + 关注标记 + star 时间 -->
      <ul
        v-else
        class="flex flex-col divide-y divide-default"
      >
        <li
          v-for="person in starResult.users"
          :key="person.username"
          class="flex items-center gap-3 py-2"
        >
          <UAvatar
            :src="starUserAvatar(person)"
            :alt="person.username"
            size="sm"
          />
          <div class="min-w-0 flex flex-col">
            <span class="text-sm truncate">{{ starDisplayName(person.username, person.nickname) }}</span>
            <span class="text-xs text-dimmed truncate">{{ person.username }}</span>
          </div>
          <UBadge
            v-if="person.isFollow"
            size="sm"
            color="primary"
            variant="subtle"
            class="ml-auto shrink-0"
          >
            {{ t('repo.community.following') }}
          </UBadge>
          <span
            v-else-if="person.staredAt"
            class="ml-auto text-xs text-dimmed shrink-0"
          >
            {{ formatDateTime(person.staredAt) }}
          </span>
        </li>
      </ul>
    </UCard>
  </div>
</template>
