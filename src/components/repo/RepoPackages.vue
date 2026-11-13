<script setup lang="ts">
/**
 * 制品库页签容器（T08）：左栏（类型筛选 + 制品列表）/ 中栏（tag 列表）/
 * 右栏（tag 详情 PackageTagPanel）。
 *
 * 布局（验收 6）：
 * - ≥1100px：三栏并排（grid-cols-3）；
 * - <1100px：主从两级 —— 左栏列表 +（tag 详情选中时）右栏替换中栏；
 * - 800px：两级布局下无横向滚动（min-w-0 + truncate 防溢出）。
 *   断点经 useMediaQuery 判定（1100px 非 Tailwind 标准断点，避免任意值
 *   class 与 JS 判定两套口径）。
 *
 * URL 契约（useRepoRoute 单点）：ptype（类型筛选，用户偏好，切换页签保留）/
 * pname（选中制品）/ ptag（选中 tag，pname 缺失时路由层自动丢弃）。
 * 刷新页面凭三键完整恢复三栏。
 *
 * 降级：type=all 400 → 数据层 fanout（R13）；403/404/网络 → StateAlert。
 * 删除制品入口：canManage（Master/Owner 单点判定 §8.2）预判显示，
 * ConfirmDialog 输入制品名确认（高危，§8.3）。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMediaQuery } from '@vueuse/core'
import {
  deletePackage,
  fetchPackages,
  fetchPackageTags,
  type PackageItem,
  type PackageTagItem,
} from '../../composables/useCnbPackages'
import { PACKAGE_TYPES, useRepoRoute, type PackageType } from '../../composables/useRepoRoute'
import type { RepoDetail } from '../../composables/useCnbRepo'
import { formatBytes, formatRelativeTime } from '../../utils'
import StateAlert from './StateAlert.vue'
import PackageTagPanel from './PackageTagPanel.vue'
import ConfirmDialog from '../common/ConfirmDialog.vue'

const props = defineProps<{
  repoPath: string
  /** 仓库详情（删除入口按 canManage 预判显示） */
  detail: RepoDetail | null
}>()

const { t } = useI18n()
const toast = useToast()
const { ptype, pname, ptag, openPackage, openPackageTag, closePackageTag, closePackage, setPtype } = useRepoRoute()

/** 三栏断点（≥1100px 三栏并排；否则主从两级） */
const isWide = useMediaQuery('(min-width: 1100px)')

/** 是否有管理权限（Master/Owner 单点判定 §8.2；403 只作兜底） */
const canManage = computed(() => !!props.detail?.canManage)

// ---------------------------------------------------------------------------
// 左栏：类型筛选 + 制品列表
// ---------------------------------------------------------------------------

const packages = ref<PackageItem[]>([])
const packagesLoading = ref(false)
const packagesError = ref<Error | null>(null)

/** 类型下拉选项（枚举原始值直接展示 —— docker/npm 等为专有名词不翻译） */
const typeItems = computed(() => PACKAGE_TYPES.map(value => ({
  label: value === 'all' ? t('repo.packages.typeAll') : value,
  value,
})))

async function loadPackages() {
  if (!props.repoPath) {
    return
  }
  packagesLoading.value = true
  packagesError.value = null
  try {
    // type=all 400 → 数据层自动 fanout 降级（R13，调用方无感）
    packages.value = await fetchPackages(props.repoPath, { type: ptype.value })
  }
  catch (err) {
    packages.value = []
    packagesError.value = err as Error
  }
  finally {
    packagesLoading.value = false
  }
}

// 仓库路径或类型筛选变化 → 重拉左栏
watch(() => `${props.repoPath}|${ptype.value}`, () => void loadPackages(), { immediate: true })

function onSelectType(value: string) {
  // 切类型清空下钻（旧制品与旧 tag 不属于新类型），并重拉列表
  setPtype(value as PackageType)
}

// ---------------------------------------------------------------------------
// 中栏：tag 列表
// ---------------------------------------------------------------------------

/**
 * URL 链是否完整（可拉 tag 列表）：ptype 为具体类型 + pname 有值。
 * ptype=all 时无法定位单个制品的类型 —— 视为残缺链，只显示左栏。
 */
const chainValid = computed(() => ptype.value !== 'all' && !!pname.value)

