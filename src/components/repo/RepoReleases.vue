<script setup lang="ts">
/**
 * Releases 页签容器（T07）：列表 ⇄ 详情（?release=<id> 下钻）。
 *
 * 结构：
 * - 列表：分页（20/页，复用 route 的 page 键）+ 空态 + 403/404 StateAlert；
 * - 详情：MarkdownView 渲染 body + ReleaseAssetList（只读 + 下载）+
 *   编辑（ReleaseFormModal）+ 删除（ConfirmDialog 输入 tagName 确认，
 *   文案明确「不会删除 git tag」—— swagger 明确删除 Release 不删 tag）；
 * - 详情 404：StateAlert notFound（不自动回列表，设计文档 §2.3）。
 *
 * 数据一致性（§8.5）：Release CUD 后本地 reload()（重拉当前页/详情）。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  deleteRelease,
  fetchRelease,
  fetchReleases,
  type ReleaseItem,
} from '../../composables/useCnbReleases'
import { useRepoRoute } from '../../composables/useRepoRoute'
import { repoSiteUrl, type RepoDetail } from '../../composables/useCnbRepo'
import { formatDateTime, formatRelativeTime } from '../../utils'
import StateAlert from './StateAlert.vue'
import MarkdownView from './MarkdownView.vue'
import ReleaseFormModal from './ReleaseFormModal.vue'
import ReleaseAssetList from './ReleaseAssetList.vue'
import ConfirmDialog from '../common/ConfirmDialog.vue'

const props = defineProps<{
  repoPath: string
  /** 仓库详情（写入口按 canManage 预判显示；归档态禁用写按钮） */
  detail: RepoDetail | null
}>()

const { t } = useI18n()
const toast = useToast()
const { release, page, setPage, openRelease, backToList } = useRepoRoute()

const PAGE_SIZE = 20

/** 是否有写权限（Master/Owner 预判，403 只作兜底 —— §8.2） */
const canManage = computed(() => !!props.detail?.canManage)
/** 归档仓库：写按钮禁用（写入口统一按 detail.archived 禁用） */
const archived = computed(() => !!props.detail?.archived)

/** Web 端 Releases 页（403/404 兜底外跳） */
const siteUrl = computed(() => repoSiteUrl(props.repoPath, '/-/releases'))

// ---------------------------------------------------------------------------
// 列表
// ---------------------------------------------------------------------------

const items = ref<ReleaseItem[]>([])
const loading = ref(false)
const error = ref<Error | null>(null)
/** 服务端未返回 total 时的保守分页判定：满页假设还有下一页 */
const hasNext = computed(() => items.value.length >= PAGE_SIZE)

async function load() {
  if (!props.repoPath) {
    return
  }
  loading.value = true
  error.value = null
  try {
    items.value = await fetchReleases(props.repoPath, { page: page.value, pageSize: PAGE_SIZE })
  }
  catch (err) {
    items.value = []
    error.value = err as Error
  }
  finally {
    loading.value = false
  }
}

// ---------------------------------------------------------------------------
// 详情
// ---------------------------------------------------------------------------

/** 当前下钻 Release 的详情（命名避开 props.detail —— 传入的是仓库详情） */
const releaseDetail = ref<ReleaseItem | null>(null)
const detailLoading = ref(false)
const detailError = ref<Error | null>(null)

async function loadDetail() {
  if (!props.repoPath || !release.value) {
    return
  }
  detailLoading.value = true
  detailError.value = null
  try {
    releaseDetail.value = await fetchRelease(props.repoPath, release.value)
  }
  catch (err) {
    releaseDetail.value = null
    detailError.value = err as Error
  }
  finally {
    detailLoading.value = false
  }
}

// release 下钻键 / 页码 / 仓库变化时重拉对应视图
watch(
  () => `${props.repoPath}|${release.value}`,
  () => {
    if (release.value) {
      void loadDetail()
    }
    else {
      void load()
    }
  },
  { immediate: true },
)
// 仅翻页变化（release 不变）时重拉列表
watch(page, () => {
  if (!release.value) {
    void load()
  }
})

// ---------------------------------------------------------------------------
// 新建 / 编辑
// ---------------------------------------------------------------------------

const formOpen = ref(false)
/** 编辑模式的目标 Release（null = 新建） */
const editingRelease = ref<ReleaseItem | null>(null)

function openCreate() {
  editingRelease.value = null
  formOpen.value = true
}

function openEdit(item: ReleaseItem) {
  editingRelease.value = item
  formOpen.value = true
}

/** 创建成功：回第 1 页重拉列表（新版本通常按时间序出现在最前） */
async function onCreated() {
  if (page.value !== 1) {
    setPage(1)
  }
  else {
    await load()
  }
}

