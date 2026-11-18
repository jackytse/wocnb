<script setup lang="ts">
/**
 * 仓库标签管理（REQ-03 / T05）。
 *
 * 挂载：Issue 列表页「标签管理」按钮打开 UModal 内嵌本组件；同一份
 * listRepoLabels 数据源也被 Issue 详情的标签选择器复用（避免两处漂移）。
 *
 * 交互：表格（色块 + 名称 + 描述 + 编辑/删除）；新建/编辑共用表单弹窗；
 * 删除走 ConfirmDialog（danger），文案写明"将从所有 Issue 移除"。
 * 写入口由父组件按 canManage 事前隐藏（repo-notes:rw），403 时 toast 降级不登出。
 * 每次 CRUD 成功后 emit('changed')，父组件据此重拉标签选择器。
 */
// 数据层：仓库标签 CRUD（通道依据：POST/PATCH 有 body 走 cnbFetch、DELETE 空 body 走 Void）
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
// 标签 CRUD 与实体类型（归一化后的 camelCase 结构，界面层不判空）
import {
  createRepoLabel,
  deleteRepoLabel,
  listRepoLabels,
  updateRepoLabel,
  type RepoLabel,
} from '../../composables/useCnbRepoLabels'
import StateAlert from './StateAlert.vue'
// 通用删除二次确认弹窗（danger 色，confirm 事件驱动执行删除）
import ConfirmDialog from '../common/ConfirmDialog.vue'

const props = defineProps<{
  /** 仓库完整路径（org/repo，路径编码由数据层负责） */
  repoPath: string
  /** 弹窗开关（父级 v-model:open 管理） */
  open: boolean
  /** 是否可写（repo-notes:rw / canManage 预判，false 时只读） */
  canManage?: boolean
}>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  /** 标签数据发生变更：父组件重拉 Issue 标签选择器 */
  (e: 'changed'): void
}>()

// i18n 文案与全局 toast（成功提示 / 失败透出服务端原因）
const { t } = useI18n()
const toast = useToast()

/** 弹窗开关的 v-model 代理（props.open 只读，写操作转 emit） */
const openModel = computed({
  get: () => props.open, // 读：透传父级状态
  set: (value: boolean) => emit('update:open', value), // 写：转 emit 由父级更新
})

// ---------------------------------------------------------------------------
// 列表（打开时懒加载，写后由本组件 load() 重拉）
// ---------------------------------------------------------------------------

/** 标签列表（归一化后；异常降级空数组） */
const labels = ref<RepoLabel[]>([])
/** 列表加载中（骨架屏） */
const loading = ref(false)
/** 列表加载异常（错误态可重试） */
const error = ref<Error | null>(null)

/** 拉取仓库标签列表（异常降级空列表 + 错误态可重试） */
async function load() {
  // 仓库路径为空：无从请求，直接跳过
  if (!props.repoPath) {
    return
  }
  loading.value = true
  error.value = null
  try {
    labels.value = await listRepoLabels(props.repoPath)
  }
  catch (err) {
    // 失败：清列表 + 记错误（StateAlert error 呈现，retry 调回本函数）
    labels.value = []
    error.value = err as Error
  }
  finally {
    loading.value = false
  }
}

// 打开时拉取（关闭期间外部可能已变更，每次打开都重新加载）
watch(() => `${props.repoPath}|${props.open}`, () => {
  if (props.open && props.repoPath) { // 打开且路径就绪才发请求
    void load()
  }
}, { immediate: true })

// ---------------------------------------------------------------------------
// 新建 / 编辑（共用一套表单）
// ---------------------------------------------------------------------------

/** 表单弹窗开关与编辑目标（null = 新建） */
const formOpen = ref(false)
/** 编辑中的标签（null = 新建模式；其 name 是 PATCH 的路径段） */
const editing = ref<RepoLabel | null>(null)
/** 表单草稿：名称必填，颜色/描述可清空（数据层以 !== undefined 区分清空与未改） */
const form = reactive({ name: '', color: '', description: '' })
/** 提交中（按钮 loading + 防重复） */
const submitting = ref(false)

