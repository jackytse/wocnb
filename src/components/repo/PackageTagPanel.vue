<script setup lang="ts">
/**
 * 制品库右栏 —— tag 详情面板（T08）。
 *
 * 职责：
 * - 展示单个 tag 的详情（digest/size/status/推送者等公共字段）；
 * - docker 制品的 arch 处理（§7.2 T08 验收 4）：docker 请求详情**必须带
 *   arch**（缺失服务端 400）。arch 候选从中栏列表项 arches 派生（props 传入）；
 *   刷新恢复（arches 为空）时回源 tag 列表补取；无任何 arch 候选时显示
 *   「该架构信息不可用」而不发详情请求 —— 防 400 白屏；
 * - 溯源区块（hasProvenance 时拉取；404/空 → 「暂无溯源」，不阻断详情）；
 * - 删除 tag（scope registry-package-delete:rw）：canManage 预判显示入口，
 *   ConfirmDialog 输入 tag 名确认（高危删除，§8.3），成功后通知父级刷新。
 *
 * 数据链：URL（ptype/pname/ptag）→ 父组件 props → 本组件只负责拉取与呈现。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  deletePackageTag,
  fetchPackageProvenance,
  fetchPackageTag,
  fetchPackageTags,
  type PackageTagDetail,
} from '../../composables/useCnbPackages'
import type { PackageType } from '../../composables/useRepoRoute'
import { formatBytes, formatDateTime } from '../../utils'
import StateAlert from './StateAlert.vue'
import ConfirmDialog from '../common/ConfirmDialog.vue'

const props = defineProps<{
  repoPath: string
  /** 制品类型（具体类型，禁止 'all' —— all 无法定位单个制品） */
  type: PackageType
  /** 制品名（docker 可能含 '/'，数据层整段编码） */
  name: string
  /** tag 名 */
  tag: string
  /** 中栏列表项派生的 arch 候选（docker 专属；其他类型为空数组） */
  archCandidates: string[]
  /** 是否有管理权限（Master/Owner 预判，403 只作兜底 —— §8.2） */
  canManage: boolean
}>()

const emit = defineEmits<{
  /** 删除成功（父级刷新中栏列表） */
  (e: 'deleted'): void
}>()

const { t } = useI18n()
const toast = useToast()

// ---------------------------------------------------------------------------
// 详情加载
// ---------------------------------------------------------------------------

const detail = ref<PackageTagDetail | null>(null)
const loading = ref(false)
const error = ref<Error | null>(null)

/**
 * 当前选中的 arch（docker 专属；空串表示尚未确定）。
 * arch 是展示态而非定位态 —— 不入 URL（刷新时由列表/详情回源重建）。
 */
const selectedArch = ref('')

/**
 * arch 候选（刷新恢复场景 props.archCandidates 可能为空，回源 tag 列表补取）。
 * 仅 docker 使用；切换 tag 时重置。
 */
const archOptions = ref<string[]>([])

/** docker 制品且无任何 arch 候选 → 不发详情请求，显示「架构信息不可用」 */
const archUnavailable = computed(() => props.type === 'docker' && archOptions.value.length === 0)

/**
 * 补取 arch 候选（刷新恢复场景：URL 有 ptag 但父级没有列表缓存）。
 * 拉一次 tag 列表，取目标 tag 的 arches。
 */
async function resolveArchFromTags(): Promise<string[]> {
  if (props.archCandidates.length > 0) {
    return props.archCandidates
  }
  try {
    const tags = await fetchPackageTags(props.repoPath, props.type, props.name)
    return tags.find(tag => tag.name === props.tag)?.arches ?? []
  }
  catch {
    // 列表补取失败：按无候选处理（详情面板给出「架构信息不可用」而非报错）
    return []
  }
}

async function loadDetail() {
  loading.value = true
  error.value = null
  try {
    detail.value = await fetchPackageTag(
      props.repoPath,
      props.type,
      props.name,
      props.tag,
      // docker 必须带 arch（swagger：required for docker artifacts）
      props.type === 'docker' ? { arch: selectedArch.value } : {},
    )
  }
  catch (err) {
    detail.value = null
    error.value = err as Error
  }
  finally {
    loading.value = false
  }
}