/** 编辑成功：重拉详情与列表（徽标/时间可能变化） */
async function onSaved() {
  await Promise.all([loadDetail(), load()])
}

// ---------------------------------------------------------------------------
// 删除（输入 tagName 确认；文案明确「不会删除 git tag」）
// ---------------------------------------------------------------------------

const deleteOpen = ref(false)
const deleting = ref(false)
/** 待删除的 Release（typeToConfirm 用其 tagName） */
const deleteTarget = ref<ReleaseItem | null>(null)

function confirmDelete(item: ReleaseItem) {
  deleteTarget.value = item
  deleteOpen.value = true
}

async function doDelete() {
  const target = deleteTarget.value
  if (!target?.id || deleting.value) {
    return
  }
  deleting.value = true
  try {
    await deleteRelease(props.repoPath, target.id)
    toast.add({
      title: t('repo.releases.deleteSuccess'),
      description: target.tagName,
      color: 'success',
      duration: 2500,
    })
    deleteOpen.value = false
    // 删除的是当前详情：返回列表视图
    if (release.value === target.id) {
      backToList()
    }
    await load()
  }
  catch (err) {
    toast.add({
      title: t('repo.releases.deleteFailed'),
      description: (err as Error)?.message || '',
      color: 'error',
      duration: 6000,
    })
  }
  finally {
    deleting.value = false
  }
}

/** 徽标统一配置（latest 绿 / draft 中性 / prerelease 橙） */
function badgeOf(item: ReleaseItem): { color: 'success' | 'neutral' | 'warning', label: string } | null {
  if (item.isDraft) {
    return { color: 'neutral', label: t('repo.releases.draft') }
  }
  if (item.isPrerelease) {
    return { color: 'warning', label: t('repo.releases.prerelease') }
  }
  if (item.isLatest) {
    return { color: 'success', label: t('repo.releases.latest') }
  }
  return null
}

/** 详情徽标（badgeOf 的 computed 包装，供模板直接使用） */
const releaseBadge = computed(() => releaseDetail.value ? badgeOf(releaseDetail.value) : null)
</script>