/** 打开新建表单：清空草稿、编辑目标置 null */
function openCreate() {
  editing.value = null
  form.name = '' // 名称草稿清空
  form.color = '' // 颜色回落默认灰（预览用）
  form.description = '' // 描述清空
  formOpen.value = true
}

/** 打开编辑表单：回填当前值（编辑中名称即原 name，用于拼 PATCH 路径段） */
function openEdit(label: RepoLabel) {
  editing.value = label // 记录原值基准（提交时按差分计算 PATCH 字段）
  form.name = label.name
  form.color = label.color
  form.description = label.description
  formOpen.value = true
}

/** 名称必填校验（颜色/描述可留空） */
const nameError = computed(() => form.name.trim() ? null : t('repo.labels.nameRequired'))

/** 提交新建/编辑：编辑走增量 PATCH（仅变化字段），新建全量 POST */
async function onSubmit() {
  // 校验未过或已在提交中：直接返回（按钮 disabled，此处双保险）
  if (nameError.value || submitting.value) {
    return
  }
  submitting.value = true // 请求进行中（按钮 loading，防重复提交）
  try {
    if (editing.value) {
      const current = editing.value
      // 仅提交变化的字段（PATCH 增量）：清空场景会把空串传下去，
      // 数据层以 !== undefined 区分"清空"与"未修改"（BUG-01 语义）
      await updateRepoLabel(props.repoPath, current.name, {
        ...(form.name.trim() !== current.name ? { newName: form.name.trim() } : {}),
        ...(form.color !== current.color ? { color: form.color } : {}),
        ...(form.description !== current.description ? { description: form.description } : {}),
      })
      toast.add({ title: t('repo.labels.updateSuccess'), color: 'success', duration: 2500 })
    }
    else {
      // 新建：名称必填，颜色/描述按表单原样提交（空串也会下发）
      await createRepoLabel(props.repoPath, {
        name: form.name.trim(),
        color: form.color,
        description: form.description,
      })
      toast.add({ title: t('repo.labels.createSuccess'), color: 'success', duration: 2500 })
    }
    // 成功后：关表单 → 重拉列表 → 通知父级（Issue 标签选择器也要刷新）
    formOpen.value = false // 成功才关弹窗（失败保留草稿供修改）
    await load() // 以服务端返回为准重拉（含其他端可能的并发变更）
    emit('changed')
  }
  catch (err) {
    // 400（名称冲突等）/403（缺 repo-notes:rw）→ toast 透出，不静默吞不登出
    toast.add({
      title: editing.value ? t('repo.labels.updateFailed') : t('repo.labels.createFailed'),
      description: (err as Error)?.message || '',
      color: 'error',
      duration: 6000,
    })
  }
  finally {
    submitting.value = false // 无论成败恢复按钮（失败可重试）
  }
}

// ---------------------------------------------------------------------------
// 删除（二次确认 + error 色）
// ---------------------------------------------------------------------------

/** 删除确认弹窗开关 */
const deleteOpen = ref(false)
/** 删除目标（name 即唯一标识，重命名后以新 name 为准） */
const deleteTarget = ref<RepoLabel | null>(null)
/** 删除进行中（确认按钮 loading，防重复点击） */
const deleting = ref(false)

/** 打开删除确认：记录目标（标签名即唯一标识） */
function confirmDelete(label: RepoLabel) {
  deleteTarget.value = label
  deleteOpen.value = true
}

/** 执行删除：成功后重拉列表并通知父级刷新 Issue 标签选择器 */
async function doDelete() {
  const target = deleteTarget.value
  // 无目标或已在删除中：忽略（确认按钮 loading，此处双保险）
  if (!target?.name || deleting.value) {
    return
  }
  deleting.value = true // 删除进行中（确认按钮 loading，防重复）
  try {
    // DELETE /labels/{name}：204 空 body → cnbFetchVoid（数据层已处理）
    await deleteRepoLabel(props.repoPath, target.name)
    toast.add({ title: t('repo.labels.deleteSuccess'), color: 'success', duration: 2500 })
    deleteOpen.value = false // 成功才关确认弹窗
    await load() // 重拉列表：目标行消失
    emit('changed') // 通知父级刷新 Issue 标签选择器
  }
  catch (err) {
    toast.add({
      title: t('repo.labels.deleteFailed'),
      description: (err as Error)?.message || '',
      color: 'error',
      duration: 6000,
    })
  }
  finally {
    deleting.value = false // 无论成败恢复按钮（失败可重试）
  }
}
</script>