// ptype/pname/ptag/仓库任一变化 → 重置 arch 并重新加载
watch(
  () => `${props.repoPath}|${props.type}|${props.name}|${props.tag}`,
  async () => {
    selectedArch.value = ''
    if (props.type === 'docker') {
      archOptions.value = await resolveArchFromTags()
      if (archOptions.value.length === 0) {
        // 无 arch 候选：清空详情显示「架构信息不可用」，不发请求（防 400 白屏）
        detail.value = null
        error.value = null
        return
      }
      // 赋值触发下方 selectedArch watch 完成首次加载（避免双重请求）
      selectedArch.value = archOptions.value[0]
    }
    else {
      // 非 docker：无需 arch，直接加载
      void loadDetail()
    }
  },
  { immediate: true },
)

// 用户切换 arch → 仅重拉详情
watch(selectedArch, (value) => {
  if (value) {
    void loadDetail()
  }
})

// ---------------------------------------------------------------------------
// 溯源（独立降级：失败不影响详情主体）
// ---------------------------------------------------------------------------

const provenance = ref<Awaited<ReturnType<typeof fetchPackageProvenance>> | null>(null)
const provenanceLoading = ref(false)
/** 溯源区块是否展示：详情声明有溯源才拉取（hasProvenance 为 false 时跳过请求） */
const shouldFetchProvenance = computed(() => !!detail.value?.hasProvenance)
/** 溯源是否为空（404 或字段全空 → 「暂无溯源」） */
const provenanceEmpty = computed(() =>
  !provenance.value || (!provenance.value.digest && !provenance.value.gitCommit && !provenance.value.sn),
)

async function loadProvenance() {
  if (!shouldFetchProvenance.value) {
    provenance.value = null
    return
  }
  provenanceLoading.value = true
  try {
    provenance.value = await fetchPackageProvenance(props.repoPath, props.type, props.name, props.tag)
  }
  catch {
    // 404（无溯源）/网络错误：溯源区块独立降级为「暂无溯源」，不阻断右栏
    provenance.value = null
  }
  finally {
    provenanceLoading.value = false
  }
}

// 详情就绪后再拉溯源（依赖 detail.hasProvenance）
watch(shouldFetchProvenance, () => void loadProvenance(), { immediate: true })

// ---------------------------------------------------------------------------
// 删除 tag（scope registry-package-delete:rw）
// ---------------------------------------------------------------------------

const deleteOpen = ref(false)
const deleting = ref(false)

