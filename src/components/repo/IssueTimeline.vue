<script setup lang="ts">
/**
 * Issue 动态时间线（PRD P0-B5）。
 *
 * activities 的 payload 为 free-form（swagger 未定型，R10）：P0 只做
 * 尽力解析 —— 展示类型 / 发起人 / 时间；payload 内若能取出可读文本
 * （string 或 { content/body/text }）则附带展示，解析失败只显示类型名，
 * 绝不让单条异常拖垮整块时间线。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { IssueActivity } from '../../composables/useCnbRepo'
import { formatDateTime } from '../../utils'

const props = defineProps<{
  activities: IssueActivity[]
}>()

const { t } = useI18n()

/** 动态类型的展示图标（尽力映射常见类型，未知用统一图标） */
function typeIcon(type: string): string {
  const map: Record<string, string> = {
    open: 'i-lucide-circle-dot',
    close: 'i-lucide-circle-check-big',
    reopen: 'i-lucide-circle-dot',
    comment: 'i-lucide-message-square',
    label: 'i-lucide-tag',
    assign: 'i-lucide-user-plus',
    title: 'i-lucide-pencil',
    body: 'i-lucide-pencil',
  }
  return map[type.toLowerCase()] || 'i-lucide-activity'
}

/**
 * 尽力从 payload 提取可读文本。
 * 兼容三种形态：纯字符串 / { content } / { body } / { text }；
 * 其余（对象嵌套、数组等）返回 null（只显示类型名）。
 */
function payloadText(payload: unknown): string | null {
  if (typeof payload === 'string' && payload.trim()) {
    return payload
  }
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>
    for (const key of ['content', 'body', 'text', 'title']) {
      if (typeof obj[key] === 'string' && (obj[key] as string).trim()) {
        return obj[key] as string
      }
    }
  }
  return null
}

/** 时间线条目（预处理：附加图标与尽力解析的文本，异常隔离在单条内） */
const items = computed(() =>
  props.activities.map((a, index) => ({
    key: a.id || `activity-${index}`,
    icon: typeIcon(a.type),
    type: a.type || t('state.empty'),
    actor: a.actorName || '-',
    time: a.createdAt,
    text: payloadText(a.payload),
  })),
)
</script>

<template>
  <section class="flex flex-col gap-3">
    <h3 class="text-sm font-semibold text-highlighted flex items-center gap-2">
      <UIcon name="i-lucide-activity" class="size-4 text-muted" />
      {{ t('issues.timeline') }}
    </h3>

    <p v-if="items.length === 0" class="text-sm text-dimmed">
      {{ t('state.empty') }}
    </p>

    <!-- 时间线：竖线 + 节点；单条解析异常仅显示类型名，不影响整块 -->
    <ol v-else class="relative ms-3 border-s border-default flex flex-col gap-4 ps-5">
      <li v-for="item in items" :key="item.key" class="relative">
        <!-- 节点图标（压在竖线上） -->
        <span class="absolute -start-[27px] top-0.5 size-4 inline-flex items-center justify-center">
          <UIcon :name="item.icon" class="size-4 text-muted bg-default" />
        </span>
        <p class="text-xs text-muted">
          <span class="text-highlighted font-medium">{{ item.actor }}</span>
          <span class="mx-1">·</span>
          <span>{{ item.type }}</span>
          <time v-if="item.time" :datetime="item.time" class="ms-2 text-dimmed">
            {{ formatDateTime(item.time) }}
          </time>
        </p>
        <!-- 尽力解析出的 payload 文本（失败时不渲染，绝不抛错） -->
        <p v-if="item.text" class="mt-1 text-xs text-muted break-words line-clamp-4">
          {{ item.text }}
        </p>
      </li>
    </ol>
  </section>
</template>
