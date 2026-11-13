<script setup lang="ts">
/**
 * 代码浏览视图（目录列表 + 面包屑 + 文件查看器 + 根目录 README）。
 *
 * 定位规则（PRD P0-A3/A4）：当前 ?path= 请求 contents，返回 type=tree
 * 渲染目录列表、type=blob 渲染文件查看器（一次请求判定，与 CNB 网页
 * 行为一致）。目录下钻与面包屑回跳均为 push（返回键可用）。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  fetchRepoContents,
  repoSiteUrl,
  type ContentEntry,
} from '../../composables/useCnbRepo'
import { useRepoRoute } from '../../composables/useRepoRoute'
import { formatBytes } from '../../utils'
import StateAlert from './StateAlert.vue'
import RepoFileViewer from './RepoFileViewer.vue'
import RepoCodeDownloadMenu from './RepoCodeDownloadMenu.vue'
import MarkdownView from './MarkdownView.vue'

const props = defineProps<{
  repoPath: string
  /** 当前生效 ref（?ref= 或默认分支名） */
  gitRef: string
  /** 仓库可见性（大写三值；Secret 时下载入口置灰 —— T12） */
  visibility?: string
}>()

const { t } = useI18n()
const { filePath, openPath } = useRepoRoute()

/** 当前路径的 contents 响应（tree 或 blob） */
const entry = ref<ContentEntry | null>(null)
const loading = ref(false)
const error = ref<Error | null>(null)

/** 请求键（repoPath+ref+path 变化即重新加载） */
const requestKey = computed(() => `${props.repoPath}|${props.gitRef}|${filePath.value}`)

async function load() {
  if (!props.repoPath) {
    return
  }
  loading.value = true
  error.value = null
  try {
    entry.value = await fetchRepoContents(props.repoPath, {
      ref: props.gitRef || undefined,
      filePath: filePath.value || undefined,
    })
  }
  catch (err) {
    entry.value = null
    error.value = err as Error
  }
  finally {
    loading.value = false
  }
}

watch(requestKey, () => {
  void load()
}, { immediate: true })

/** 是否为目录视图（tree 且子项已归一） */
const isTree = computed(() => entry.value?.type === 'tree')

/** 目录条目列表（空数组已在数据层兜底） */
const entries = computed(() => entry.value?.entries ?? [])

/** 面包屑段：根为仓库名，逐级拼接完整路径 */
const crumbs = computed(() => {
  const segs = filePath.value.split('/').filter(Boolean)
  const list: { name: string, path: string }[] = []
  let acc = ''
  for (const seg of segs) {
    acc = acc ? `${acc}/${seg}` : seg
    list.push({ name: seg, path: acc })
  }
  return list
})

// ---------------------------------------------------------------------------
// README（仅根目录渲染）
// ---------------------------------------------------------------------------

/** README 的 Markdown 原文（根目录时才加载） */
const readmeSource = ref('')
const readmeLoading = ref(false)

/** 根目录下是否存在 README.md（大小写不敏感） */
const readmeEntry = computed(() =>
  filePath.value === '' && isTree.value
    ? entries.value.find(e => /^readme\.md$/i.test(e.name))
    : null,
)

// 根目录且存在 README 时拉取内容渲染（额外一次请求，仅根目录）
watch(readmeEntry, async (target) => {
  readmeSource.value = ''
  if (!target) {
    return
  }
  readmeLoading.value = true
  try {
    const fileEntry = await fetchRepoContents(props.repoPath, {
      ref: props.gitRef || undefined,
      filePath: target.path,
    })
    // README 也可能触发 too-large 降级：仅渲染可解码的普通文件
    readmeSource.value = fileEntry.viewMode === 'ok' && fileEntry.contentBase64
      ? decodeBase64(fileEntry.contentBase64)
      : ''
  }
  catch {
    // README 加载失败不阻塞目录浏览（静默降级为不显示）
  }
  finally {
    readmeLoading.value = false
  }
})

/** base64 → UTF-8 文本（与 RepoFileViewer 相同的实现） */
function decodeBase64(b64: string): string {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i)
  }
  return new TextDecoder('utf-8').decode(bytes)
}

/** 条目图标：目录/文件区分（子模块/链接也按文件处理） */
function entryIcon(type: ContentEntry['type']): string {
  if (type === 'tree') {
    return 'i-lucide-folder'
  }
  if (type === 'submodule') {
    return 'i-lucide-box'
  }
  return 'i-lucide-file'
}

