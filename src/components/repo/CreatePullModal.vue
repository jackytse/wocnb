<script setup lang="ts">
/**
 * 新建合并请求弹窗（REQ-05 / T06）。
 *
 * 表单：标题（2~255）、源分支 head、目标分支 base、正文 body。
 * head/base 用 RepoBranchSelect 的 selectMode='emit'（本地选择态），
 * **不写 ?ref=** —— 否则会误清列表页的 number/page 等下钻键。
 *
 * 提交走 createPull（POST /pulls，201 api.Pull 有 body → cnbFetch），
 * 成功后 emit('created', pull) → RepoPullList 直接 openPull(number) 跳详情。
 * 失败（400 分支不存在 / 403 缺 repo-pr:rw）toast 透出，不静默吞不登出。
 */
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { createPull, type RepoPull } from '../../composables/useCnbRepo'
import RepoBranchSelect from './RepoBranchSelect.vue'
import { useAppToast } from '../../composables/useAppToast'

const props = defineProps<{
  /** 弹窗开关（父级 v-model:open 管理） */
  open: boolean
  /** 仓库完整路径（org/repo，路径编码由数据层负责） */
  repoPath: string
  /** 默认源分支（当前 ref；目标分支通常为主干，由用户改选） */
  defaultRef: string
}>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  /** 新建成功：携带完整 PR，父组件跳详情 */
  (e: 'created', pull: RepoPull): void
}>()

// i18n 文案与全局 toast（成功提示 / 失败透出服务端原因）
const { t } = useI18n()
const toast = useAppToast()

/** 表单状态：标题 / 源分支 head / 目标分支 base / 正文（每次打开重置） */
const form = reactive({ title: '', head: '', base: '', body: '' })
const submitting = ref(false)

/** 弹窗开关的 v-model 代理（props.open 只读，写操作转 emit） */
const openModel = computed({
  get: () => props.open, // 读：透传父级状态
  set: (value: boolean) => emit('update:open', value), // 写：转 emit 由父级更新
})

// 每次打开重置表单：head 回落到当前 ref，base 置空由用户明确选择
watch(() => props.open, (value) => {
  if (value) { // 仅打开时重置；失败保留草稿由 catch 分支负责（不在此清）
    form.title = '' // 标题草稿清空
    form.head = props.defaultRef || '' // 源分支回落当前 ref（常见诉求：从当前位置发起）
    form.base = '' // 目标分支置空：必须由用户显式选择，不猜主干名
    form.body = '' // 正文草稿清空
  }
})

/** 标题校验：必填且 2~255 字（swagger api.PullCreationForm 的长度约束） */
const titleError = computed(() => {
  const len = form.title.trim().length
  if (len < 2) { // 太短：至少 2 个字符（含中文按字符计）
    return t('repo.pulls.titleRequired')
  }
  if (len > 255) { // 太长：超出服务端字段上限
    return t('repo.pulls.titleTooLong')
  }
  return null
})

/** 分支选择校验：head/base 都必填且不能相同（相同分支无比较意义，服务端也会拒） */
const branchesError = computed(() => {
  if (!form.head || !form.base) { // 任一未选：必填校验
    return t('repo.pulls.branchesRequired')
  }
  if (form.head === form.base) { // 相同分支：无差异可比较
    return t('repo.pulls.sameBranch')
  }
  return null
})

/** 提交新建：校验通过才发请求（POST /pulls → cnbFetch，数据层处理通道） */
async function onSubmit() {
  // 校验未过或已在提交中：直接返回（按钮 disabled，此处双保险）
  if (titleError.value || branchesError.value || submitting.value) {
    return
  }
  submitting.value = true
  try {
    // 正文为空白时省略 body 字段（不创建只含空正文的 PR）
    const pull = await createPull(props.repoPath, {
      title: form.title.trim(),
      head: form.head,
      base: form.base,
      ...(form.body.trim() ? { body: form.body.trim() } : {}),
    })
    toast.add({ title: t('repo.pulls.createSuccess'), color: 'success', duration: 2500 })
    // 先关弹窗再通知父级（父级 openPull(number) 直接跳转到新 PR 详情）
    emit('update:open', false)
    emit('created', pull)
  }
  catch (err) {
    // 400（分支不存在）/403（缺 repo-pr:rw）→ toast 透出，不静默吞不登出
    toast.add({
      title: t('repo.pulls.createFailed'),
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
    :title="t('repo.pulls.create')"
    :ui="{ content: 'max-w-2xl' }"
  >
    <template #body>
      <div class="flex flex-col gap-4">
        <UFormField :label="t('repo.pulls.titleLabel')" required :error="titleError ?? undefined">
          <UInput
            v-model="form.title"
            class="w-full"
            :placeholder="t('repo.pulls.titlePlaceholder')"
            autocomplete="off"
          />
        </UFormField>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <UFormField :label="t('repo.pulls.head')" required>
            <!-- emit 模式：本地选择态，不写 ?ref= -->
            <RepoBranchSelect
              v-model="form.head"
              :repo-path="repoPath"
              select-mode="emit"
            />
          </UFormField>
          <UFormField :label="t('repo.pulls.base')" required>
            <RepoBranchSelect
              v-model="form.base"
              :repo-path="repoPath"
              select-mode="emit"
            />
          </UFormField>
        </div>
        <p v-if="branchesError" class="text-xs text-error">
          {{ branchesError }}
        </p>

        <UFormField :label="t('repo.pulls.body')">
          <UTextarea
            v-model="form.body"
            class="w-full"
            :rows="6"
            autoresize
            :placeholder="t('repo.pulls.bodyPlaceholder')"
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
          :disabled="!!titleError || !!branchesError"
          :label="t('repo.pulls.create')"
          @click="onSubmit"
        />
      </div>
    </template>
  </UModal>
</template>
