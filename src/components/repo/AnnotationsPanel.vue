<script setup lang="ts">
/**
 * 通用元数据（annotations）折叠面板 —— 批次 2 · REQ-08。
 *
 * 同一个组件服务两种资源（tag / commit），差异只在数据层函数：
 * - `kind='tag'`    → listTagAnnotations / putTagAnnotations / deleteTagAnnotation
 * - `kind='commit'` → listCommitAnnotations / putCommitAnnotations / deleteCommitAnnotation
 *
 * 交互：
 * - 折叠展开时才请求（默认收起，避免打开详情页就发无谓请求）；
 * - 新增/编辑走行内 UModal（key + value 两个输入）；
 * - 删除走 ConfirmDialog（不可逆，danger 色）；
 * - 写入语义是**整体覆盖**（服务端 PUT 以本次列表为准），因此编辑单条时
 *   要把"改后的完整列表"提交，而不是只发这一条。
 *
 * 权限：`canEdit=false` 时只读展示，不渲染新增/编辑/删除入口（事前隐藏，
 * 不做事后 403 报错）；真实 403 仍由数据层抛出、由本组件的提示条兜底。
 */
// 数据层：tag / commit 两组同构元数据端点（list/put/delete），按 kind 分派
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  deleteCommitAnnotation,
  deleteTagAnnotation,
  listCommitAnnotations,
  listTagAnnotations,
  putCommitAnnotations,
  putTagAnnotations,
  type AnnotationItem,
} from '../../composables/useCnbAnnotations'
// 通用删除二次确认（不可逆操作）
import ConfirmDialog from '../common/ConfirmDialog.vue'
import { useAppToast } from '../../composables/useAppToast'

const props = defineProps<{
  /** 完整仓库路径 */
  repoPath: string
  /** 资源类型 */
  kind: 'tag' | 'commit'
  /** tag 名或 commit sha */
  refKey: string
  /** 是否可编辑（false → 只读） */
  canEdit: boolean
}>()

const { t } = useI18n()
const toast = useAppToast() // 保存/删除成功与失败提示

/** 是否展开（展开即触发首次加载） */
const expanded = ref(false)
/** 元数据列表（key/value 对；写后由本组件本地更新） */
const items = ref<AnnotationItem[]>([])
/** 列表加载中（行内提示） */
const loading = ref(false)
/** 加载错误（403/网络等，展示为提示条，不影响页面主体） */
const loadError = ref('')
/** 是否已加载过（避免每次折叠都重拉） */
const loaded = ref(false)

/** 按 kind 选读函数（与写函数同理，差异只在资源类型） */
async function fetchItems(): Promise<AnnotationItem[]> {
  // tag 与 commit 是两组同构端点，仅路径资源段不同
  return props.kind === 'tag'
    ? listTagAnnotations(props.repoPath, props.refKey)
    : listCommitAnnotations(props.repoPath, props.refKey)
}

/** 按 kind 选"整体覆盖写"函数 */
async function putItems(next: AnnotationItem[]): Promise<void> {
  // PUT 语义：以本次列表为最终状态（不是增量合并）
  return props.kind === 'tag'
    ? putTagAnnotations(props.repoPath, props.refKey, next)
    : putCommitAnnotations(props.repoPath, props.refKey, next)
}

/** 按 kind 选删除函数 */
async function deleteItem(key: string): Promise<void> {
  return props.kind === 'tag'
    ? deleteTagAnnotation(props.repoPath, props.refKey, key)
    : deleteCommitAnnotation(props.repoPath, props.refKey, key)
}

/** 加载列表（失败只记录错误文案，不抛到页面级） */
async function load() {
  // 资源未就绪（tag 名/sha 为空）：清列表直接返回
  if (!props.repoPath || !props.refKey) {
    items.value = []
    return
  }
  loading.value = true // 行内加载提示
  loadError.value = ''
  try {
    items.value = await fetchItems()
    loaded.value = true // 标记已加载：折叠再展开不重复请求
  }
  catch (err) {
    items.value = []
    loadError.value = (err as Error)?.message || String(err)
  }
  finally {
    loading.value = false
  }
}