/** 在浏览器打开当前路径（降级/异常兜底出口） */
const siteUrl = computed(() =>
  repoSiteUrl(props.repoPath, filePath.value
    ? `/-/blob/${props.gitRef}/${filePath.value}`
    : ''),
)
</script>

<template>
  <div>
    <!-- 加载中 / 错误 / 空态 -->
    <StateAlert
      v-if="loading"
      state="loading"
      :loading-variant="isTree === false ? 'detail' : 'list'"
    />
    <StateAlert
      v-else-if="error"
      state="error"
      :error="error"
      :site-url="siteUrl"
      :retry="load"
      @back="openPath('')"
    />

    <!-- 文件视图：blob 直接交给查看器 -->
    <template v-else-if="entry && !isTree">
      <RepoFileViewer :repo-path="repoPath" :git-ref="gitRef" :entry="entry" />
    </template>

    <!-- 目录视图 -->
    <template v-else-if="entry">
      <!-- 面包屑：仓库根 → 逐级目录（可点回任意层级，push 语义） -->
      <div class="flex items-center gap-1 text-sm flex-wrap mb-3">
        <button
          type="button"
          class="text-primary hover:underline cursor-pointer font-medium"
          @click="openPath('')"
        >
          {{ repoPath.split('/').pop() }}
        </button>
        <template v-for="crumb in crumbs" :key="crumb.path">
          <UIcon name="i-lucide-chevron-right" class="size-3.5 text-dimmed" />
          <button
            type="button"
            class="hover:underline cursor-pointer"
            :class="crumb.path === filePath ? 'text-highlighted font-medium' : 'text-primary'"
            @click="openPath(crumb.path)"
          >
            {{ crumb.name }}
          </button>
        </template>
        <!-- 源码包下载入口（T12；仅根目录工具行显示，Secret 置灰） -->
        <RepoCodeDownloadMenu
          class="ms-auto"
          :repo-path="repoPath"
          :git-ref="gitRef"
          :visibility="visibility"
        />
      </div>

      <!-- 空目录态（entries 为空/非数组已在数据层降级） -->
      <StateAlert
        v-if="entries.length === 0"
        state="empty"
        :empty-text="t('repo.code.emptyDir')"
        :empty-desc="t('repo.code.emptyDirDesc')"
      />

      <!-- 条目列表：目录优先 + 名称升序（数据层已排序） -->
      <div v-else class="flex flex-col border border-default rounded-lg divide-y divide-default overflow-hidden">
        <button
          v-for="item in entries"
          :key="item.path"
          type="button"
          class="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-elevated/50 text-left cursor-pointer"
          @click="openPath(item.path)"
        >
          <UIcon
            :name="entryIcon(item.type)"
            class="size-4 shrink-0"
            :class="item.type === 'tree' ? 'text-blue-500' : 'text-muted'"
          />
          <span class="text-highlighted truncate">{{ item.name }}</span>
          <span v-if="item.type !== 'tree' && item.size" class="ms-auto text-xs text-dimmed shrink-0">
            {{ formatBytes(item.size) }}
          </span>
          <UIcon
            v-if="item.type === 'submodule'"
            name="i-lucide-external-link"
            class="size-3.5 text-dimmed shrink-0"
          />
        </button>
      </div>

      <!-- README（仅根目录存在时渲染在列表下方） -->
      <div v-if="readmeEntry" class="mt-6 border border-default rounded-lg p-5">
        <div class="flex items-center gap-2 mb-3">
          <UIcon name="i-lucide-book-open" class="size-4 text-muted" />
          <h2 class="text-sm font-semibold text-highlighted">
            {{ readmeEntry.name }}
          </h2>
        </div>
        <div v-if="readmeLoading" class="flex flex-col gap-2">
          <USkeleton class="h-4 w-full rounded-md" />
          <USkeleton class="h-4 w-5/6 rounded-md" />
          <USkeleton class="h-4 w-2/3 rounded-md" />
        </div>
        <!-- 用户内容一律走 MarkdownView（DOMPurify 消毒，红线） -->
        <MarkdownView
          v-else-if="readmeSource"
          :source="readmeSource"
          :ctx="{ repoPath, ref: gitRef, dir: '' }"
        />
      </div>
    </template>
  </div>
</template>
