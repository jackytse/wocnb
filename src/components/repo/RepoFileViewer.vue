<script setup lang="ts">
/**
 * 文件查看器：行号 + 语法高亮 + 三档降级 + 复制/外跳（PRD P0-A4/A5）。
 *
 * 三档降级（阈值判定已在 useCnbRepo 数据层完成，本组件只读 viewMode）：
 * - no-highlight（>256KB）：加载内容但关闭高亮（纯等宽文本）；
 * - too-large（>1MB）：不加载内容，仅显示大小 + 外跳出口；
 * - lfs：提示 LFS 需外跳下载；binary（解码后含 \0）：不支持预览。
 *
 * 内容来源：contents 接口返回的 contentBase64（无 raw 歧义问题，见 R3）；
 * contentBase64 缺失时兜底走 raw 文本通道（fetchRawFileText）。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { openUrl } from '@tauri-apps/plugin-opener'
import {
  fetchRawFileText,
  repoSiteUrl,
  type ContentEntry,
} from '../../composables/useCnbRepo'
import { highlightCode, resolveLang, escapeHtml } from '../../composables/useHighlight'
import { formatBytes } from '../../utils'

const props = defineProps<{
  repoPath: string
  gitRef: string
  /** 已请求到的文件条目（含 contentBase64 与 viewMode） */
  entry: ContentEntry
}>()

const { t } = useI18n()

// ---------------------------------------------------------------------------
// 内容解码与高亮
// ---------------------------------------------------------------------------

/** 高亮后的 HTML（降级时为转义纯文本容器） */
const renderedHtml = ref('')
/** 解码后的纯文本（复制按钮用） */
const plainText = ref('')
/** 行数 */
const lineCount = computed(() => plainText.value ? plainText.value.split('\n').length : 0)
/** 渲染中（shiki 首次懒加载有延迟） */
const rendering = ref(false)
/** 二进制标记（含 \0 时置位，覆盖数据层默认 viewMode=ok 的情形） */
const isBinary = ref(false)

/** base64 → UTF-8 字节（返回 bytes 供二进制嗅探） */
function decodeBase64Bytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i)
  }
  return bytes
}

/** 渲染流程：解码 → 二进制嗅探 → 高亮/纯文本 */
async function render(entry: ContentEntry) {
  renderedHtml.value = ''
  plainText.value = ''
  isBinary.value = false
  rendering.value = true
  try {
    // 优先 contents 的 base64（无 ref 切分歧义）；缺失时走 raw 兜底
    let bytes: Uint8Array | null = null
    if (entry.contentBase64) {
      bytes = decodeBase64Bytes(entry.contentBase64)
    }
    else {
      try {
        const text = await fetchRawFileText(props.repoPath, props.gitRef, entry.path)
        plainText.value = text
      }
      catch {
        // raw 兜底失败（如 Secret 仓库禁 raw / 分支含 '/'）：留空走降级提示
        plainText.value = ''
      }
    }
    if (bytes) {
      // 二进制嗅探：解码后含 \0 判定为二进制（PRD P0-A4）
      if (bytes.includes(0)) {
        isBinary.value = true
        return
      }
      plainText.value = new TextDecoder('utf-8').decode(bytes)
    }
    if (!plainText.value) {
      return
    }
    const lang = resolveLang(entry.name)
    // no-highlight 档（>256KB）或无法识别语言：跳过 shiki 直接转义渲染
    if (entry.viewMode === 'no-highlight' || !lang) {
      renderedHtml.value = `<pre class="shiki shiki-plain"><code>${escapeHtml(plainText.value)}</code></pre>`
      return
    }
    renderedHtml.value = await highlightCode(plainText.value, lang)
  }
  finally {
    rendering.value = false
  }
}

watch(() => props.entry, value => void render(value), { immediate: true })

// ---------------------------------------------------------------------------
// 复制 / 外跳
// ---------------------------------------------------------------------------

const toast = useToast()
const copied = ref(false)

/** 复制全文（Webview 支持 clipboard API；失败降级提示） */
async function copyContent() {
  if (!plainText.value) {
    return
  }
  try {
    await navigator.clipboard.writeText(plainText.value)
    copied.value = true
    toast.add({ title: t('repo.code.copied'), color: 'success', duration: 1500 })
    setTimeout(() => (copied.value = false), 1500)
  }
  catch {
    toast.add({ title: t('state.error'), color: 'error', duration: 2000 })
  }
}

/** 在系统浏览器打开链接（非 Tauri 环境兜底 window.open） */
function openExternal(url: string) {
  if ('__TAURI_INTERNALS__' in window) {
    void openUrl(url)
  }
  else {
    window.open(url, '_blank')
  }
}

/** 站内 raw 地址（外跳出口；blob 页与 raw 同源，统一用 raw 便于直接看内容） */
const rawUrl = computed(() => repoSiteUrl(props.repoPath, `/-/raw/${props.gitRef}/${props.entry.path}`))

/** 行号列表（v-for 渲染行号列） */
const lineNumbers = computed(() => Array.from({ length: lineCount.value }, (_, i) => i + 1))

// ---------------------------------------------------------------------------
// 降级态文案（集中计算，模板不再嵌套三元）
// ---------------------------------------------------------------------------