/** 展开时首次加载；已加载过则不重复请求（数据由写操作后主动刷新） */
watch(expanded, (value) => {
  if (value && !loaded.value) { // 未加载过才发请求（折叠往返零开销）
    void load()
  }
})

// ---------------------------------------------------------------------------
// 新增 / 编辑（同一个 UModal，editingKey 区分模式）
// ---------------------------------------------------------------------------

const formOpen = ref(false)
/** 正在编辑的 key（空串 = 新增） */
const editingKey = ref('')
const formKey = ref('') // 表单 key 输入（新增可编辑，编辑态禁用）
const formValue = ref('') // 表单 value 输入
const saving = ref(false) // 保存请求进行中

/** key 校验：必填且不与已有条目重名（重名会覆盖服务端同键数据，必须拦住） */
const keyError = computed(() => {
  const key = formKey.value.trim()
  // 空值：必填拦截
  if (!key) {
    return t('repo.annotations.keyRequired')
  }
  // 重名：排除自身（编辑态 key 不变是合法的）
  const conflict = items.value.some(item => item.key === key && item.key !== editingKey.value)
  return conflict ? t('repo.annotations.keyDuplicate') : ''
})

/** 打开新增 */
function openCreate() {
  editingKey.value = ''
  formKey.value = '' // key 清空待输入
  formValue.value = '' // value 清空待输入
  formOpen.value = true
}

/** 打开编辑（预填当前值） */
function openEdit(item: AnnotationItem) {
  editingKey.value = item.key // 记录原 key（提交时按它定位替换）
  formKey.value = item.key
  formValue.value = item.value
  formOpen.value = true
}

/**
 * 保存：构造"改后的完整列表"整体 PUT。
 * - 新增：追加到末尾；
 * - 编辑：替换同 key 条目的 value（key 本身不可改，改 key 等价于删旧建新，
 *   这里直接禁用 key 输入）。
 */
