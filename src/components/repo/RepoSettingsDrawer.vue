<script setup lang="ts">
/**
 * 仓库设置抽屉（设计文档 §4.1 / T03）。
 *
 * 能力：
 * - 编辑 描述 / site / license / topics（PATCH /{repo}，dto.RepoPatch 四字段）；
 * - 可见性**只读**展示 + 「在浏览器打开设置页」外链兜底 —— PATCH 无
 *   visibility 字段（设计文档 §1.1 事实核对），绝不发送该字段；
 * - 归档 / 解除归档入口（ConfirmDialog 二次确认，归档为破坏性操作）。
 *
 * 数据一致性（§8.5）：保存/归档成功后 emit('updated')，由父页
 * （[...repoPath].vue）loadRepo() 重拉详情，单向下发刷新页头。
 */
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { openUrl } from '@tauri-apps/plugin-opener'
import { archiveRepo, patchRepo, unarchiveRepo } from '../../composables/useCnbRepoManage'
import { visibilityBadge, repoSiteUrl, type RepoDetail } from '../../composables/useCnbRepo'
import ConfirmDialog from '../common/ConfirmDialog.vue'

const props = defineProps<{
  /** 抽屉开关（v-model:open） */
  open: boolean
  /** 仓库详情（加载中可为 null，抽屉显示骨架） */
  detail: RepoDetail | null
}>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  /** 保存 / 归档状态变更成功（父页重拉详情） */
  (e: 'updated'): void
}>()

const { t } = useI18n()
const toast = useToast()

const openModel = computed({
  get: () => props.open,
  set: (value: boolean) => emit('update:open', value),
})

// ---------------------------------------------------------------------------
// 编辑表单
// ---------------------------------------------------------------------------

const form = reactive({
  description: '',
  site: '',
  license: '',
  /** topics 在输入框中以逗号分隔（提交时拆分为数组） */
  topicsText: '',
})
const saving = ref(false)

/** 弹窗打开时以当前详情回填表单（每次打开都重置，避免残留上次编辑） */
watch(() => props.open, (value) => {
  if (value && props.detail) {
    form.description = props.detail.description
    form.site = props.detail.site
    form.license = props.detail.license
    form.topicsText = props.detail.topics.join(', ')
  }
})

/** 提交 PATCH：仅传四个可修改字段（绝不传 visibility —— API 不支持） */
async function onSave() {
  if (!props.detail || saving.value) {
    return
  }
  saving.value = true
  try {
    await patchRepo(props.detail.path, {
      description: form.description.trim(),
      site: form.site.trim(),
      license: form.license.trim(),
      // topics：逗号分隔文本 → 数组（过滤空段）
      topics: form.topicsText.split(',').map(s => s.trim()).filter(Boolean),
    })
    toast.add({ title: t('repo.settings.saved'), color: 'success', duration: 2500 })
    emit('update:open', false)
    // 父页重拉详情，页头描述等信息即时更新（验收标准 T03-1）
    emit('updated')
  }
  catch (err) {
    // 失败留在抽屉内，透出服务端 message（403 时为缺 repo-manage:rw 的 scope 提示）
    toast.add({
      title: t('repo.settings.saveFailed'),
      description: (err as Error)?.message || '',
      color: 'error',
      duration: 6000,
    })
  }
  finally {
    saving.value = false
  }
}

// ---------------------------------------------------------------------------
// 归档 / 解除归档
// ---------------------------------------------------------------------------

const archiveDialogOpen = ref(false)
const unarchiveDialogOpen = ref(false)
const archiving = ref(false)

/** 归档（破坏性）：ConfirmDialog 确认后调用，成功后 emit updated */
async function doArchive() {
  if (!props.detail || archiving.value) {
    return
  }
  archiving.value = true
  try {
    await archiveRepo(props.detail.path)
    toast.add({ title: t('repo.settings.archiveSuccess'), color: 'success', duration: 2500 })
    archiveDialogOpen.value = false
    emit('update:open', false)
    emit('updated')
  }
  catch (err) {
    toast.add({
      title: t('repo.settings.archiveFailed'),
      description: (err as Error)?.message || '',
      color: 'error',
      duration: 6000,
    })
  }
  finally {
    archiving.value = false
  }
}

/** 解除归档（非破坏性恢复） */
async function doUnarchive() {
  if (!props.detail || archiving.value) {
    return
  }
  archiving.value = true
  try {
    await unarchiveRepo(props.detail.path)
    toast.add({ title: t('repo.settings.unarchiveSuccess'), color: 'success', duration: 2500 })
    unarchiveDialogOpen.value = false
    emit('update:open', false)
    emit('updated')
  }
  catch (err) {
    toast.add({
      title: t('repo.settings.unarchiveFailed'),
      description: (err as Error)?.message || '',
      color: 'error',
      duration: 6000,
    })
  }
  finally {
    archiving.value = false
  }
}

// ---------------------------------------------------------------------------
// 外链与展示辅助
// ---------------------------------------------------------------------------

/** 可见性徽标（只读展示） */
const badge = computed(() => props.detail ? visibilityBadge(props.detail.visibility) : null)