async function onDelete() {
  deleting.value = true
  try {
    await deletePackageTag(props.repoPath, props.type, props.name, props.tag)
    toast.add({ title: t('repo.packages.deleteSuccess'), color: 'success', duration: 3000 })
    deleteOpen.value = false
    emit('deleted')
  }
  catch (err) {
    // 403（缺 registry-package-delete:rw）兜底：透出服务端信息，弹窗保留
    toast.add({
      title: t('repo.packages.deleteFailed'),
      description: (err as Error)?.message || '',
      color: 'error',
      duration: 6000,
    })
  }
  finally {
    deleting.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-4 min-w-0">
    <!-- 面板标题 + arch 切换（docker 专属） -->
    <div class="flex items-center justify-between gap-2 flex-wrap">
      <h3 class="text-sm font-semibold truncate">
        {{ tag }}
      </h3>
      <USelect
        v-if="type === 'docker' && archOptions.length > 1"
        v-model="selectedArch"
        size="sm"
        class="w-56"
        :items="archOptions"
        :aria-label="t('repo.packages.archLabel')"
      />
    </div>

    <!-- docker 无 arch 候选：提示而非 400 白屏（验收 4） -->
    <StateAlert
      v-if="archUnavailable"
      state="empty"
      :empty-text="t('repo.packages.archUnavailable')"
    />
    <StateAlert
      v-else-if="loading"
      state="loading"
      loading-variant="detail"
    />
    <StateAlert
      v-else-if="error"
      state="error"
      :error="error"
      :retry="() => loadDetail()"
    />

    <!-- 详情主体 -->
    <template v-else-if="detail">
      <UCard :ui="{ body: 'flex flex-col gap-2 text-sm' }">
        <div
          v-if="detail.digest"
          class="flex items-start justify-between gap-3"
        >
          <span class="text-dimmed shrink-0">{{ t('repo.packages.digest') }}</span>
          <span class="font-mono text-xs break-all text-right">{{ detail.digest }}</span>
        </div>
        <div
          v-if="detail.size > 0"
          class="flex items-center justify-between gap-3"
        >
          <span class="text-dimmed">{{ t('repo.packages.size') }}</span>
          <span>{{ formatBytes(detail.size) }}</span>
        </div>
        <div
          v-if="detail.status"
          class="flex items-center justify-between gap-3"
        >
          <span class="text-dimmed">{{ t('repo.packages.status') }}</span>
          <UBadge
            size="sm"
            :color="detail.status === 'ready' ? 'success' : 'neutral'"
            variant="soft"
          >
            {{ detail.status }}
          </UBadge>
        </div>
        <div
          v-if="detail.pullCount > 0"
          class="flex items-center justify-between gap-3"
        >
          <span class="text-dimmed">{{ t('repo.packages.pullCount') }}</span>
          <span>{{ detail.pullCount }}</span>
        </div>
        <div
          v-if="detail.address"
          class="flex items-start justify-between gap-3"
        >
          <span class="text-dimmed shrink-0">{{ t('repo.packages.address') }}</span>
          <span class="font-mono text-xs break-all text-right">{{ detail.address }}</span>
        </div>
        <div
          v-if="detail.lastPushedAt"
          class="flex items-center justify-between gap-3"
        >
          <span class="text-dimmed">{{ t('repo.packages.lastPushed') }}</span>
          <span>{{ detail.lastPusherName }} · {{ formatDateTime(detail.lastPushedAt) }}</span>
        </div>
      </UCard>

      <!-- 溯源区块（独立降级：失败/为空只影响本区块） -->
      <UCard :ui="{ body: 'flex flex-col gap-2 text-sm' }">
        <h4 class="text-sm font-semibold">
          {{ t('repo.packages.provenanceTitle') }}
        </h4>
        <USkeleton
          v-if="provenanceLoading"
          class="h-16 w-full rounded-md"
        />
        <p
          v-else-if="provenanceEmpty"
          class="text-xs text-dimmed"
        >
          {{ t('repo.packages.provenanceEmpty') }}
        </p>
        <template v-else-if="provenance">
          <div
            v-if="provenance.sn"
            class="flex items-center justify-between gap-3"
          >
            <span class="text-dimmed">{{ t('repo.packages.provenanceSn') }}</span>
            <span class="font-mono text-xs">#{{ provenance.sn }}</span>
          </div>
          <div
            v-if="provenance.gitCommit"
            class="flex items-start justify-between gap-3"
          >
            <span class="text-dimmed shrink-0">{{ t('repo.packages.gitCommit') }}</span>
            <span class="font-mono text-xs break-all text-right">{{ provenance.gitCommit }}</span>
          </div>
          <div
            v-if="provenance.gitAddress"
            class="flex items-start justify-between gap-3"
          >
            <span class="text-dimmed shrink-0">{{ t('repo.packages.gitAddress') }}</span>
            <span class="font-mono text-xs break-all text-right">{{ provenance.gitAddress }}</span>
          </div>
          <div
            v-if="provenance.registryAddress"
            class="flex items-start justify-between gap-3"
          >
            <span class="text-dimmed shrink-0">{{ t('repo.packages.registryAddress') }}</span>
            <span class="font-mono text-xs break-all text-right">{{ provenance.registryAddress }}</span>
          </div>
        </template>
      </UCard>

      <!-- 删除 tag（canManage 预判显示入口；403 兜底） -->
      <UButton
        v-if="canManage"
        color="error"
        variant="soft"
        icon="i-lucide-trash-2"
        :label="t('repo.packages.deleteTag')"
        block
        @click="deleteOpen = true"
      />
    </template>

    <!-- 删除确认（高危：输入 tag 名确认，§8.3） -->
    <ConfirmDialog
      v-model:open="deleteOpen"
      :title="t('repo.packages.deleteTag')"
      :desc="t('repo.packages.deleteTagConfirm', { name, tag })"
      :confirm-label="t('repo.packages.deleteTag')"
      confirm-color="error"
      :loading="deleting"
      :type-to-confirm="tag"
      :type-to-confirm-label="t('repo.packages.deleteTypeToConfirm', { target: tag })"
      @confirm="onDelete"
    />
  </div>
</template>
