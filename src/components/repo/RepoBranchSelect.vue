<script setup lang="ts">
/**
 * 分支 / 标签选择器（代码、提交页签共用）。
 *
 * 交互：按钮显示当前 ref；点开 UPopover 懒加载分支与标签两个列表
 * （首次打开才发请求，之后驻留），支持本地过滤；选中写回 ?ref= 并
 * 清空 path/sha（useRepoRoute.switchRef，内容源已变旧定位失效）。
 *
 * ref 可能含 '/'（feature/x）：query 值由 vue-router 自动编码，安全。
 */
import { computed, ref as vueRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  fetchRepoBranches,
  fetchRepoTags,
  type BranchItem,
  type TagItem,
} from '../../composables/useCnbRepo'
import { useRepoRoute } from '../../composables/useRepoRoute'

const props = defineProps<{
  /** 仓库完整路径 */
  repoPath: string
  /** 当前生效 ref（route 的 ?ref= 或默认分支名） */
  modelValue: string
  /**
   * 选中行为（T11 扩展，向后兼容）：
   * - 'route'（默认）：写回 ?ref=（useRepoRoute.switchRef），代码/提交页签语义；
   * - 'emit'：仅 emit('update:modelValue')，不做路由写入 —— 提交比较的
   *   base/head 是本地选择态，写 ?ref= 会误清 path/sha 下钻键。
   */
  selectMode?: 'route' | 'emit'
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
}>()

const { t } = useI18n()
const { switchRef } = useRepoRoute()

const open = vueRef(false)
/** 本地过滤词（客户端过滤，分支/标签通常几十个，无需服务端搜索） */
const filter = vueRef('')

/** 分支/标签列表与加载状态 */
const branches = vueRef<BranchItem[]>([])
const tags = vueRef<TagItem[]>([])
const loading = vueRef(false)
const loadError = vueRef(false)
/** 是否已完成首次加载（懒加载只发生一次） */
const loadedOnce = vueRef(false)

/** 拉取分支与标签（并行，单失败降级为对应列表为空） */
async function loadRefs() {
  if (loadedOnce.value || !props.repoPath) {
    return
  }
  loading.value = true
  loadError.value = false
  try {
    const [b, tg] = await Promise.allSettled([
      fetchRepoBranches(props.repoPath),
      fetchRepoTags(props.repoPath),
    ])
    branches.value = b.status === 'fulfilled' ? b.value : []
    tags.value = tg.status === 'fulfilled' ? tg.value : []
    loadError.value = b.status === 'rejected' && tg.status === 'rejected'
    loadedOnce.value = true
  }
  finally {
    loading.value = false
  }
}

// 抽屉打开时懒加载（避免挂载即请求）
watch(open, (value) => {
  if (value) {
    void loadRefs()
  }
})

/** 过滤后的分支/标签列表 */
const filteredBranches = computed(() =>
  branches.value.filter(b => b.name.toLowerCase().includes(filter.value.toLowerCase())),
)
const filteredTags = computed(() =>
  tags.value.filter(tg => tg.name.toLowerCase().includes(filter.value.toLowerCase())),
)

/** 选中：route 模式写回 ?ref=（replace 且清空 path/sha）；emit 模式仅向上传递 */
function select(name: string) {
  open.value = false
  if (props.selectMode === 'emit') {
    emit('update:modelValue', name)
  }
  else {
    switchRef(name)
  }
}
</script>

<template>
  <UPopover v-model:open="open" :content="{ align: 'start' }">
    <UButton
      size="sm"
      color="neutral"
      variant="outline"
      icon="i-lucide-git-branch"
      :label="modelValue || t('repo.branch.select')"
      trailing-icon="i-lucide-chevrons-up-down"
      class="max-w-64"
    />

    <template #content>
      <div class="w-72 p-2 flex flex-col gap-2">
        <UInput
          v-model="filter"
          size="sm"
          variant="soft"
          icon="i-lucide-search"
          :placeholder="t('repo.branch.searchPlaceholder')"
        />

        <!-- 加载中骨架 -->
        <div v-if="loading" class="flex flex-col gap-1.5 py-1">
          <USkeleton v-for="i in 4" :key="i" class="h-7 w-full rounded-md" />
        </div>

        <!-- 两个列表都失败：错误提示 -->
        <UAlert
          v-else-if="loadError"
          icon="i-lucide-cloud-alert"
          color="error"
          variant="soft"
          :title="t('state.error')"
          :description="t('state.errorDesc')"
        />

        <template v-else>
          <!-- 分支组 -->
          <p class="text-xs font-medium text-dimmed px-1 pt-1">
            {{ t('repo.branch.branches') }}
          </p>
          <p v-if="filteredBranches.length === 0" class="text-xs text-dimmed px-1 py-1">
            {{ t('repo.branch.empty') }}
          </p>
          <button
            v-for="branch in filteredBranches"
            :key="branch.name"
            type="button"
            class="flex items-center gap-2 w-full text-left px-2 py-1.5 rounded-md hover:bg-elevated/60 text-sm cursor-pointer"
            @click="select(branch.name)"
          >
            <UIcon name="i-lucide-git-branch" class="size-3.5 text-muted shrink-0" />
            <span class="truncate" :class="branch.name === modelValue ? 'text-primary font-medium' : ''">
              {{ branch.name }}
            </span>
            <UIcon
              v-if="branch.protected"
              name="i-lucide-shield"
              class="size-3.5 text-dimmed ms-auto shrink-0"
            />
          </button>

          <!-- 标签组 -->
          <template v-if="filteredTags.length > 0">
            <p class="text-xs font-medium text-dimmed px-1 pt-2">
              {{ t('repo.branch.tags') }}
            </p>
            <button
              v-for="tag in filteredTags"
              :key="`tag-${tag.name}`"
              type="button"
              class="flex items-center gap-2 w-full text-left px-2 py-1.5 rounded-md hover:bg-elevated/60 text-sm cursor-pointer"
              @click="select(tag.name)"
            >
              <UIcon name="i-lucide-tag" class="size-3.5 text-muted shrink-0" />
              <span class="truncate" :class="tag.name === modelValue ? 'text-primary font-medium' : ''">
                {{ tag.name }}
              </span>
            </button>
          </template>
        </template>
      </div>
    </template>
  </UPopover>
</template>