/** 降级类型：null 表示正常渲染 */
const degraded = computed<'too-large' | 'lfs' | 'binary' | 'load-failed' | null>(() => {
  if (props.entry.viewMode === 'too-large') {
    return 'too-large'
  }
  if (props.entry.viewMode === 'lfs') {
    return 'lfs'
  }
  if (isBinary.value) {
    return 'binary'
  }
  // contents 无内容且 raw 兜底失败：按"无法加载"降级（外跳兜底仍可用）
  if (!plainText.value) {
    return 'load-failed'
  }
  return null
})

const degradedTitle = computed(() => ({
  'too-large': t('repo.code.tooLargeTitle'),
  'lfs': t('repo.code.lfsTitle', { size: formatBytes(props.entry.lfsSize ?? props.entry.size) }),
  'binary': t('repo.code.binaryTitle'),
  'load-failed': t('repo.code.tooLargeTitle'),
}[degraded.value || 'too-large']))

const degradedDesc = computed(() => ({
  'too-large': t('repo.code.tooLargeDesc'),
  'lfs': t('repo.code.lfsDesc', { size: formatBytes(props.entry.lfsSize ?? props.entry.size) }),
  'binary': t('repo.code.binaryDesc'),
  'load-failed': t('repo.code.binaryDesc'),
}[degraded.value || 'too-large']))
</script>

<template>
  <div>
    <!-- 文件头：路径 + 大小/行数 + 操作 -->
    <div class="flex items-center gap-2 flex-wrap mb-3">
      <UIcon name="i-lucide-file" class="size-4 text-muted shrink-0" />
      <span class="text-sm font-medium text-highlighted truncate">{{ entry.path }}</span>
      <UBadge
        v-if="entry.size"
        color="neutral"
        variant="subtle"
        size="sm"
        :label="formatBytes(entry.size)"
      />
      <UBadge
        v-if="lineCount"
        color="neutral"
        variant="subtle"
        size="sm"
        :label="t('repo.code.lines', { count: lineCount })"
      />
      <div class="ms-auto flex items-center gap-1.5">
        <UButton
          v-if="plainText"
          size="xs"
          color="neutral"
          variant="ghost"
          :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
          :label="t('common.copy')"
          @click="copyContent"
        />
        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          icon="i-lucide-external-link"
          :label="t('repo.code.openRaw')"
          @click="openExternal(rawUrl)"
        />
      </div>
    </div>

    <!-- 渲染中（shiki 懒加载）骨架 -->
    <div v-if="rendering" class="flex flex-col gap-2 border border-default rounded-lg p-4">
      <USkeleton
        v-for="i in 6"
        :key="i"
        class="h-4 rounded-md"
        :class="i % 2 ? 'w-4/5' : 'w-3/5'"
      />
    </div>

    <!-- 降级态：too-large / lfs / binary / 内容加载失败 -->
    <UAlert
      v-else-if="degraded"
      :icon="degraded === 'lfs' ? 'i-lucide-package' : 'i-lucide-file-x'"
      :color="degraded === 'too-large' || degraded === 'lfs' ? 'warning' : 'neutral'"
      variant="soft"
      :title="degradedTitle"
      :description="degradedDesc"
      class="max-w-xl"
    >
      <template #actions>
        <!-- LFS 优先给下载地址；其余给 raw 出口 -->
        <UButton
          size="sm"
          color="neutral"
          variant="soft"
          icon="i-lucide-external-link"
          :label="degraded === 'lfs' && entry.lfsDownloadUrl
            ? t('common.openInBrowser')
            : t('repo.code.openRaw')"
          @click="openExternal(entry.lfsDownloadUrl || rawUrl)"
        />
      </template>
    </UAlert>

    <!-- 正常渲染：no-highlight 提示条 + 代码区 -->
    <template v-else>
      <UAlert
        v-if="entry.viewMode === 'no-highlight'"
        icon="i-lucide-file-warning"
        color="neutral"
        variant="soft"
        :title="t('repo.code.noHighlightHint')"
        class="mb-3"
      />
      <!-- shiki 输出：<pre class="shiki">。行号列与代码并列等宽渲染 -->
      <div class="border border-default rounded-lg overflow-hidden bg-default">
        <div class="flex overflow-x-auto">
          <div
            v-if="lineNumbers.length"
            class="select-none text-right px-3 py-3 text-xs font-mono text-dimmed border-e border-default shrink-0"
            aria-hidden="true"
          >
            <div v-for="n in lineNumbers" :key="n" class="leading-5">
              {{ n }}
            </div>
          </div>
          <!-- v-html 内容为 DOMPurify 之外的 shiki 输出（shiki 已对内容转义） -->
          <div class="code-surface flex-1 min-w-0 text-sm" v-html="renderedHtml" />
        </div>
      </div>
    </template>
  </div>
</template>

<style>
/* shiki 双主题颜色（defaultColor=false 输出 CSS 变量，明暗切换由 .dark 接管）。
   全局样式：v-html 注入内容不受 scoped 约束 */
.shiki,
.shiki span {
  color: var(--shiki-light);
}
.dark .shiki,
.dark .shiki span {
  color: var(--shiki-dark);
}
.code-surface pre {
  margin: 0;
  padding: 0.75rem 1rem;
  overflow-x: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.8125rem;
  line-height: 1.25rem;
  background: transparent;
}
.code-surface pre code {
  display: block;
  min-width: max-content;
  white-space: pre;
}
</style>