const tags = ref<PackageTagItem[]>([])
const tagsLoading = ref(false)
const tagsError = ref<Error | null>(null)

async function loadTags() {
  if (!props.repoPath || !chainValid.value) {
    tags.value = []
    return
  }
  tagsLoading.value = true
  tagsError.value = null
  try {
    tags.value = await fetchPackageTags(props.repoPath, ptype.value, pname.value)
  }
  catch (err) {
    tags.value = []
    tagsError.value = err as Error
  }
  finally {
    tagsLoading.value = false
  }
}

// 制品选中变化 → 重拉中栏
watch(() => `${props.repoPath}|${ptype.value}|${pname.value}`, () => void loadTags(), { immediate: true })

/** 当前选中制品的 arch 候选（docker 专属；供右栏详情请求的必填参数） */
const selectedTagArches = computed(() => {
  if (!ptag.value) {
    return []
  }
  return tags.value.find(tag => tag.name === ptag.value)?.arches ?? []
})

// ---------------------------------------------------------------------------
// 删除制品（scope registry-package-delete:rw，高危：输入制品名确认）
// ---------------------------------------------------------------------------

const deleteOpen = ref(false)
const deleting = ref(false)
/** 待删除制品名（仅左栏列表里已选中的制品可删） */
const deleteTarget = computed(() => pname.value)

