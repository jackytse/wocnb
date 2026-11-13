<script setup lang="ts">
/**
 * 提交 CI 状态徽标（T10）。
 *
 * 颜色/图标由 useCnbRepo 的 commitStatusMeta 独立映射（与流水线构建状态
 * 分开维护，两套枚举来源不同）；**未知值一律中性色**（不误报错误色）。
 * hover 时通过 UTooltip 展示各 check 明细（context + description + 状态），
 * 有外跳地址（target_url）的 check 提供"在浏览器打开"出口。
 *
 * 无 CI 记录（state 为空串）时整个徽标不渲染 —— 列表行不出现占位空白。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { openUrl } from '@tauri-apps/plugin-opener'
import { commitStatusMeta, type CommitStatusResult } from '../../composables/useCnbRepo'

const props = defineProps<{
  /** 提交 CI 状态（null/loading 中不渲染，避免列表加载时闪烁占位） */
  status: CommitStatusResult | null
}>()

const { t } = useI18n()

/** 整体状态元信息（state 空串 → unknown 兜底；渲染与否由 hasStatus 控制） */
const meta = computed(() => commitStatusMeta(props.status?.state || ''))

/** 是否有可展示的状态（无 CI 记录的提交不渲染徽标） */
const hasStatus = computed(() => !!props.status?.state)

/** 明细 tooltip 文案：context + 状态 + 描述逐条拼接 */
const tooltipText = computed(() => {
  const checks = props.status?.checks ?? []
  if (checks.length === 0) {
    return meta.value.color === 'neutral' && props.status?.state
      ? props.status.state
      : t('repo.commitStatus.noChecks')
  }
  return checks
    .map(check => `${check.context || '?'}：${check.state}${check.description ? ` — ${check.description}` : ''}`)
    .join('\n')
})

/** 是否存在任一可外跳的 check 明细 */
const hasExternalChecks = computed(() =>
  (props.status?.checks ?? []).some(check => !!check.targetUrl),
)

/** 在系统浏览器打开 check 明细（取第一条带 target_url 的） */
function openCheck() {
  const target = (props.status?.checks ?? []).find(check => !!check.targetUrl)
  if (!target) {
    return
  }
  if ('__TAURI_INTERNALS__' in window) {
    void openUrl(target.targetUrl)
  }
  else {
    window.open(target.targetUrl, '_blank')
  }
}
</script>

<template>
  <!-- 无 CI 记录：不渲染（占位空白由外层布局吸收） -->
  <UTooltip
    v-if="hasStatus && status"
    :text="tooltipText"
    class="whitespace-pre-line"
  >
    <UBadge
      :color="meta.color"
      variant="subtle"
      size="sm"
      class="shrink-0 cursor-default"
      :class="{ 'cursor-pointer': hasExternalChecks }"
      @click="hasExternalChecks && openCheck()"
    >
      <UIcon
        :name="meta.icon"
        class="size-3"
        :class="status.state === 'running' ? 'animate-spin' : ''"
      />
      {{ t(meta.i18nKey) }}
    </UBadge>
  </UTooltip>
</template>
