<script setup lang="ts">
/**
 * 通用二次确认弹窗（设计文档 §4.1 / §8.3）。
 *
 * 一个组件、一处实现：所有破坏性/敏感性写操作（归档仓库、删除 Release、
 * 删除制品等）统一复用本组件，禁止各页面内联 UModal 拼确认框。
 *
 * 能力：
 * - title / desc / confirmLabel / confirmColor / loading 基础确认；
 * - typeToConfirm（仿 GitHub 删除仓库）：要求用户输入指定文本后确认按钮
 *   才可用 —— 用于高危删除（删除 Release 时输入 tagName）。比较为
 *   **精确匹配**（trim 后），不匹配时按钮 disabled；
 * - loading 置真时禁用确认按钮，防止重复提交（§8.3 规则 4）。
 *
 * 确认语义：点击确认仅 emit('confirm') 并保持弹窗打开 —— 由调用方在
 * 写操作成功后自行关闭（open=false），失败时保留弹窗让用户重试或取消。
 * 取消按钮与遮罩/ESC 关闭走 v-model:open 双向绑定。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  /** 弹窗开关（v-model:open） */
  open: boolean
  /** 标题（动词式，如"归档仓库"） */
  title: string
  /** 说明文案：必须写清后果与不可逆性（§8.3 规则 3） */
  desc: string
  /** 确认按钮文案（缺省用通用"确认"） */
  confirmLabel?: string
  /** 确认按钮颜色：破坏性操作传 'error'，非破坏性用 'primary'（§8.3 规则 2） */
  confirmColor?: 'error' | 'primary' | 'neutral' | 'success' | 'warning' | 'info'
  /** 写操作进行中：确认按钮转 loading 并禁用（防重复提交） */
  loading?: boolean
  /**
   * 高危确认：需要用户输入与此值精确一致的文本，确认按钮才可用。
   * 通常传资源名（如 Release 的 tagName / 制品名）。缺省不启用输入校验。
   */
  typeToConfirm?: string
  /** 输入框的提示文案（说明要求输入什么，如"输入 v1.0.0 以确认"） */
  typeToConfirmLabel?: string
  /** 取消按钮文案（缺省用通用"取消"） */
  cancelLabel?: string
}>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  /** 用户点击确认（校验通过）。写操作结果由调用方处理（成功后关闭弹窗） */
  (e: 'confirm'): void
}>()

const { t } = useI18n()

/** 用户输入的确认文本（typeToConfirm 启用时展示） */
const typed = defineModel<string>('typed', { default: '' })

const openModel = computed({
  get: () => props.open,
  set: (value: boolean) => emit('update:open', value),
})

/**
 * 确认按钮是否可用：
 * - 启用 typeToConfirm 时，输入（trim 后）必须与目标文本完全一致；
 * - loading 中禁用（防重复提交）。
 */
const confirmDisabled = computed(() => {
  if (props.loading) {
    return true
  }
  if (props.typeToConfirm !== undefined && typed.value.trim() !== props.typeToConfirm) {
    return true
  }
  return false
})

/** 取消/关闭：清空输入文本，避免下次打开残留上次输入 */
function onCancel() {
  typed.value = ''
  emit('update:open', false)
}

/** 确认：仅在可用时向外 emit，不自行关闭（成功与否由调用方决定） */
function onConfirm() {
  if (confirmDisabled.value) {
    return
  }
  emit('confirm')
}
</script>

<template>
  <UModal
    v-model:open="openModel"
    :title="title"
    :ui="{ content: 'max-w-md' }"
    @update:open="(value: boolean) => !value && onCancel()"
  >
    <template #body>
      <div class="flex flex-col gap-3">
        <!-- 说明文案：写清后果与不可逆性（由调用方传入完整句子） -->
        <p class="text-sm text-muted whitespace-pre-line">
          {{ desc }}
        </p>

        <!-- 高危确认：输入指定文本才能确认（仿 GitHub 删除仓库交互） -->
        <UFormField
          v-if="typeToConfirm !== undefined"
          :label="typeToConfirmLabel || ''"
        >
          <UInput
            v-model="typed"
            class="w-full"
            autocomplete="off"
            :placeholder="typeToConfirm"
          />
        </UFormField>
      </div>
    </template>

    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton
          color="neutral"
          variant="ghost"
          :label="cancelLabel || t('common.cancel')"
          @click="onCancel"
        />
        <UButton
          :color="confirmColor || 'primary'"
          :disabled="confirmDisabled"
          :loading="loading"
          :label="confirmLabel || t('common.confirm')"
          @click="onConfirm"
        />
      </div>
    </template>
  </UModal>
</template>
