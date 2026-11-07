<script setup lang="ts">
/**
 * 合并确认弹窗（PRD P0-C6，P1 优先级实装）。
 *
 * 交互：merge_style 下拉（默认 merge —— 仓库设置接口未取到时的兜底）+
 * 可选 commit_title / commit_message；明示目标分支；确认合并（危险动作
 * 二次确认由本弹窗本身承担）；失败透出服务端 message 且留在详情页。
 */
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { mergePull, type RepoPull } from '../../composables/useCnbRepo'

const props = defineProps<{
  open: boolean
  /** 当前 PR（用于明示 base←head 与默认标题） */
  pull: RepoPull | null
  repoPath: string
}>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  /** 合并成功（带返回 sha 或 undefined） */
  (e: 'merged', sha?: string): void
}>()

const { t } = useI18n()
const toast = useToast()

const form = reactive({
  mergeStyle: 'merge' as 'merge' | 'squash' | 'rebase',
  commitTitle: '',
  commitMessage: '',
})
const submitting = ref(false)
/** 服务端返回的失败 message（透出给用户，PRD P0-C6） */
const serverError = ref('')

const openModel = computed({
  get: () => props.open,
  set: (value: boolean) => emit('update:open', value),
})

// 弹窗打开时重置表单与错误，并用 PR 标题预填 commit title（服务端默认行为的近似）
watch(() => props.open, (value) => {
  if (value) {
    form.mergeStyle = 'merge'
    form.commitTitle = ''
    form.commitMessage = ''
    serverError.value = ''
  }
})

/** 合并方式选项（下拉文案三语化） */
const styleItems = computed(() => [
  { label: t('pulls.mergeStyleMerge'), value: 'merge' },
  { label: t('pulls.mergeStyleSquash'), value: 'squash' },
  { label: t('pulls.mergeStyleRebase'), value: 'rebase' },
])

/** 目标分支说明（明示 base，PRD 验收点） */
const targetDesc = computed(() =>
  props.pull
    ? t('pulls.mergeDesc', { head: props.pull.headRef, base: props.pull.baseRef })
    : '',
)

async function onMerge() {
  if (!props.pull || submitting.value) {
    return
  }
  submitting.value = true
  serverError.value = ''
  try {
    const result = await mergePull(props.repoPath, props.pull.number, {
      mergeStyle: form.mergeStyle,
      commitTitle: form.commitTitle.trim() || undefined,
      commitMessage: form.commitMessage.trim() || undefined,
    })
    toast.add({
      title: t('pulls.mergeSuccess'),
      description: result.sha ? t('pulls.mergeSuccessSha', { sha: result.sha.slice(0, 7) }) : '',
      color: 'success',
      duration: 4000,
    })
    emit('merged', result.sha)
    emit('update:open', false)
  }
  catch (err) {
    // 失败：留在详情页（弹窗不关），透出服务端 message（不可合并/权限不足等）
    serverError.value = (err as Error)?.message || ''
    toast.add({
      title: t('pulls.mergeFailed'),
      description: serverError.value,
      color: 'error',
      duration: 6000,
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
    :title="t('pulls.mergeTitle')"
    :ui="{ content: 'max-w-lg' }"
  >
    <template #body>
      <div class="flex flex-col gap-4">
        <!-- 明示目标分支（验收点：二次确认弹窗明示目标分支） -->
        <UAlert
          icon="i-lucide-git-merge"
          color="warning"
          variant="soft"
          :title="targetDesc"
        />

        <UFormField :label="t('pulls.mergeStyle')">
          <USelect
            v-model="form.mergeStyle"
            class="w-full"
            :items="styleItems"
            value-key="value"
          />
        </UFormField>

        <UFormField :label="t('pulls.commitTitle')">
          <UInput
            v-model="form.commitTitle"
            class="w-full"
            :placeholder="pull?.title"
          />
        </UFormField>

        <UFormField :label="t('pulls.commitMessage')">
          <UTextarea
            v-model="form.commitMessage"
            class="w-full"
            :rows="3"
            autoresize
          />
        </UFormField>

        <!-- 服务端失败信息（mergeable 冲突 / 权限不足等） -->
        <UAlert
          v-if="serverError"
          icon="i-lucide-octagon-alert"
          color="error"
          variant="soft"
          :title="t('pulls.mergeFailed')"
          :description="serverError"
        />
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
        <!-- 确认按钮用明确动词"确认合并"（PRD 7.2.5） -->
        <UButton
          color="primary"
          :loading="submitting"
          icon="i-lucide-git-merge"
          :label="submitting ? t('pulls.merging') : t('pulls.confirmMerge')"
          @click="onMerge"
        />
      </div>
    </template>
  </UModal>
</template>
