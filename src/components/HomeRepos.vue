<script setup lang="ts">
/**
 * 「组织仓库」列表（仓库页内容组件）。
 *
 * 数据来源：CNB Open API GET /{slug}/-/repos（查询组织可见仓库，
 * 含子组织，descendant=1），slug 取自全局共享的 selectedGroup——
 * 即侧边栏 GroupsMenu 当前选中的组织，切换组织后本组件自动重新加载。
 *
 * 状态处理：加载中骨架屏 / 加载失败可重试 / 无仓库空态。
 * 点击仓库卡片：进入应用内仓库详情（/repos/<path>?tab=code），
 * 卡片右侧提供「在浏览器打开」外跳按钮兜底。
 */
import { ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { format } from 'date-fns'
import { openUrl } from '@tauri-apps/plugin-opener'
import {
  fetchCnbGroupRepos,
  selectedGroup,
  type CnbRepo,
} from '../composables/useCnbAuth'
// 可见性徽标抽到 useCnbRepo 共享（RepoHeader 与本组件同源）
import { visibilityBadge } from '../composables/useCnbRepo'

const router = useRouter()
// 界面文案翻译（标题/计数徽标/失败重试/空态均随语言切换）
const { t } = useI18n()

/** 当前组织下的仓库列表 */
const repos = ref<CnbRepo[]>([])
/** 加载中状态（骨架屏） */
const loading = ref(false)
/** 加载失败标记（显示重试入口） */
const loadError = ref(false)

/**
 * 拉取选中组织的仓库列表。
 * 无选中组织（组织列表尚未加载完）时静默跳过，等待 watch 触发。
 */
async function loadRepos() {
  const slug = selectedGroup.value?.path
  if (!slug) {
    return
  }
  loading.value = true
  loadError.value = false
  try {
    repos.value = await fetchCnbGroupRepos(slug)
  }
  catch {
    // 失败时清空列表并显示重试入口（401 拦截器会自动处理登录态过期）
    repos.value = []
    loadError.value = true
  }
  finally {
    loading.value = false
  }
}

// 监听共享组织状态：GroupsMenu 切换组织后立即重新加载（immediate 覆盖
// 首页先于侧边栏加载完成的场景——selectedGroup 就绪时自动触发首拉）
watch(() => selectedGroup.value?.path, () => {
  void loadRepos()
}, { immediate: true })

/** 最近更新时间的展示格式（ISO -> yyyy-MM-dd HH:mm） */
function formatTime(iso: string): string {
  if (!iso) {
    return ''
  }
  try {
    return format(new Date(iso), 'yyyy-MM-dd HH:mm')
  }
  catch {
    return iso
  }
}

/**
 * 可见性徽标已抽到 useCnbRepo.visibilityBadge 共享（含 Private/Public/Secret
 * 三值与未知值兜底逻辑），本组件与仓库详情头部使用同一实现。
 */

/** 进入应用内仓库详情（不再外跳浏览器；外跳走卡片右侧的独立按钮） */
function openInApp(repo: CnbRepo) {
  if (!repo.path) {
    return
  }
  // 多级子组织路径直接拼接（catch-all 路由解析），默认进代码页签
  void router.push(`/repos/${repo.path}?tab=code`)
}

/** 在系统浏览器打开仓库页（卡片右侧外跳按钮专用，阻断卡片点击冒泡） */
function openExternal(repo: CnbRepo, event: Event) {
  event.stopPropagation()
  if (!repo.webUrl) {
    return
  }
  if ('__TAURI_INTERNALS__' in window) {
    void openUrl(repo.webUrl)
  }
  else {
    window.open(repo.webUrl, '_blank')
  }
}
</script>

<template>
  <div>
    <!-- 标题：显示当前组织名，让"侧边栏切换组织 -> 列表联动"可见可感知 -->
    <div class="flex items-center gap-2 mb-3">
      <UIcon name="i-lucide-folder-git-2" class="size-5 text-muted" />
      <h2 class="text-lg font-semibold text-highlighted">
        {{ t('home.reposTitle') }}
      </h2>
      <UBadge
        v-if="selectedGroup"
        color="neutral"
        variant="subtle"
        :label="selectedGroup.path"
      />
      <UBadge
        v-if="!loading && !loadError"
        color="neutral"
        variant="subtle"
        :label="t('home.reposCount', repos.length)"
      />
    </div>

    <!-- 加载中：骨架屏占位，避免布局跳动 -->
    <div v-if="loading" class="flex flex-col gap-3">
      <USkeleton v-for="i in 5" :key="i" class="h-16 w-full rounded-lg" />
    </div>

    <!-- 加载失败：提示 + 重试 -->
    <UAlert
      v-else-if="loadError"
      icon="i-lucide-cloud-alert"
      color="error"
      variant="soft"
      :title="t('home.reposLoadFailedTitle')"
      :description="t('home.reposLoadFailedDesc')"
      class="mb-3"
    >
      <template #actions>
        <UButton
          size="sm"
          color="error"
          variant="soft"
          icon="i-lucide-refresh-cw"
          @click="loadRepos"
        >
          {{ t('common.retry') }}
        </UButton>
      </template>
    </UAlert>

    <!-- 空态：组织下暂无仓库 -->
    <UAlert
      v-else-if="repos.length === 0"
      icon="i-lucide-folder-open"
      color="neutral"
      variant="soft"
      :title="t('home.reposEmpty')"
    />

    <!-- 仓库列表：卡片式，点击进入应用内详情；右侧外跳按钮兜底 -->
    <div v-else class="flex flex-col gap-3">
      <button
        v-for="repo in repos"
        :key="repo.path"
        type="button"
        class="w-full text-left p-4 rounded-lg border border-default bg-default hover:bg-elevated/50 transition-colors cursor-pointer"
        @click="openInApp(repo)"
      >
        <div class="flex items-center gap-2 flex-wrap">
          <UIcon name="i-lucide-book-marked" class="size-4 text-muted shrink-0" />
          <span class="font-medium text-highlighted">{{ repo.path }}</span>
          <UBadge
            :color="visibilityBadge(repo.visibility).color"
            variant="subtle"
            size="sm"
            :label="visibilityBadge(repo.visibility).label"
          />
          <!-- 外跳按钮：stopPropagation 避免触发卡片的应用内导航 -->
          <UButton
            class="ms-auto"
            size="xs"
            color="neutral"
            variant="ghost"
            icon="i-lucide-external-link"
            :aria-label="t('common.openInBrowser')"
            @click="openExternal(repo, $event)"
          />
        </div>
        <p v-if="repo.description" class="mt-1 text-sm text-muted line-clamp-2">
          {{ repo.description }}
        </p>
        <div class="mt-2 flex items-center gap-4 text-xs text-muted flex-wrap">
          <!-- 主语言：GitHub 风格色点 -->
          <span v-if="repo.language" class="inline-flex items-center gap-1">
            <span
              class="size-2.5 rounded-full inline-block"
              :style="{ backgroundColor: repo.languageColor || '#8b949e' }"
            />
            {{ repo.language }}
          </span>
          <span class="inline-flex items-center gap-1">
            <UIcon name="i-lucide-star" class="size-3.5" />
            {{ repo.starCount }}
          </span>
          <span class="inline-flex items-center gap-1">
            <UIcon name="i-lucide-circle-dot" class="size-3.5" />
            {{ repo.issueCount }}
          </span>
          <span class="inline-flex items-center gap-1">
            <UIcon name="i-lucide-git-pull-request" class="size-3.5" />
            {{ repo.prCount }}
          </span>
          <span v-if="repo.updatedAt" class="ms-auto">
            {{ t('home.updatedAt', { time: formatTime(repo.updatedAt) }) }}
          </span>
        </div>
      </button>
    </div>
  </div>
</template>
