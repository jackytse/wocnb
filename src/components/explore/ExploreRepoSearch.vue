<script setup lang="ts">
/**
 * 探索页·公共仓库搜索（T15 验收 2/5）。
 *
 * 口径（§7.2 / R14）：
 * - 300ms 防抖（watch keyword → setTimeout）；空关键词不请求并清空结果；
 * - 参数名 key（swagger，不是 q）；topN 可选 10/30/50/100（默认 30）；
 * - **无分页**（API 不支持，UI 禁用分页 —— 禁止画翻页按钮）；
 * - 结果项：仓库名 / 描述 / star·fork 数，点击 router.push 进仓库页；
 * - initialKey：?q= 从 ⌘K「跳转探索页」动作项带入时自动触发一次搜索
 *   （⌘K 面板只带跳转动作，远程搜索不进面板 —— R14 踩坑红线）。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import {
  searchPublicRepos,
  type SearchRepoItem,
} from '../../composables/useCnbExplore'
import { formatRelativeTime } from '../../utils'
import StateAlert from '../repo/StateAlert.vue'

const props = defineProps<{
  /** 初始关键词（来自 ?q=，⌘K 动作项带入；非空时挂载即自动搜索一次） */
  initialKey?: string
}>()

const { t } = useI18n()
const router = useRouter()

const keyword = ref(props.initialKey || '')
const topN = ref<10 | 30 | 50 | 100>(30)
const topNItems = [
  { label: '10', value: 10 },
  { label: '30', value: 30 },
  { label: '50', value: 50 },
  { label: '100', value: 100 },
]

/**
 * 关键词最小长度（API 硬约束）。
 * 为什么前端拦：CNB 搜索接口要求 key 至少 2 个字符，更短直接返回
 * 400 "The search key is too short, at least 2 characters are required."
 * —— 不拦的话用户每敲 1 个字（防抖后）都会吃一个报错提示。
 */
const MIN_KEYWORD_LEN = 2

const results = ref<SearchRepoItem[]>([])
const loading = ref(false)
const error = ref<Error | null>(null)
/** 是否已执行过至少一次搜索（控制结果区与空态显隐） */
const hasSearched = ref(false)
/** 关键词非空但长度不足 MIN_KEYWORD_LEN：不发请求，空态区提示"太短" */
const tooShort = ref(false)

let debounceTimer: ReturnType<typeof setTimeout> | null = null

async function runSearch() {
  const trimmed = keyword.value.trim()
  if (!trimmed) {
    // 空关键词不请求（验收 2），同时清空旧结果
    results.value = []
    error.value = null
    hasSearched.value = false
    tooShort.value = false
    return
  }
  if (trimmed.length < MIN_KEYWORD_LEN) {
    // 不足 2 字符：不发请求（服务器必 400），空态区展示"太短"提示
    results.value = []
    error.value = null
    hasSearched.value = false
    tooShort.value = true
    return
  }
  tooShort.value = false
  loading.value = true
  error.value = null
  try {
    results.value = await searchPublicRepos(trimmed, { topN: topN.value })
    hasSearched.value = true
  }
  catch (err) {
    results.value = []
    error.value = err as Error
    hasSearched.value = true
  }
  finally {
    loading.value = false
  }
}

// 关键词 300ms 防抖（topN 变化立即重搜 —— 不改关键词不需要防抖）
watch(keyword, () => {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
  }
  debounceTimer = setTimeout(() => void runSearch(), 300)
})
watch(topN, () => void runSearch())

onBeforeUnmount(() => {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
  }
})

// initialKey 带入（⌘K 跳转）：挂载即自动触发一次（绕过防抖等待）
if (props.initialKey) {
  void runSearch()
}

/** 空态文案：太短提示 > 未搜索 > 无结果（tooShort 优先，刚输入 1 字即见提示） */
const emptyText = computed(() => {
  if (tooShort.value) {
    return t('explore.search.tooShort')
  }
  return hasSearched.value ? t('explore.search.noResults') : t('explore.search.hint')
})

