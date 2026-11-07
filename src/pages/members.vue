<script setup lang="ts">
/**
 * 组织成员页（PRD P0-E2）：成员 / 外部贡献者双页签。
 *
 * 数据：GET /{group}/-/members（group-manage:r）与
 * GET /{slug}/-/outside-collaborators（repo-manage:r），
 * slug 跟随侧边栏 selectedGroup 切换联动刷新。
 * query 定位：tab（members/outsiders，默认 members）/ keyword / page。
 * 403 降级：StateAlert 呈现缺失 scope + 外跳管理页（不登出）。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { openUrl } from '@tauri-apps/plugin-opener'
import type { TabsItem } from '@nuxt/ui'
import {
  fetchGroupMembers,
  fetchOutsideCollaborators,
} from '../composables/useCnbMembers'
import { cnbGroupUrl, selectedGroup } from '../composables/useCnbAuth'
import { formatDateTime } from '../utils'
import StateAlert from '../components/repo/StateAlert.vue'

const { t } = useI18n()

// 路由对象显式导入（本项目仅 Nuxt UI 组合式函数走自动导入）
const route = useRoute()
const router = useRouter()

// ---------------------------------------------------------------------------
// query 读写（tab / keyword / page，语义与仓库详情一致：tab 切换 replace）
// ---------------------------------------------------------------------------

/** 当前页签（非法值归一 members） */
const tab = computed<'members' | 'outsiders'>(() =>
  route.query.tab === 'outsiders' ? 'outsiders' : 'members',
)

const keyword = computed(() =>
  typeof route.query.keyword === 'string' ? route.query.keyword : '',
)
const page = computed(() => {
  const n = Number(route.query.page)
  return Number.isInteger(n) && n > 0 ? n : 1
})

/** 本地搜索草稿（回车写入 query） */
const keywordDraft = ref(keyword.value)
watch(keyword, value => (keywordDraft.value = value))

/** 导航：合并 query 写回（replace） */
function navigate(partial: Record<string, string | null>) {
  const query: Record<string, string> = {}
  for (const [key, value] of Object.entries(route.query)) {
    if (typeof value === 'string' && value && !(key in partial)) {
      query[key] = value
    }
  }
  for (const [key, value] of Object.entries(partial)) {
    if (value === null || value === '') {
      delete query[key]
    }
    else {
      query[key] = value
    }
  }
  void router.replace({ path: route.path, query })
}

/** 切换页签（replace，重置 keyword/page） */
function switchTab(value: 'members' | 'outsiders') {
  navigate({ tab: value === 'members' ? null : value, keyword: null, page: null })
}

/** 关键词回车（replace，重置页码） */
function onKeywordEnter() {
  navigate({ keyword: keywordDraft.value.trim() || null, page: null })
}

// ---------------------------------------------------------------------------
// 数据加载（跟随 selectedGroup 切换联动）
// ---------------------------------------------------------------------------

const members = ref<{ username: string, nickname: string, avatar: string, accessLevel: string, joinTime: string }[]>([])
const loading = ref(false)
const error = ref<Error | null>(null)

async function load() {
  const slug = selectedGroup.value?.path
  if (!slug) {
    members.value = []
    return
  }
  loading.value = true
  error.value = null
  try {
    members.value = tab.value === 'members'
      ? await fetchGroupMembers(slug, { search: keyword.value || undefined, page: page.value })
      : await fetchOutsideCollaborators(slug, { search: keyword.value || undefined, page: page.value })
  }
  catch (err) {
    members.value = []
    error.value = err as Error
  }
  finally {
    loading.value = false
  }
}

// 组织切换 / 页签 / 关键词 / 页码 任一变化重载
watch(
  () => `${selectedGroup.value?.path}|${tab.value}|${keyword.value}|${page.value}`,
  () => void load(),
  { immediate: true },
)

/** 页签定义（UTabs 受控模式） */
const tabItems = computed((): TabsItem[] => [
  { label: t('members.tabMembers'), icon: 'i-lucide-users', value: 'members' },
  { label: t('members.tabOutsiders'), icon: 'i-lucide-user-check', value: 'outsiders' },
])

/** 空态区分：有搜索词 → "无匹配"；否则 → "暂无成员" */
const emptyText = computed(() => keyword.value ? t('members.emptyFiltered') : t('members.empty'))

/** 成员管理外跳（成员页 → 组织主页成员区；贡献者页 → 组织主页） */
const manageUrl = computed(() => selectedGroup.value ? cnbGroupUrl(selectedGroup.value.path) : 'https://cnb.cool')

function openManage() {
  if ('__TAURI_INTERNALS__' in window) {
    void openUrl(manageUrl.value)
  }
  else {
    window.open(manageUrl.value, '_blank')
  }
}
</script>

<template>
  <UDashboardPanel id="members">
    <template #header>
      <UDashboardNavbar :title="t('members.title')">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <!-- 组织上下文（跟随侧边栏 GroupsMenu 切换） -->
      <div class="flex items-center gap-2 mb-3 flex-wrap">
        <UIcon name="i-lucide-users" class="size-5 text-muted" />
        <h2 class="text-lg font-semibold text-highlighted">
          {{ t('members.title') }}
        </h2>
        <UBadge
          v-if="selectedGroup"
          color="neutral"
          variant="subtle"
          :label="selectedGroup.path"
        />
        <UButton
          class="ms-auto"
          size="sm"
          color="neutral"
          variant="outline"
          icon="i-lucide-external-link"
          :label="t('members.manageInBrowser')"
          @click="openManage"
        />
      </div>

      <UTabs
        :model-value="tab"
        :items="tabItems"
        color="neutral"
        class="mb-4"
        @update:model-value="(value: string | number) => switchTab(value as 'members' | 'outsiders')"
      />

      <!-- 搜索（透传服务端 search 参数） -->
      <UInput
        v-model="keywordDraft"
        size="sm"
        variant="soft"
        icon="i-lucide-search"
        :placeholder="t('members.searchPlaceholder')"
        class="mb-3 max-w-sm"
        @keydown.enter="onKeywordEnter"
      />

      <!-- 三态 + 403 降级 -->
      <StateAlert
        v-if="loading"
        state="loading"
        loading-variant="list"
      />
      <StateAlert
        v-else-if="error"
        state="error"
        :error="error"
        :site-url="manageUrl"
        :retry="load"
      />
      <StateAlert
        v-else-if="members.length === 0"
        state="empty"
        :empty-text="emptyText"
      />
      <div v-else class="flex flex-col gap-2">
        <div
          v-for="member in members"
          :key="member.username"
          class="flex items-center gap-3 px-4 py-3 rounded-lg border border-default"
        >
          <UAvatar :src="member.avatar" :alt="member.nickname" size="md" />
          <div class="min-w-0 flex-1">
            <p class="text-sm font-medium text-highlighted truncate">
              {{ member.nickname }}
              <span class="text-dimmed font-normal">@{{ member.username }}</span>
            </p>
            <p v-if="member.joinTime" class="text-xs text-dimmed">
              {{ t('members.joined', { time: formatDateTime(member.joinTime) }) }}
            </p>
          </div>
          <!-- 权限级别（constant.AccessRole：Guest/Reporter/Developer/Master/Owner） -->
          <UBadge
            v-if="member.accessLevel"
            color="neutral"
            variant="subtle"
            size="sm"
            :label="member.accessLevel"
          />
        </div>
      </div>
    </template>
  </UDashboardPanel>
</template>
