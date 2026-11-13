<script setup lang="ts">
/**
 * 提交比较视图（T11，提交页签下钻 ?compare=1）。
 *
 * 交互：base/head 各用 RepoBranchSelect（selectMode='emit'，本地选择态，
 * 不写 ?ref=）→ 点击「比较」拉取 GET /-/git/compare/{base...head}：
 * - 概览：ahead/behind（total_commits）+ 变更文件数；
 * - 文件 diff 复用 PullDiffView（PullFile[] 同构；patch 为空的二进制文件
 *   由 PullDiffView 显示「无文本差异」）；
 * - 区间提交列表（与提交列表同构，点击跳 ?sha= 详情）。
 *
 * 编码口径（验收 3）：`base...head` 三点整段编码在数据层 fetchCompare
 * 内完成（swagger 单 path 段），组件只负责拼接 base/head 字符串。
 * 404（ref 不存在等）→ StateAlert notFound（不自动回列表）。
 */
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  fetchCompare,
  type CompareResult,
} from '../../composables/useCnbRepo'
import { useRepoRoute } from '../../composables/useRepoRoute'
import StateAlert from './StateAlert.vue'
import RepoBranchSelect from './RepoBranchSelect.vue'
import PullDiffView from './PullDiffView.vue'

const props = defineProps<{
  repoPath: string
  /** 当前生效 ref（base 的缺省值） */
  gitRef: string
}>()

const { t } = useI18n()
const { openCommit, closeCompare } = useRepoRoute()

// ---------------------------------------------------------------------------
// base / head 选择（本地状态，比较动作显式触发）
// ---------------------------------------------------------------------------

const baseRef = ref(props.gitRef)
const headRef = ref(props.gitRef)

// ---------------------------------------------------------------------------
// 比较
// ---------------------------------------------------------------------------

const result = ref<CompareResult | null>(null)
const loading = ref(false)
const error = ref<Error | null>(null)
/** 是否已执行过至少一次比较（控制结果区显隐） */
const hasRun = ref(false)

async function runCompare() {
  if (!props.repoPath || baseRef.value === headRef.value || loading.value) {
    return
  }
  loading.value = true
  error.value = null
  try {
    result.value = await fetchCompare(props.repoPath, baseRef.value, headRef.value)
    hasRun.value = true
  }
  catch (err) {
    result.value = null
    error.value = err as Error
  }
  finally {
    loading.value = false
  }
}

/** 短 SHA（7 位，与提交列表一致） */
function shortSha(value: string): string {
  return value.slice(0, 7)
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- 顶部：base/head 选择 + 比较按钮 + 返回 -->
    <div class="flex items-center gap-2 flex-wrap">
      <UButton
        size="xs"
        color="neutral"
        variant="ghost"
        icon="i-lucide-arrow-left"
        :label="t('state.backToList')"
        @click="closeCompare"
      />
      <RepoBranchSelect
        :repo-path="repoPath"
        :model-value="baseRef"
        select-mode="emit"
        @update:model-value="(value: string) => (baseRef = value)"
      />
      <UIcon
        name="i-lucide-arrow-right-left"
        class="size-4 text-dimmed shrink-0"
      />
      <RepoBranchSelect
        :repo-path="repoPath"
        :model-value="headRef"
        select-mode="emit"
        @update:model-value="(value: string) => (headRef = value)"
      />
      <UButton
        size="sm"
        color="primary"
        variant="soft"
        icon="i-lucide-git-compare"
        :label="t('repo.compare.run')"
        :disabled="baseRef === headRef"
        :loading="loading"
        @click="runCompare"
      />
    </div>

    <StateAlert
      v-if="loading"
      state="loading"
      loading-variant="diff"
    />
    <StateAlert
      v-else-if="error"
      state="error"
      :error="error"
      :retry="runCompare"
      @back="closeCompare"
    />
    <StateAlert
      v-else-if="!hasRun"
      state="empty"
      :empty-text="t('repo.compare.hint')"
    />

    <!-- 比较结果 -->
    <template v-else-if="result">
      <!-- 概览：total_commits + 文件数 -->
      <div class="flex items-center gap-4 text-sm">
        <span>
          {{ t('repo.compare.commitsCount', { count: result.totalCommits }) }}
        </span>
        <span class="text-dimmed">
          {{ t('repo.compare.filesCount', { count: result.files.length }) }}
        </span>
      </div>

      <!-- 区间提交列表（点击跳 ?sha= 详情） -->
      <div
        v-if="result.commits.length > 0"
        class="flex flex-col border border-default rounded-lg divide-y divide-default overflow-hidden"
      >
        <button
          v-for="commit in result.commits"
          :key="commit.sha"
          type="button"
          class="flex items-center gap-3 px-4 py-2 text-left hover:bg-elevated/50 cursor-pointer"
          @click="openCommit(commit.sha)"
        >
          <UIcon
            name="i-lucide-git-commit-horizontal"
            class="size-4 text-muted shrink-0"
          />
          <span class="text-sm text-highlighted truncate flex-1">{{ commit.title }}</span>
          <UBadge
            color="neutral"
            variant="subtle"
            size="sm"
            :label="shortSha(commit.sha)"
            class="font-mono shrink-0"
          />
        </button>
      </div>

      <!-- 文件 diff（复用 PullDiffView；patch 空 → "无文本差异"） -->
      <PullDiffView
        v-if="result.files.length > 0"
        :files="result.files"
      />
      <StateAlert
        v-else
        state="empty"
        :empty-text="t('repo.compare.noFileChanges')"
      />
    </template>
  </div>
</template>