function openRepo(path: string) {
  void router.push(`/repos/${path}?tab=code`)
}
</script>

<template>
  <!-- 卡片纵向撑满弹窗 body（explore.vue 的 UModal body 已改为 flex 不滚动）：
     根节点 flex flex-col + min-h-0 允许整体收缩，body 槽 flex-1 min-h-0
     接管"弹窗剩余高度"，让结果列表成为唯一的滚动容器（单滚动条约定） -->
  <UCard class="w-full flex flex-col min-h-0" :ui="{ body: 'flex flex-col gap-3 flex-1 min-h-0' }">
    <!-- 头部行：标题与 topN 同行（标题左、条数右），输入框独占下一行全宽
         —— 原先三行纵排让卡片显得松散，也让榜单在窄屏被挤得更靠下 -->
    <div class="flex items-center justify-between gap-2 flex-wrap">
      <h3 class="text-sm font-semibold">
        {{ t('explore.search.title') }}
      </h3>
      <USelect
        v-model="topN"
        size="sm"
        class="w-24"
        :items="topNItems"
        value-key="value"
        :aria-label="t('explore.search.topN')"
      />
    </div>

    <!-- 搜索行：关键词全宽（回车立即搜索，绕过 300ms 防抖等待）。
         autofocus：弹窗打开即挂载本组件，挂载后自动聚焦输入框（用户要求
         "弹窗激活后文本框获取焦点"）；略微延迟等待 UModal 的 portal 完成
         渲染，避免焦点被 reka-ui 的初始聚焦抢占 -->
    <UInput
      v-model="keyword"
      variant="soft"
      icon="i-lucide-search"
      :placeholder="t('explore.search.placeholder')"
      class="w-full"
      autocomplete="off"
      autofocus
      :autofocus-delay="60"
      @keydown.enter="runSearch"
    />

    <StateAlert
      v-if="loading"
      state="loading"
    />
    <StateAlert
      v-else-if="error"
      state="error"
      :error="error"
      :retry="runSearch"
    />
    <StateAlert
      v-else-if="results.length === 0"
      state="empty"
      :empty-text="emptyText"
    />
    <!-- 结果列表（无分页 —— API 不支持，验收 2）。
         内滚：以前写死 max-h-[28rem]，与 UModal body 自带的 overflow-y-auto
         叠出两根滚动条；现在改 flex-1 min-h-0 自适应"卡片剩余高度"
         （高度跟随弹窗/窗口），全弹窗只剩这一根滚动条 -->
    <div
      v-else
      class="flex flex-col gap-2 flex-1 min-h-0 overflow-y-auto -mr-1 pr-1"
    >
      <button
        v-for="item in results"
        :key="item.path"
        type="button"
        class="flex items-start gap-3 px-4 py-2.5 rounded-lg border border-default text-left hover:bg-elevated/50 cursor-pointer"
        @click="openRepo(item.path)"
      >
        <UIcon
          name="i-lucide-folder-git-2"
          class="size-4 text-muted shrink-0 mt-0.5"
        />
        <span class="min-w-0 flex-1 flex flex-col gap-0.5">
          <span class="text-sm font-medium text-highlighted truncate">{{ item.name }}</span>
          <span
            v-if="item.description"
            class="text-xs text-dimmed line-clamp-1"
          >{{ item.description }}</span>
        </span>
        <span class="flex items-center gap-3 text-xs text-dimmed shrink-0 mt-0.5">
          <span
            v-if="item.starCount > 0"
            class="inline-flex items-center gap-1"
          >
            <UIcon
              name="i-lucide-star"
              class="size-3"
            />
            {{ item.starCount }}
          </span>
          <span
            v-if="item.forkCount > 0"
            class="inline-flex items-center gap-1"
          >
            <UIcon
              name="i-lucide-git-fork"
              class="size-3"
            />
            {{ item.forkCount }}
          </span>
          <span
            v-if="item.updatedAt"
            class="hidden sm:inline"
          >{{ formatRelativeTime(item.updatedAt) }}</span>
        </span>
      </button>
    </div>
  </UCard>
</template>
