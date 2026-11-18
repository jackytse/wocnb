<script setup lang="ts">
/**
 * 新建分支弹窗（REQ-01 / T04）。
 *
 * 校验口径（设计 §2.1）：
 * - name 必填，仅允许 [A-Za-z0-9._/-]（分支名合法字符），且与已有 refs 不重复；
 * - startPoint 默认当前 ref（当前分支/标签），用户可下拉改选；
 * - 提交走 createBranch（POST /git/branches，201 空 body → cnbFetchVoid）。
 *
 * 失败处理：400（名字非法/重复）或 403（缺 repo-code:rw）由 toast 透出服务端
 * 信息，**不静默吞、不登出**（只有 401 触发全局登出）；保留草稿供用户修改。
 */
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { createBranch } from '../../composables/useCnbGitRefs'

const props = defineProps<{
  /** 弹窗开关（父级 v-model:open 管理） */
  open: boolean
  /** 仓库完整路径（org/repo，路径编码由数据层负责） */
  repoPath: string
  /** 当前 ref（作为 startPoint 默认值） */
  defaultRef: string
  /** 已有分支/标签名（用于重名校验） */
  refs: string[]
}>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  /** 新建成功：携带新分支名，父组件重拉列表并自动切换 */
  (e: 'created', name: string): void
}>()

// i18n 文案与全局 toast（成功提示 / 失败透出服务端原因）
const { t } = useI18n()
const toast = useToast()

/** 表单状态（每次打开重置：name 清空，startPoint 回落当前 ref） */
const form = reactive({ name: '', startPoint: '' })
/** 提交中（按钮 loading + 防重复提交） */
const submitting = ref(false)

/** 弹窗开关的 v-model 代理（props.open 只读，写操作转 emit） */
const openModel = computed({
  get: () => props.open, // 读：透传父级状态
  set: (value: boolean) => emit('update:open', value), // 写：转 emit 由父级更新
})

/** startPoint 候选项：已有 refs（去重后），默认当前 ref 通常在其中 */
const startPointItems = computed(() => {
  // 当前 ref 可能不在已有列表中（如历史标签），合并去重保证可选中
  const names = [...new Set([props.defaultRef, ...props.refs])].filter(Boolean)
  return names.map(name => ({ label: name, value: name })) // 转成 label/value 结构
})

// 每次打开重置表单：name 清空，startPoint 回落到当前 ref（常见诉求：从当前位置拉分支）
watch(() => props.open, (value) => {
  if (value) { // 仅打开时重置；关闭时保留输入无意义
    form.name = '' // 名称草稿清空，等待新输入
    form.startPoint = props.defaultRef || '' // 起点回落当前 ref
  }
})

/**
 * name 校验：返回错误文案（null 表示通过）。
 * 正则 ^[A-Za-z0-9._/-]+$ 与 CNB/Git 分支命名一致，允许 '/' 但不能有空格。
 * 三段校验依次为：非空 → 字符合法 → 不与已有分支/标签重名。
 */
const nameError = computed(() => {
  const name = form.name.trim()
  if (!name) {
    return t('repo.branches.nameRequired')
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(name)) {
    return t('repo.branches.nameInvalid')
  }
  if (props.refs.includes(name)) {
    return t('repo.branches.nameDuplicate')
  }
  return null
})

/** 提交新建：校验通过才发请求（POST /git/branches → cnbFetchVoid，数据层处理） */
async function onSubmit() {
  // 校验未过或已在提交中：直接返回（按钮本身也 disabled，此处双保险）
  if (nameError.value || submitting.value) {
    return
  }
  submitting.value = true
  try {
    // startPoint 未改（等于当前 ref）时也可省略，服务端默认 HEAD；显式传更稳
    await createBranch(props.repoPath, {
      name: form.name.trim(),
      ...(form.startPoint ? { startPoint: form.startPoint } : {}),
    })
    toast.add({ title: t('repo.branches.createSuccess'), color: 'success', duration: 2500 })
    // 先关弹窗再通知父级（父级重拉列表并 switchRef 自动切到新分支）
    emit('update:open', false)
    emit('created', form.name.trim())
  }
  catch (err) {
    // 400/403 等：透出服务端原因（403 只降级提示，绝不登出）
    toast.add({
      title: t('repo.branches.createFailed'),
      description: (err as Error)?.message || '',
      color: 'error',
      duration: 6000,
    })
  }
  finally {
    // 表单不重置：失败时保留草稿供用户修改后重试
    submitting.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="openModel"
    :title="t('repo.branches.create')"
    :ui="{ content: 'max-w-lg' }"
  >
    <template #body>
      <div class="flex flex-col gap-4">
        <UFormField :label="t('repo.branches.name')" required :error="nameError ?? undefined">
          <UInput
            v-model="form.name"
            class="w-full"
            :placeholder="t('repo.branches.namePlaceholder')"
            autocomplete="off"
          />
        </UFormField>
        <UFormField :label="t('repo.branches.startPoint')">
          <USelectMenu
            v-model="form.startPoint"
            class="w-full"
            :items="startPointItems"
            value-key="value"
            label-key="label"
            :placeholder="t('repo.branches.startPointPlaceholder')"
          />
        </UFormField>
      </div>
    </template>

    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton
          color="neutral"
          variant="ghost"
          :label="t('common.cancel')"
          @click="emit('update:open', false)"
        />
        <UButton
          color="primary"
          :loading="submitting"
          :disabled="!!nameError"
          :label="t('repo.branches.create')"
          @click="onSubmit"
        />
      </div>
    </template>
  </UModal>
</template>