<template>
  <UModal
    v-model:open="openModel"
    :title="t('repo.labels.manage')"
    :ui="{ content: 'max-w-2xl' }"
  >
    <template #body>
      <div class="flex flex-col gap-3">
        <!-- 新建按钮：canManage 预判（repo-notes:rw） -->
        <div v-if="canManage" class="flex justify-end">
          <UButton
            size="sm"
            color="primary"
            variant="soft"
            icon="i-lucide-plus"
            :label="t('repo.labels.create')"
            @click="openCreate"
          />
        </div>

        <StateAlert v-if="loading" state="loading" loading-variant="list" />
        <StateAlert
          v-else-if="error"
          state="error"
          :error="error"
          :retry="load"
        />
        <StateAlert
          v-else-if="labels.length === 0"
          state="empty"
          :empty-text="t('repo.labels.empty')"
        />
        <div v-else class="flex flex-col border border-default rounded-lg divide-y divide-default overflow-hidden">
          <div
            v-for="label in labels"
            :key="label.name"
            class="flex items-center gap-3 px-3 py-2.5"
          >
            <!-- 色彩 chip：复用 Issue 详情标签样式（color + ${color}1a 背景） -->
            <span
              class="size-3 rounded-full shrink-0 border border-default"
              :style="{ backgroundColor: label.color || '#a1a1aa' }"
            />
            <span class="text-sm text-highlighted font-medium min-w-0 truncate">{{ label.name }}</span>
            <span class="text-xs text-dimmed flex-1 min-w-0 truncate">{{ label.description }}</span>
            <template v-if="canManage">
              <UButton
                size="xs"
                color="neutral"
                variant="ghost"
                icon="i-lucide-pencil"
                :aria-label="t('repo.labels.edit')"
                @click="openEdit(label)"
              />
              <UButton
                size="xs"
                color="error"
                variant="ghost"
                icon="i-lucide-trash-2"
                :aria-label="t('repo.labels.delete')"
                @click="confirmDelete(label)"
              />
            </template>
          </div>
        </div>
      </div>
    </template>
  </UModal>

  <!-- 新建 / 编辑表单（嵌套弹窗） -->
  <UModal
    v-model:open="formOpen"
    :title="editing ? t('repo.labels.edit') : t('repo.labels.create')"
    :ui="{ content: 'max-w-md' }"
  >
    <template #body>
      <div class="flex flex-col gap-4">
        <UFormField :label="t('repo.labels.name')" required :error="nameError ?? undefined">
          <UInput v-model="form.name" class="w-full" autocomplete="off" />
        </UFormField>
        <UFormField :label="t('repo.labels.color')">
          <div class="flex items-center gap-2 w-full">
            <span
              class="size-8 rounded-md border border-default shrink-0"
              :style="{ backgroundColor: form.color || '#a1a1aa' }"
            />
            <UInput
              v-model="form.color"
              class="flex-1"
              :placeholder="t('repo.labels.colorPlaceholder')"
            />
          </div>
        </UFormField>
        <UFormField :label="t('repo.labels.description')">
          <UInput v-model="form.description" class="w-full" />
        </UFormField>
      </div>
    </template>
    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton
          color="neutral"
          variant="ghost"
          :label="t('common.cancel')"
          @click="formOpen = false"
        />
        <UButton
          color="primary"
          :loading="submitting"
          :disabled="!!nameError"
          :label="editing ? t('common.save') : t('repo.labels.create')"
          @click="onSubmit"
        />
      </div>
    </template>
  </UModal>

  <!-- 删除二次确认 -->
  <ConfirmDialog
    v-model:open="deleteOpen"
    :title="t('repo.labels.delete')"
    :desc="t('repo.labels.deleteConfirm', { name: deleteTarget?.name || '' })"
    :confirm-label="t('repo.labels.delete')"
    confirm-color="error"
    :loading="deleting"
    @confirm="doDelete"
  />
</template>