async function onDeletePackage() {
  if (!deleteTarget.value || ptype.value === 'all') {
    return
  }
  deleting.value = true
  try {
    await deletePackage(props.repoPath, ptype.value, deleteTarget.value)
    toast.add({ title: t('repo.packages.deleteSuccess'), color: 'success', duration: 3000 })
    deleteOpen.value = false
    // 制品已删除：清下钻回到列表并重拉（数据一致性 §8.5）
    closePackage()
    await loadPackages()
  }
  catch (err) {
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
  <div class="flex flex-col gap-4">
    <!-- 类型筛选行（全宽，独立于三栏） -->
    <div class="flex items-center gap-2">
      <USelect
        :model-value="ptype"
        class="w-44"
        :items="typeItems"
        value-key="value"
        :aria-label="t('repo.packages.typeLabel')"
        @update:model-value="onSelectType"
      />
      <span class="text-xs text-dimmed">{{ t('repo.packages.count', { count: packages.length }) }}</span>
    </div>

    <div class="grid gap-4 grid-cols-1 min-[1100px]:grid-cols-3 items-start">
      <!-- 左栏：制品列表（窄屏下钻到制品后让位给中/右栏，主从两级） -->
      <div
        v-if="isWide || !chainValid"
        class="min-w-0 flex flex-col gap-2"
      >
        <StateAlert
          v-if="packagesLoading"
          state="loading"
        />
        <StateAlert
          v-else-if="packagesError"
          state="error"
          :error="packagesError"
          :retry="loadPackages"
        />
        <StateAlert
          v-else-if="packages.length === 0"
          state="empty"
          :empty-text="t('repo.packages.empty')"
          :empty-desc="t('repo.packages.emptyDesc')"
        />
        <template v-else>
          <UCard
            v-for="item in packages"
            :key="`${item.type}|${item.name}`"
            :ui="{ body: 'p-3' }"
            class="cursor-pointer hover:ring-primary/40 transition"
            :class="{ 'ring-primary': item.name === pname }"
            @click="openPackage(item.name, (item.type || 'generic') as PackageType)"
          >
            <div class="flex flex-col gap-1 min-w-0">
              <div class="flex items-center gap-2 min-w-0">
                <UBadge
                  size="sm"
                  variant="subtle"
                  color="neutral"
                  class="shrink-0"
                >
                  {{ item.type || '?' }}
                </UBadge>
                <span class="text-sm font-medium truncate">{{ item.name }}</span>
              </div>
              <div
                v-if="item.description"
                class="text-xs text-dimmed truncate"
              >
                {{ item.description }}
              </div>
              <div class="flex items-center gap-3 text-xs text-dimmed">
                <span>{{ t('repo.packages.versionCount', { count: item.versionCount }) }}</span>
                <span
                  v-if="item.pullCount > 0"
                  class="inline-flex items-center gap-1"
                >
                  <UIcon
                    name="i-lucide-download"
                    class="size-3"
                  />
                  {{ item.pullCount }}
                </span>
                <span
                  v-if="item.lastPushedAt"
                  class="ml-auto truncate"
                >
                  {{ formatRelativeTime(item.lastPushedAt) }}
                </span>
              </div>
            </div>
          </UCard>
        </template>
      </div>

      <!-- 中栏：tag 列表（窄屏：有链路且未选 tag 时显示；宽屏恒显示） -->
      <div
        v-if="isWide || (chainValid && !ptag)"
        class="min-w-0 flex flex-col gap-2"
      >
        <StateAlert
          v-if="!chainValid"
          state="empty"
          :empty-text="t('repo.packages.selectHint')"
        />
        <template v-else>
          <div class="flex items-center justify-between gap-2">
            <h3 class="text-sm font-semibold truncate">
              {{ pname }}
            </h3>
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              icon="i-lucide-arrow-left"
              :label="t('repo.packages.backToPackages')"
              @click="closePackage"
            />
          </div>
          <StateAlert
            v-if="tagsLoading"
            state="loading"
          />
          <StateAlert
            v-else-if="tagsError"
            state="error"
            :error="tagsError"
            :retry="loadTags"
          />
          <StateAlert
            v-else-if="tags.length === 0"
            state="empty"
            :empty-text="t('repo.packages.tagsEmpty')"
          />
          <template v-else>
            <UCard
              v-for="tag in tags"
              :key="tag.name"
              :ui="{ body: 'p-3' }"
              class="cursor-pointer hover:ring-primary/40 transition"
              :class="{ 'ring-primary': tag.name === ptag }"
              @click="openPackageTag(pname, ptype, tag.name)"
            >
              <div class="flex flex-col gap-1 min-w-0">
                <span class="text-sm font-medium truncate font-mono">{{ tag.name }}</span>
                <div class="flex items-center gap-3 text-xs text-dimmed">
                  <span
                    v-if="tag.size > 0"
                    class="inline-flex items-center gap-1"
                  >
                    <UIcon
                      name="i-lucide-hard-drive"
                      class="size-3"
                    />
                    {{ formatBytes(tag.size) }}
                  </span>
                  <span
                    v-if="tag.pullCount > 0"
                    class="inline-flex items-center gap-1"
                  >
                    <UIcon
                      name="i-lucide-download"
                      class="size-3"
                    />
                    {{ tag.pullCount }}
                  </span>
                  <span
                    v-if="tag.lastPushedAt"
                    class="ml-auto truncate"
                  >
                    {{ formatRelativeTime(tag.lastPushedAt) }}
                  </span>
                </div>
              </div>
            </UCard>
          </template>

          <!-- 删除制品（canManage 预判显示入口；403 兜底） -->
          <UButton
            v-if="canManage"
            color="error"
            variant="soft"
            icon="i-lucide-trash-2"
            :label="t('repo.packages.deletePackage')"
            block
            @click="deleteOpen = true"
          />
        </template>
      </div>

      <!-- 右栏：tag 详情（ptag 有值时渲染） -->
      <div
        v-if="ptag"
        class="min-w-0 flex flex-col gap-2"
      >
        <div class="flex items-center justify-between gap-2">
          <UButton
            size="xs"
            color="neutral"
            variant="ghost"
            icon="i-lucide-arrow-left"
            :label="t('repo.packages.backToTags')"
            @click="closePackageTag"
          />
        </div>
        <PackageTagPanel
          :repo-path="repoPath"
          :type="ptype"
          :name="pname"
          :tag="ptag"
          :arch-candidates="selectedTagArches"
          :can-manage="canManage"
          @deleted="loadTags"
        />
      </div>
    </div>

    <!-- 删除制品确认（高危：输入制品名确认，§8.3） -->
    <ConfirmDialog
      v-model:open="deleteOpen"
      :title="t('repo.packages.deletePackage')"
      :desc="t('repo.packages.deletePackageConfirm', { name: deleteTarget })"
      :confirm-label="t('repo.packages.deletePackage')"
      confirm-color="error"
      :loading="deleting"
      :type-to-confirm="deleteTarget"
      :type-to-confirm-label="t('repo.packages.deleteTypeToConfirm', { target: deleteTarget })"
      @confirm="onDeletePackage"
    />
  </div>
</template>