async function onSave() {
  // 校验未过或已在保存中：直接返回（按钮 disabled，双保险）
  if (saving.value || keyError.value) {
    return
  }
  const key = formKey.value.trim()
  const value = formValue.value
  // 整体覆盖语义：编辑替换同 key 项，新增追加到末尾（列表顺序即展示顺序）
  const next: AnnotationItem[] = editingKey.value
    ? items.value.map(item => (item.key === editingKey.value ? { ...item, value } : item))
    : [...items.value, { key, value, meta: {} }]
  saving.value = true
  try {
    await putItems(next)
    items.value = next // 本地生效（PUT 成功即以本地列表为准，避免重拉）
    formOpen.value = false
    toast.add({ title: t('repo.annotations.saved'), color: 'success', duration: 2500 })
  }
  catch (err) {
    // 失败保留弹窗与输入，便于改后重试；透出服务端原因
    toast.add({
      title: t('repo.annotations.saveFailed'),
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
// 删除（ConfirmDialog 二次确认，不可逆）
// ---------------------------------------------------------------------------

const deleteOpen = ref(false) // 删除确认弹窗开关
const deleteKey = ref('') // 待删除的 key
const deleting = ref(false) // 删除请求进行中（确认按钮 loading）

/** 打开删除确认（记录目标 key） */
function askDelete(key: string) {
  deleteKey.value = key
  deleteOpen.value = true
}

/** 确认删除：单条 DELETE 成功后本地移除该行（不需要重拉整表） */
async function onDeleteConfirm() {
  // 无目标或已在删除中：直接返回
  if (!deleteKey.value || deleting.value) {
    return
  }
  deleting.value = true
  try {
    await deleteItem(deleteKey.value)
    // 本地移除：key 即唯一标识，过滤即可
    items.value = items.value.filter(item => item.key !== deleteKey.value)
    deleteOpen.value = false
    deleteKey.value = ''
    toast.add({ title: t('repo.annotations.deleted'), color: 'success', duration: 2500 })
  }
  catch (err) {
    toast.add({
      title: t('repo.annotations.deleteFailed'),
      description: (err as Error)?.message || '',
      color: 'error',
      duration: 6000,
    })
  }
  finally {
    deleting.value = false
  }
}

/** refKey 变化（切 tag / 切 commit）→ 收起并重置缓存，下次展开重新拉 */
watch(() => props.refKey, () => {
  expanded.value = false // 收起：新资源不该沿用旧展开态
  loaded.value = false // 强制重新加载（旧资源的列表不可复用）
  items.value = []
})
</script>

<template>
  <div class="flex flex-col gap-2">
    <!-- 折叠头：标题 + 条数 + 新增入口 + 展开按钮 -->
    <div class="flex items-center gap-2">
      <UIcon name="i-lucide-tags" class="size-4 text-muted" />
      <span class="text-sm font-medium text-highlighted">{{ t('repo.annotations.title') }}</span>
      <UBadge
        v-if="loaded"
        color="neutral"
        variant="subtle"
        size="sm"
        :label="String(items.length)"
      />
      <div class="ms-auto flex items-center gap-1">
        <UButton
          v-if="canEdit"
          size="xs"
          color="primary"
          variant="ghost"
          icon="i-lucide-plus"
          :aria-label="t('repo.annotations.create')"
          @click="openCreate"
        />
        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          :icon="expanded ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
          :aria-label="t('repo.annotations.toggle')"
          @click="expanded = !expanded"
        />
      </div>
    </div>

    <!-- 展开区 -->
    <div v-if="expanded" class="flex flex-col gap-2 rounded-md border border-default p-2">
      <!-- 加载错误（403/网络）：只在本区块提示，不影响页面主体（G2） -->
      <p v-if="loadError" class="text-xs text-error">
        {{ loadError }}
      </p>
      <p v-else-if="loading" class="text-xs text-dimmed">
        {{ t('common.loading') }}
      </p>
      <p v-else-if="items.length === 0" class="text-xs text-dimmed">
        {{ t('repo.annotations.empty') }}
      </p>

      <!-- key/value 表格；meta 仅只读展示操作者与时间等审计信息 -->
      <table v-else class="w-full text-xs">
        <thead>
          <tr class="text-left text-dimmed border-b border-default">
            <th class="py-1 font-normal">
              {{ t('repo.annotations.colKey') }}
            </th>
            <th class="py-1 font-normal">
              {{ t('repo.annotations.colValue') }}
            </th>
            <th v-if="canEdit" class="py-1 font-normal text-right">
              {{ t('repo.annotations.colActions') }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in items" :key="item.key" class="border-b border-default last:border-b-0">
            <td class="py-1 font-mono truncate max-w-40" :title="item.key">
              {{ item.key }}
            </td>
            <td class="py-1 break-all">
              {{ item.value }}
            </td>
            <td v-if="canEdit" class="py-1 text-right whitespace-nowrap">
              <UButton
                size="xs"
                color="neutral"
                variant="ghost"
                icon="i-lucide-pencil"
                :aria-label="t('common.edit')"
                @click="openEdit(item)"
              />
              <UButton
                size="xs"
                color="error"
                variant="ghost"
                icon="i-lucide-trash-2"
                :aria-label="t('common.delete')"
                @click="askDelete(item.key)"
              />
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 新增/编辑弹窗 -->
    <UModal
      v-model:open="formOpen"
      :title="editingKey ? t('repo.annotations.edit') : t('repo.annotations.create')"
    >
      <template #body>
        <div class="flex flex-col gap-3">
          <UFormField
            :label="t('repo.annotations.colKey')"
            required
            :error="keyError || undefined"
          >
            <!-- 编辑态禁用 key：改 key 等价于删旧建新，语义应用删除+新增表达 -->
            <UInput
              v-model="formKey"
              class="w-full"
              :disabled="!!editingKey"
              autocomplete="off"
            />
          </UFormField>
          <UFormField :label="t('repo.annotations.colValue')">
            <UInput v-model="formValue" class="w-full" autocomplete="off" />
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
            :loading="saving"
            :disabled="!!keyError"
            :label="t('common.save')"
            @click="onSave"
          />
        </div>
      </template>
    </UModal>

    <!-- 删除确认 -->
    <ConfirmDialog
      v-model:open="deleteOpen"
      :title="t('repo.annotations.deleteTitle')"
      :desc="t('repo.annotations.deleteDesc', { key: deleteKey })"
      :confirm-label="t('common.delete')"
      confirm-color="error"
      :loading="deleting"
      @confirm="onDeleteConfirm"
    />
  </div>
</template>
