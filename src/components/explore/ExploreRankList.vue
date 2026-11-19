<script setup lang="ts">
/**
 * 探索页·仓库排行榜（T15 验收 3/4）。
 *
 * 数据：GET /ranks/repo/{daily|weekly|annual}?language=&topN=30；
 * 语言下拉数据源 GET /ranks/repo/language-list?rankType=（**rankType 必填**，
 * 切换周期时语言清单随周期重拉，语言选择同步重置）。
 * 榜单项展示 increase_star / increase_fork 增量与 updated_at（验收 4）。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import {
  fetchRankLanguageList,
  fetchRepoRank,
  type RankItem,
  type RankType,
} from '../../composables/useCnbExplore'
import { formatDateTime } from '../../utils'
import StateAlert from '../repo/StateAlert.vue'

const { t } = useI18n()
const router = useRouter()

// ---------------------------------------------------------------------------
// 周期 Tab（日/周/年）
// ---------------------------------------------------------------------------

const rankType = ref<RankType>('daily')
const rankTypeItems = computed(() => [
  { label: t('explore.rank.daily'), value: 'daily' },
  { label: t('explore.rank.weekly'), value: 'weekly' },
  { label: t('explore.rank.annual'), value: 'annual' },
])

// ---------------------------------------------------------------------------
// 语言筛选（language-list?rankType=，rankType 必填）
// ---------------------------------------------------------------------------

const languages = ref<string[]>([])
const languageLoading = ref(false)
/** 当前选中语言（'' = 全部） */
const selectedLanguage = ref('')

async function loadLanguages() {
  languageLoading.value = true
  try {
    languages.value = await fetchRankLanguageList(rankType.value)
  }
  catch {
    // 语言清单失败：下拉降级为「全部」单项，榜单主体不受阻
    languages.value = []
  }
  finally {
    languageLoading.value = false
  }
}

// 切换周期：语言选择重置 + 清单与榜单重拉（rankType 必填口径）。
// ⚠️ 这个 watch 必须放在 items/loading 等榜单状态声明**之后**（见文件下方）：
// immediate 回调在 setup 阶段同步执行，若此时 loadRank 内引用的 ref 还在
// TDZ（暂时性死区），async 函数体内第一行就会抛 ReferenceError 且被 void
// 吞掉 —— 首次加载静默失败、日榜"不自动加载"（点 Tab 后才恢复，正是
// 因为后续触发发生在 setup 完成之后）。
watch(selectedLanguage, () => void loadRank())

/** 语言下拉项：「全部」置顶 + 语言清单（清单为空时只有「全部」） */
const languageItems = computed(() => [
  { label: t('explore.rank.allLanguages'), value: '' },
  ...languages.value.map(lang => ({ label: lang, value: lang })),
])

// ---------------------------------------------------------------------------
// 榜单
// ---------------------------------------------------------------------------

const items = ref<RankItem[]>([])
const updatedAt = ref('')
const loading = ref(false)
const error = ref<Error | null>(null)

async function loadRank() {
  loading.value = true
  error.value = null
  try {
    const result = await fetchRepoRank(rankType.value, {
      language: selectedLanguage.value || undefined,
      topN: 30,
    })
    items.value = result.items
    updatedAt.value = result.updatedAt
  }
  catch (err) {
    items.value = []
    updatedAt.value = ''
    error.value = err as Error
  }
  finally {
    loading.value = false
  }
}

function openRepo(path: string) {
  void router.push(`/repos/${path}?tab=code`)
}

// 切换周期：语言选择重置 + 清单与榜单重拉（rankType 必填口径）。
// ⚠️ 放在所有 ref 声明之后：immediate 回调在 setup 阶段同步执行，
// loadRank 里引用的 loading/items 必须已初始化（见上方 selectedLanguage
// watch 注释 —— 曾因顺序颠倒导致日榜首次加载静默失败的 TDZ 陷阱）
watch(rankType, () => {
  selectedLanguage.value = ''
  void loadLanguages()
  void loadRank()
}, { immediate: true })
</script>

<template>
  <UCard :ui="{ body: 'flex flex-col gap-3' }">
    <div class="flex items-center justify-between gap-2 flex-wrap">
      <h3 class="text-sm font-semibold">
        {{ t('explore.rank.title') }}
      </h3>
      <USelect
        v-model="selectedLanguage"
        size="sm"
        class="w-44"
        :items="languageItems"
        value-key="value"
        :disabled="languageLoading && languages.length === 0"
        :aria-label="t('explore.rank.languageFilter')"
      />
    </div>

    <!-- 周期 Tab（日/周/年三 Tab 切换，验收 3） -->
    <UTabs
      v-model="rankType"
      :items="rankTypeItems"
      color="neutral"
    />

    <p
      v-if="updatedAt"
      class="text-xs text-dimmed"
    >
      {{ t('explore.rank.updatedAt', { time: formatDateTime(updatedAt) }) }}
    </p>

    <StateAlert
      v-if="loading"
      state="loading"
    />
    <StateAlert
      v-else-if="error"
      state="error"
      :error="error"
      :retry="loadRank"
    />
    <StateAlert
      v-else-if="items.length === 0"
      state="empty"
      :empty-text="t('explore.rank.empty')"
    />
    <!-- 榜单列表：名次 + 仓库 + 增量（increase_star/increase_fork）+ 更新时间。
         不做内部限高滚动：内滚会让页面出现两个滚动条（页面级 + 列表级），
         榜单随页面自然滚动即可 -->
    <ol
      v-else
      class="flex flex-col gap-2"
    >
      <li
        v-for="(item, index) in items"
        :key="item.path"
      >
        <button
          type="button"
          class="flex items-center gap-3 px-4 py-2.5 w-full rounded-lg border border-default text-left hover:bg-elevated/50 cursor-pointer"
          @click="openRepo(item.path)"
        >
          <UBadge
            :color="index < 3 ? 'primary' : 'neutral'"
            variant="subtle"
            size="sm"
            :label="String(index + 1)"
            class="shrink-0 font-mono"
          />
          <span class="min-w-0 flex-1 flex flex-col gap-0.5">
            <span class="text-sm font-medium text-highlighted truncate">{{ item.name }}</span>
            <span
              v-if="item.description"
              class="text-xs text-dimmed line-clamp-1"
            >{{ item.description }}</span>
          </span>
          <span class="flex items-center gap-3 text-xs text-dimmed shrink-0">
            <span class="inline-flex items-center gap-1 text-success">
              <UIcon
                name="i-lucide-star"
                class="size-3"
              />
              +{{ item.increaseStar }}
            </span>
            <span class="inline-flex items-center gap-1">
              <UIcon
                name="i-lucide-git-fork"
                class="size-3"
              />
              +{{ item.increaseFork }}
            </span>
            <span
              v-if="item.updatedAt"
              class="hidden lg:inline"
            >{{ formatDateTime(item.updatedAt) }}</span>
          </span>
        </button>
      </li>
    </ol>
  </UCard>
</template>
