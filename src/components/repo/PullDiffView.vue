<script setup lang="ts">
/**
 * unified diff 着色视图（PRD P0-C4）。
 *
 * 渲染规则：
 * - 以 + 开头（且非 +++）→ 新增行（绿底）；- 开头（非 ---）→ 删除行（红底）；
 * - @@ 开头 → hunk 头（灰底等宽）；其余为上下文行；
 * - patch 为空（二进制/大文件）→ 显示"无文本差异"；
 * - 单文件可折叠（默认展开）。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { PullFile } from '../../composables/useCnbRepo'

const props = defineProps<{
  files: PullFile[]
}>()

const { t } = useI18n()

/** 单文件折叠状态（filename → boolean，默认全部展开） */
const collapsed = ref(new Set<string>())

function toggleCollapse(filename: string) {
  const next = new Set(collapsed.value)
  if (next.has(filename)) {
    next.delete(filename)
  }
  else {
    next.add(filename)
  }
  collapsed.value = next
}

/** 文件变更状态的徽标色与文案 */
const statusMeta: Record<PullFile['status'], { color: 'success' | 'warning' | 'error' | 'neutral' | 'info', label: string }> = {
  add: { color: 'success', label: 'A' },
  modify: { color: 'warning', label: 'M' },
  delete: { color: 'error', label: 'D' },
  rename: { color: 'info', label: 'R' },
  copy: { color: 'info', label: 'C' },
}

/** diff 行类型（着色分支） */
type DiffLineType = 'add' | 'del' | 'hunk' | 'ctx'

/** 解析单行为 { type, text }（为什么不做行内高亮：unified diff 无语言语义，着色即可读） */
function parseLine(raw: string): { type: DiffLineType, text: string } {
  if (raw.startsWith('@@')) {
    return { type: 'hunk', text: raw }
  }
  if (raw.startsWith('+')) {
    return { type: 'add', text: raw.slice(1) }
  }
  if (raw.startsWith('-')) {
    return { type: 'del', text: raw.slice(1) }
  }
  return { type: 'ctx', text: raw.startsWith(' ') ? raw.slice(1) : raw }
}

/** 预解析全部文件（files 为一次性数据，无需响应式重算优化） */
const parsedFiles = computed(() =>
  props.files.map(file => ({
    file,
    lines: file.patch ? file.patch.split('\n').map(parseLine) : [],
  })),
)
</script>

<template>
  <div class="flex flex-col gap-3">
    <div
      v-for="{ file, lines } in parsedFiles"
      :key="file.filename"
      class="border border-default rounded-lg overflow-hidden"
    >
      <!-- 文件头：折叠开关 + 状态徽标 + 路径 + 增删行数 -->
      <button
        type="button"
        class="w-full flex items-center gap-2 px-3 py-2 bg-elevated/40 hover:bg-elevated/60 text-left cursor-pointer"
        @click="toggleCollapse(file.filename)"
      >
        <UIcon
          :name="collapsed.has(file.filename) ? 'i-lucide-chevron-right' : 'i-lucide-chevron-down'"
          class="size-4 text-dimmed shrink-0"
        />
        <UBadge
          :color="statusMeta[file.status].color"
          variant="subtle"
          size="sm"
          :label="statusMeta[file.status].label"
          class="font-mono shrink-0"
        />
        <span class="text-sm text-highlighted font-mono truncate">{{ file.filename }}</span>
        <span class="ms-auto text-xs shrink-0 flex items-center gap-2">
          <span class="text-success">{{ t('pulls.additions', { n: file.additions }) }}</span>
          <span class="text-error">{{ t('pulls.deletions', { n: file.deletions }) }}</span>
        </span>
      </button>

      <!-- diff 正文（折叠时不渲染） -->
      <div v-if="!collapsed.has(file.filename)">
        <!-- patch 为空（二进制/大文件）：无文本差异 -->
        <p v-if="lines.length === 0" class="px-3 py-4 text-sm text-dimmed text-center">
          {{ t('pulls.diffEmpty') }}
          <span class="block text-xs mt-1">{{ t('pulls.diffEmptyDesc') }}</span>
        </p>
        <div v-else class="overflow-x-auto">
          <div class="min-w-max font-mono text-xs leading-5">
            <div
              v-for="(line, index) in lines"
              :key="index"
              class="px-3 whitespace-pre"
              :class="{
                'bg-success/10 text-success': line.type === 'add',
                'bg-error/10 text-error': line.type === 'del',
                'bg-elevated/60 text-dimmed': line.type === 'hunk',
                'text-muted': line.type === 'ctx',
              }"
            >
              <!-- 前缀符号保留原 diff 语义（+/−/空格） -->
              {{ line.type === 'add' ? `+${line.text}` : line.type === 'del' ? `-${line.text}` : line.text }}
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
