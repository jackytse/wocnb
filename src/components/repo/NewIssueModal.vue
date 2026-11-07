<script setup lang="ts">
/**
 * 新建 Issue 表单弹窗（PRD P0-B6）。
 *
 * 校验：title 必填 1–200 字（接口限制 2–255，取更严格的产品口径）；
 * labels/assignees 为逗号分隔的字符串输入（服务端收 string[]）。
 * 成功：若返回体带 number → emit('created', number) 跳新详情；
 * 拿不到编号 → toast 提示并 emit('created') 回列表兜底（返回体未定型，R10）。
 * 失败：保留输入 + toast 透出服务端 errmsg。
 */
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { createRepoIssue } from '../../composables/useCnbRepo'

const props = defineProps<{
  open: boolean
  repoPath: string
}>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  /** 成功创建：带新编号时跳详情，不带时调用方回列表刷新 */
  (e: 'created', number?: string): void
}>()

const { t } = useI18n()
const toast = useToast()

/**
 * 优先级「不设置」的哨兵值。
 *
 * 为什么不用空串（与 RepoBuildList 的 STATUS_ALL 同源踩坑）：USelect 底层
 * Reka UI 的 SelectItem 禁止 `value: ''`（空串被保留给"未选中 / 显示
 * placeholder"），items 里出现空串会在渲染期抛错并中断整个弹窗的渲染。
 *
 * 注意：必须声明在 form 之前 —— form 的初始值引用了它（TDZ）。
 */
const PRIORITY_NONE = 'none'

/** 表单状态（打开弹窗时重置） */
const form = reactive({
  title: '',
  body: '',
  labels: '',
  assignees: '',
  // 默认"不设置"哨兵（下拉不允许空串，见 PRIORITY_NONE 注释）
  priority: PRIORITY_NONE,
})

/** 提交中标记（按钮 loading + 禁用防重复） */
const submitting = ref(false)

const openModel = computed({
  get: () => props.open,
  set: (value: boolean) => emit('update:open', value),
})

// 弹窗打开时重置表单（避免上次草稿串到下一个 Issue）
watch(() => props.open, (value) => {
  if (value) {
    form.title = ''
    form.body = ''
    form.labels = ''
    form.assignees = ''
    form.priority = PRIORITY_NONE
  }
})

/** title 校验：必填 1-200 字 */
const titleError = computed(() => {
  const len = form.title.trim().length
  if (len === 0) {
    return t('issues.titlePlaceholder')
  }
  if (len > 200) {
    return t('issues.titleTooLong')
  }
  return null
})

/** 优先级选项（CNB 枚举：-2P ~ P3） */
const priorityOptions = ['-2P', '-1P', 'P0', 'P1', 'P2', 'P3']

/** 优先级下拉选项（首项"不设置"，用于把已选优先级清空；value 一律非空） */
const priorityItems = computed(() => [
  { label: t('issues.priorityNone'), value: PRIORITY_NONE },
  ...priorityOptions.map(value => ({ label: value, value })),
])

/** 逗号分隔输入 → 数组（去空项） */
function splitCsv(value: string): string[] {
  return value.split(/[,，]/).map(s => s.trim()).filter(Boolean)
}

/** 提交创建 */
async function onSubmit() {
  if (titleError.value || submitting.value) {
    return
  }
  submitting.value = true
  try {
    const result = await createRepoIssue(props.repoPath, {
      title: form.title.trim(),
      body: form.body.trim() || undefined,
      labels: splitCsv(form.labels),
      assignees: splitCsv(form.assignees),
      // 哨兵 → 不传该字段（服务端按"未设置"处理）
      priority: form.priority === PRIORITY_NONE ? undefined : form.priority,
    })
    toast.add({
      title: result.number
        ? t('issues.createSuccess')
        : t('issues.createNoNumber'),
      color: 'success',
      duration: 3000,
    })
    emit('created', result.number)
  }
  catch (err) {
    // 失败保留草稿（form 不清空），透出服务端信息
    toast.add({
      title: t('issues.createFailed'),
      description: (err as Error)?.message || '',
      color: 'error',
      duration: 5000,
    })
  }
  finally {
    submitting.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="openModel"
    :title="t('issues.newIssue')"
    :ui="{ content: 'max-w-xl' }"
  >
    <template #body>
      <div class="flex flex-col gap-4">
        <UFormField :label="t('issues.titleLabel')" required :error="titleError ?? undefined">
          <UInput
            v-model="form.title"
            class="w-full"
            :placeholder="t('issues.titlePlaceholder')"
            maxlength="220"
          />
        </UFormField>

        <UFormField :label="t('issues.bodyLabel')">
          <UTextarea
            v-model="form.body"
            class="w-full"
            :rows="6"
            autoresize
            :placeholder="t('issues.bodyPlaceholder')"
          />
        </UFormField>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <UFormField :label="t('issues.labelsLabel')">
            <UInput
              v-model="form.labels"
              class="w-full"
              :placeholder="t('issues.labelsPlaceholder')"
            />
          </UFormField>
          <UFormField :label="t('issues.priorityLabel')">
            <USelect
              v-model="form.priority"
              class="w-full"
              :items="priorityItems"
              value-key="value"
            />
          </UFormField>
        </div>

        <UFormField :label="t('issues.assigneesLabel')">
          <UInput
            v-model="form.assignees"
            class="w-full"
            :placeholder="t('issues.assigneesPlaceholder')"
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
          :disabled="!!titleError"
          :label="submitting ? t('issues.creating') : t('issues.create')"
          @click="onSubmit"
        />
      </div>
    </template>
  </UModal>
</template>