<template>
  <div>
    <!-- ======================= 详情视图（?release=<id>） ======================= -->
    <template v-if="release">
      <StateAlert
        v-if="detailLoading"
        state="loading"
        loading-variant="detail"
      />
      <!-- 详情 404：不自动回列表（用户需明确知道发生了什么，§2.3） -->
      <StateAlert
        v-else-if="detailError"
        state="error"
        :error="detailError"
        :site-url="siteUrl"
        :retry="loadDetail"
        @back="backToList"
      />

      <template v-else-if="releaseDetail">
        <!-- 顶部：返回 + tag + 徽标 + 编辑/删除 -->
        <div class="flex items-center gap-2 mb-3 flex-wrap">
          <UButton
            size="xs"
            color="neutral"
            variant="ghost"
            icon="i-lucide-arrow-left"
            :label="t('state.backToList')"
            @click="backToList"
          />
          <UBadge
            color="neutral"
            variant="subtle"
            size="sm"
            :label="releaseDetail.tagName"
            class="font-mono"
          />
          <UBadge
            v-if="releaseBadge"
            :color="releaseBadge.color"
            variant="subtle"
            size="sm"
            :label="releaseBadge.label"
          />
          <!-- 编辑/删除：canManage 预判 + 归档禁用 -->
          <div v-if="canManage" class="ms-auto flex items-center gap-1.5">
            <UButton
              size="xs"
              color="neutral"
              variant="soft"
              icon="i-lucide-pencil"
              :label="t('repo.releases.edit')"
              :disabled="archived"
              @click="openEdit(releaseDetail)"
            />
            <UButton
              size="xs"
              color="error"
              variant="soft"
              icon="i-lucide-trash-2"
              :label="t('repo.releases.delete')"
              :disabled="archived"
              @click="confirmDelete(releaseDetail)"
            />
          </div>
        </div>

        <!-- 标题 + 作者 + 时间 -->
        <div class="mb-3">
          <h2 class="text-lg font-semibold text-highlighted">
            {{ releaseDetail.name || releaseDetail.tagName }}
          </h2>
          <p class="mt-1 text-xs text-dimmed flex items-center gap-3 flex-wrap">
            <span v-if="releaseDetail.authorName">{{ releaseDetail.authorName }}</span>
            <span v-if="releaseDetail.publishedAt">
              {{ t('repo.releases.publishedAt', { time: formatDateTime(releaseDetail.publishedAt) }) }}
            </span>
            <span v-else-if="releaseDetail.createdAt">
              {{ t('repo.releases.createdAt', { time: formatDateTime(releaseDetail.createdAt) }) }}
            </span>
          </p>
        </div>

        <!-- 描述（Markdown 消毒渲染） -->
        <MarkdownView
          v-if="releaseDetail.body"
          :source="releaseDetail.body"
          class="mb-4"
        />
        <p v-else class="text-sm text-dimmed mb-4">
          {{ t('repo.releases.bodyEmpty') }}
        </p>

        <!-- 附件只读列表 + 下载 -->
        <ReleaseAssetList :release="releaseDetail" :repo-path="repoPath" />
      </template>
    </template>

    <!-- ======================= 列表视图（?tab=releases） ======================= -->
    <template v-else>
      <!-- 头部：标题 + 新建版本 -->
      <div class="flex items-center gap-2 mb-3">
        <h2 class="text-sm font-semibold text-highlighted">
          {{ t('repo.releases.title') }}
        </h2>
        <UButton
          v-if="canManage"
          class="ms-auto"
          size="sm"
          color="primary"
          variant="soft"
          icon="i-lucide-plus"
          :label="t('repo.releases.create')"
          :disabled="archived"
          @click="openCreate"
        />
      </div>

      <StateAlert
        v-if="loading"
        state="loading"
        loading-variant="list"
      />
      <StateAlert
        v-else-if="error"
        state="error"
        :error="error"
        :site-url="siteUrl"
        :retry="load"
      />
      <!-- 空态：暂无版本 -->
      <StateAlert
        v-else-if="items.length === 0"
        state="empty"
        :empty-text="t('repo.releases.empty')"
        :empty-desc="t('repo.releases.emptyDesc')"
      />

      <div v-else class="flex flex-col border border-default rounded-lg divide-y divide-default overflow-hidden">
        <button
          v-for="item in items"
          :key="item.id || item.tagName"
          type="button"
          class="flex items-center gap-3 px-4 py-3 text-left hover:bg-elevated/50 cursor-pointer"
          @click="openRelease(item.id)"
        >
          <UIcon name="i-lucide-tag" class="size-4 text-muted shrink-0" />
          <div class="flex-1 min-w-0">
            <p class="text-sm text-highlighted truncate">
              <span class="font-mono">{{ item.tagName }}</span>
              <span v-if="item.name && item.name !== item.tagName" class="text-muted ms-2">{{ item.name }}</span>
            </p>
            <p class="mt-0.5 flex items-center gap-2 text-xs text-dimmed flex-wrap">
              <span v-if="item.authorName">{{ item.authorName }}</span>
              <span v-if="item.publishedAt">{{ formatRelativeTime(item.publishedAt) }}</span>
              <span v-if="item.assets.length">
                {{ t('repo.releases.assetCount', { count: item.assets.length }) }}
              </span>
            </p>
          </div>
          <!-- 徽标（latest / draft / prerelease） -->
          <UBadge
            v-if="badgeOf(item)"
            :color="badgeOf(item)!.color"
            variant="subtle"
            size="sm"
            :label="badgeOf(item)!.label"
            class="shrink-0"
          />
        </button>
      </div>

      <!-- 分页 -->
      <div
        v-if="!loading && !error && items.length > 0 && (page > 1 || hasNext)"
        class="flex items-center justify-center gap-3 mt-4"
      >
        <UButton
          size="sm"
          color="neutral"
          variant="outline"
          icon="i-lucide-arrow-left"
          :disabled="page <= 1"
          @click="setPage(page - 1)"
        >
          {{ t('common.prevPage') }}
        </UButton>
        <span class="text-xs text-dimmed">{{ t('common.pageInfo', { page }) }}</span>
        <UButton
          size="sm"
          color="neutral"
          variant="outline"
          trailing-icon="i-lucide-arrow-right"
          :disabled="!hasNext"
          @click="setPage(page + 1)"
        >
          {{ t('common.nextPage') }}
        </UButton>
      </div>
    </template>

    <!-- 新建 / 编辑弹窗（表单状态不入 URL，§2.3） -->
    <ReleaseFormModal
      v-model:open="formOpen"
      :repo-path="repoPath"
      :release="editingRelease"
      :disabled="archived"
      @created="onCreated"
      @saved="onSaved"
    />

    <!-- 删除二次确认：输入 tagName；文案明确不删除 git tag -->
    <ConfirmDialog
      v-model:open="deleteOpen"
      :title="t('repo.releases.delete')"
      :desc="t('repo.releases.deleteConfirm', { tag: deleteTarget?.tagName || '' })"
      :confirm-label="t('repo.releases.delete')"
      confirm-color="error"
      :loading="deleting"
      :type-to-confirm="deleteTarget?.tagName || ''"
      :type-to-confirm-label="t('repo.releases.deleteTypeToConfirm', { tag: deleteTarget?.tagName || '' })"
      @confirm="doDelete"
    />
  </div>
</template>
