<script setup lang="ts">
/**
 * Markdown 渲染容器（README / Issue 正文 / 评论 / PR 描述共用）。
 *
 * 安全约定：内部走 useMarkdown.renderMarkdown（marked + DOMPurify 消毒），
 * 调用方只传原始文本，禁止自行 v-html 接口字段。
 *
 * 图片本地化：渲染后调用 hydrateMarkdownImages 把相对路径图片异步转
 * data URL（经 cnb_fetch_image 通道），失败显示灰块占位。
 */
import { computed, onBeforeUnmount, ref, watch, nextTick } from 'vue'
import { hydrateMarkdownImages, renderMarkdown, type MarkdownContext } from '../../composables/useMarkdown'

const props = defineProps<{
  /** 原始 Markdown 文本 */
  source: string
  /** 图片相对路径解析基准（null 时不做图片本地化） */
  ctx?: MarkdownContext | null
}>()

/** 渲染容器引用（供图片水合查询） */
const container = ref<HTMLElement | null>(null)

/** 消毒后的 HTML（source 或 ctx 变化时重算） */
const html = computed(() => renderMarkdown(props.source || '', props.ctx ?? null))

/** 当前水合的取消函数（防旧渲染的异步回填写入新 DOM） */
let cancelHydrate: (() => void) | null = null

// source/ctx 变化（评论刷新、Issue 切换等）：重渲染后重新水合图片
watch([html, container], async () => {
  cancelHydrate?.()
  cancelHydrate = null
  if (!container.value || !html.value) {
    return
  }
  await nextTick()
  if (!container.value) {
    return
  }
  cancelHydrate = hydrateMarkdownImages(container.value)
}, { immediate: true })

onBeforeUnmount(() => {
  cancelHydrate?.()
})
</script>

<template>
  <!-- prose 类提供排版基线；图片加载失败的灰块样式见全局 CSS 的 .md-img-fallback -->
  <div ref="container" class="markdown-body text-sm leading-6 break-words" v-html="html" />
</template>

<style>
/* Markdown 内容的排版微调（全局样式，v-html 注入内容不受 scoped 约束） */
.markdown-body h1,
.markdown-body h2,
.markdown-body h3,
.markdown-body h4 {
  font-weight: 600;
  margin: 1em 0 0.5em;
  line-height: 1.3;
}
.markdown-body h1 { font-size: 1.4em; }
.markdown-body h2 { font-size: 1.25em; }
.markdown-body h3 { font-size: 1.1em; }
.markdown-body p { margin: 0.5em 0; }
.markdown-body ul,
.markdown-body ol { padding-left: 1.5em; margin: 0.5em 0; list-style: revert; }
.markdown-body blockquote {
  border-left: 3px solid var(--ui-border);
  padding-left: 0.75em;
  margin: 0.5em 0;
  color: var(--ui-text-muted);
}
.markdown-body code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.9em;
  background: var(--ui-bg-elevated);
  border-radius: 4px;
  padding: 0.1em 0.35em;
}
.markdown-body pre {
  background: var(--ui-bg-elevated);
  border: 1px solid var(--ui-border);
  border-radius: 6px;
  padding: 0.75em 1em;
  overflow-x: auto;
  margin: 0.75em 0;
}
.markdown-body pre code {
  background: transparent;
  padding: 0;
}
.markdown-body table {
  border-collapse: collapse;
  margin: 0.75em 0;
  width: 100%;
}
.markdown-body th,
.markdown-body td {
  border: 1px solid var(--ui-border);
  padding: 0.35em 0.6em;
  text-align: left;
}
.markdown-body img {
  max-width: 100%;
  border-radius: 6px;
}
/* 图片本地化失败的灰块占位（hydrateMarkdownImages 写入的降级样式） */
.markdown-body img.md-img-fallback {
  display: inline-block;
  width: 120px;
  height: 80px;
  background: var(--ui-bg-accented);
  border: 1px dashed var(--ui-border-accented);
  border-radius: 6px;
}
.markdown-body a {
  color: var(--ui-primary);
  text-decoration: underline;
}
.markdown-body hr {
  border: none;
  border-top: 1px solid var(--ui-border);
  margin: 1em 0;
}
</style>
