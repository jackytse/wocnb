<script setup lang="ts">
/**
 * Issue 列表（通用组件）—— Home 页「待办」「我创建的」选项卡共用。
 *
 * 数据来源：CNB Open API GET /user/issues（令牌需包含 repo-issue:r 权限）：
 * - filter=assigned：分配给我的开启中 Issue（「待办」）；
 * - filter=created：我创建的开启中 Issue（「我创建的」）。
 *
 * 加载策略：active 首次变为 true 时拉取一次（选项卡懒加载，避免
 * 首页加载就发请求）；之后数据驻留内存，再次切回不重复请求，
 * 由调用方在需要刷新时调用 reload()（defineExpose）。
 * 点击条目：进入应用内 Issue 详情（/repos/<repoPath>?tab=issues&number=<n>）。
 */
import { ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { formatTimeAgo } from '@vueuse/core'
import { fetchCnbUserIssues, type CnbUserIssue } from '../composables/useCnbAuth'

const router = useRouter()

/** 组件属性 */
const props = defineProps<{
  /** Issue 筛选类型：assigned（待办）/ created（我创建的） */
  filter: 'assigned' | 'created'
  /** 所在选项卡是否处于激活态（首次激活时懒加载） */
  active: boolean
}>()

// 界面文案翻译（空态/失败重试均随语言切换）
const { t } = useI18n()

/** Issue 条目列表 */
const issues = ref<CnbUserIssue[]>([])
/** 加载中状态（骨架屏） */
const loading = ref(false)
/** 加载失败标记（显示重试入口） */
const loadError = ref(false)
/** 是否已完成首次加载（保证懒加载只发生一次，切回选项卡不重复请求） */
const loadedOnce = ref(false)

/** 拉取 Issue 列表 */
async function loadIssues() {
  loading.value = true
  loadError.value = false
  try {
    issues.value = await fetchCnbUserIssues(props.filter)
    loadedOnce.value = true
  }
  catch {
    issues.value = []
    loadError.value = true
  }
  finally {
    loading.value = false
  }
}

// 选项卡首次激活时懒加载（active 为响应式 prop，watch 自动跟踪）
watch(() => props.active, (active) => {
  if (active && !loadedOnce.value) {
    void loadIssues()
  }
}, { immediate: true })

/** 进入应用内 Issue 详情（不再外跳浏览器；仓库路径经 catch-all 路由解析） */
function openIssue(issue: CnbUserIssue) {
  if (!issue.repoPath || !issue.number) {
    return
  }
  void router.push(`/repos/${issue.repoPath}?tab=issues&number=${issue.number}`)
}

/** 供调用方强制刷新（defineExpose） */
defineExpose({ reload: loadIssues })
</script>

<template>
  <!-- 加载中：骨架屏 -->
  <div v-if="loading" class="flex flex-col gap-3">
    <USkeleton v-for="i in 5" :key="i" class="h-14 w-full rounded-md" />
  </div>

  <!-- 加载失败：提示 + 重试 -->
  <UAlert
    v-else-if="loadError"
    icon="i-lucide-cloud-alert"
    color="error"
    variant="soft"
    :title="t('home.issues.loadFailedTitle')"
    :description="t('home.issues.loadFailedDesc')"
  >
    <template #actions>
      <UButton
        size="sm"
        color="error"
        variant="soft"
        icon="i-lucide-refresh-cw"
        @click="loadIssues"
      >
        {{ t('common.retry') }}
      </UButton>
    </template>
  </UAlert>

  <!-- 空态：按筛选类型给出不同的引导文案 -->
  <div v-else-if="issues.length === 0" class="flex flex-col items-center gap-2 py-12 text-center">
    <UIcon name="i-lucide-circle-check" class="size-10 text-dimmed" />
    <p class="text-sm text-muted">
      {{ t('home.issues.emptyTitle') }}
    </p>
    <p class="text-xs text-dimmed">
      {{ filter === 'assigned' ? t('home.issues.emptyDescAssigned') : t('home.issues.emptyDescCreated') }}
    </p>
  </div>

  <!-- Issue 列表：点击在系统浏览器打开 Issue 详情页 -->
  <div v-else class="flex flex-col gap-1">
    <button
      v-for="issue in issues"
      :key="`${issue.repoPath}-${issue.number}`"
      type="button"
      class="w-full text-left px-3 py-2.5 rounded-md hover:bg-elevated/50 flex items-center gap-3 relative -mx-3 cursor-pointer"
      @click="openIssue(issue)"
    >
      <!-- 状态图标：open 绿色圆点 / closed 紫色勾选（GitHub 风格语义） -->
      <UIcon
        :name="issue.state === 'open' ? 'i-lucide-circle-dot' : 'i-lucide-circle-check-big'"
        class="size-4 shrink-0"
        :class="issue.state === 'open' ? 'text-success' : 'text-purple-500'"
      />

      <div class="text-sm flex-1 min-w-0">
        <p class="flex items-center justify-between gap-2">
          <span class="text-highlighted font-medium truncate">{{ issue.title }}</span>
          <time
            v-if="issue.updatedAt"
            :datetime="issue.updatedAt"
            class="text-muted text-xs shrink-0"
            v-text="formatTimeAgo(new Date(issue.updatedAt))"
          />
        </p>
        <p class="text-dimmed flex items-center gap-2 flex-wrap mt-0.5">
          <!-- 所属仓库：定位 Issue 归属（跨仓库列表必备上下文） -->
          <span class="truncate">{{ issue.repoPath }}#{{ issue.number }}</span>
          <!-- 优先级徽标（CNB 枚举：-2P ~ P3，空表示未设置） -->
          <UBadge
            v-if="issue.priority"
            color="warning"
            variant="subtle"
            size="sm"
            :label="issue.priority"
          />
          <!-- 标签（最多 10 个，展示前 3 个防溢出，颜色用 CNB 返回的标签色） -->
          <UBadge
            v-for="label in issue.labels.slice(0, 3)"
            :key="label.name"
            variant="subtle"
            size="sm"
            :label="label.name"
            :style="label.color ? { color: label.color } : undefined"
          />
          <!-- 评论数 -->
          <span v-if="issue.commentCount > 0" class="inline-flex items-center gap-0.5 shrink-0">
            <UIcon name="i-lucide-message-square" class="size-3" />
            {{ issue.commentCount }}
          </span>
        </p>
      </div>
    </button>
  </div>
</template>