/** Web 端设置页地址：PATCH 不支持可见性，可见性等设置需在 Web 端操作 */
const webSettingsUrl = computed(() => repoSiteUrl(props.detail?.path || ''))

/** 在系统浏览器打开（非 Tauri 兜底 window.open） */
function openExternal(url: string) {
  if (!url) {
    return
  }
  if ('__TAURI_INTERNALS__' in window) {
    void openUrl(url)
  }
  else {
    window.open(url, '_blank')
  }
}
</script>

<template>
  <!-- 用 UDrawer（与 BuildLogDrawer 同范式，项目已验证）而非 USlideover -->
  <UDrawer
    v-model:open="openModel"
    direction="right"
    :ui="{ content: 'max-w-md' }"
  >
    <template #header>
      <div class="flex items-center gap-2 min-w-0">
        <UIcon name="i-lucide-settings" class="size-4 text-muted shrink-0" />
        <h3 class="text-sm font-semibold text-highlighted truncate">
          {{ t('repo.settings.title') }}
        </h3>
      </div>
    </template>

    <template #body>
      <div v-if="detail" class="flex flex-col gap-4">
        <!-- 仓库路径（只读上下文） -->
        <div class="flex items-center gap-2 text-sm">
          <UIcon name="i-lucide-book-marked" class="size-4 text-muted shrink-0" />
          <span class="text-highlighted font-medium truncate">{{ detail.path }}</span>
          <!-- 归档态徽标 -->
          <UBadge
            v-if="detail.archived"
            color="warning"
            variant="subtle"
            size="sm"
            :label="t('repo.settings.archivedBadge')"
          />
        </div>

        <!-- 可见性：只读（PATCH 无 visibility 字段，设计文档 §1.1） -->
        <UFormField :label="t('repo.settings.visibility')" :description="t('repo.settings.visibilityLocked')">
          <div class="flex items-center gap-2">
            <UBadge
              v-if="badge"
              :color="badge.color"
              variant="subtle"
              size="sm"
              :label="badge.label"
            />
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              icon="i-lucide-external-link"
              :label="t('repo.settings.openInWeb')"
              @click="openExternal(webSettingsUrl)"
            />
          </div>
        </UFormField>

        <!-- 描述 -->
        <UFormField :label="t('repo.settings.description')">
          <UTextarea
            v-model="form.description"
            class="w-full"
            :rows="3"
            autoresize
            :placeholder="t('repo.settings.descriptionPlaceholder')"
          />
        </UFormField>

        <!-- 主页 site -->
        <UFormField :label="t('repo.settings.site')">
          <UInput
            v-model="form.site"
            class="w-full"
            placeholder="https://example.com"
          />
        </UFormField>

        <!-- 开源协议 license -->
        <UFormField :label="t('repo.settings.license')">
          <UInput
            v-model="form.license"
            class="w-full"
            placeholder="MIT"
          />
        </UFormField>

        <!-- 主题标签 topics（逗号分隔） -->
        <UFormField :label="t('repo.settings.topics')">
          <UInput
            v-model="form.topicsText"
            class="w-full"
            :placeholder="t('repo.settings.topicsPlaceholder')"
          />
        </UFormField>

        <!-- 操作区：归档/解除归档在左，保存/取消在右 -->
        <div class="flex justify-between gap-2 pt-2 border-t border-default">
          <UButton
            v-if="detail && !detail.archived"
            color="warning"
            variant="soft"
            icon="i-lucide-archive"
            :label="t('repo.settings.archive')"
            @click="archiveDialogOpen = true"
          />
          <UButton
            v-else
            color="primary"
            variant="soft"
            icon="i-lucide-archive-restore"
            :label="t('repo.settings.unarchive')"
            @click="unarchiveDialogOpen = true"
          />

          <div class="flex gap-2">
            <UButton
              color="neutral"
              variant="ghost"
              :label="t('common.cancel')"
              @click="emit('update:open', false)"
            />
            <UButton
              color="primary"
              :loading="saving"
              :label="t('common.save')"
              @click="onSave"
            />
          </div>
        </div>
      </div>

      <!-- 详情未就绪：骨架 -->
      <div v-else class="flex flex-col gap-3">
        <USkeleton class="h-8 w-full rounded-md" />
        <USkeleton class="h-16 w-full rounded-md" />
        <USkeleton class="h-8 w-2/3 rounded-md" />
      </div>
    </template>
  </UDrawer>

  <!-- 归档二次确认（破坏性：error 色；文案写清后果与不可逆性） -->
  <ConfirmDialog
    v-model:open="archiveDialogOpen"
    :title="t('repo.settings.archive')"
    :desc="t('repo.settings.archiveConfirm', { path: detail?.path || '' })"
    :confirm-label="t('repo.settings.archive')"
    confirm-color="error"
    :loading="archiving"
    @confirm="doArchive"
  />

  <!-- 解除归档（非破坏性恢复）：primary 色 -->
  <ConfirmDialog
    v-model:open="unarchiveDialogOpen"
    :title="t('repo.settings.unarchive')"
    :desc="t('repo.settings.unarchiveConfirm', { path: detail?.path || '' })"
    :confirm-label="t('repo.settings.unarchive')"
    confirm-color="primary"
    :loading="archiving"
    @confirm="doUnarchive"
  />
</template>
