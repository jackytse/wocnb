<script setup lang="ts">
/**
 * 空仓库（未初始化）引导态 —— 代码 / 提交页签共用。
 *
 * 背景（2026-11-20 用户反馈）：空仓库没有默认分支（GET /-/git/head 返回
 * 404 "branch main not found"），仓库页此前对「ref 未就绪」一律渲染
 * loading 骨架 —— 代码页签永远转圈、提交页签报误导性的「资源不存在」。
 *
 * 本组件的职责：把"仓库为空"这一**正常状态**呈现为可操作的引导面板：
 * 说明文案 + 可直接复制的推送命令 + 在浏览器打开的兜底出口
 * （对齐 CNB 网页端「仓库尚未初始化」的提示语义，并补充了具体操作步骤）。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { openUrl } from '@tauri-apps/plugin-opener'
import { repoSiteUrl } from '../../composables/useCnbRepo'

const props = defineProps<{
  /** 仓库完整路径（如 jackytse/docker） */
  repoPath: string
}>()

const { t } = useI18n()

/** 复制成功态：1.5s 后复位，按钮文案短暂切换为「已复制」 */
const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | undefined

/** 仓库 git 远端地址（与网页端 clone 地址一致） */
const gitRemoteUrl = computed(() => `${repoSiteUrl(props.repoPath)}.git`)

/**
 * 推送指引命令（等宽块整体复制）。
 *
 * 口径依据 CNB 仓库地址规则：git remote 为 `https://cnb.cool/{path}.git`；
 * 空仓库默认分支为 main（实测 /-/git/head 报 "branch main not found"）。
 * 一并给出 `git init` 覆盖"从零开始"的用法；已有本地仓库的用户自行跳过。
 */
const commands = computed(() => [
  'git init',
  `git remote add origin ${gitRemoteUrl.value}`,
  'git add .',
  'git commit -m "Initial commit"',
  'git push -u origin main',
].join('\n'))

/** 复制全部命令到剪贴板（失败静默：用户可手动选择文本） */
async function copyCommands(): Promise<void> {
  try {
    await navigator.clipboard.writeText(commands.value)
    copied.value = true
    clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => { copied.value = false }, 1500)
  }
  catch (err) {
    console.warn('[wocnb] 复制推送命令失败:', err)
  }
}

/** 在系统浏览器打开仓库首页（非 Tauri 环境用 window.open 兜底） */
function openInBrowser(): void {
  const url = repoSiteUrl(props.repoPath)
  if ('__TAURI_INTERNALS__' in window) {
    void openUrl(url)
  }
  else {
    window.open(url, '_blank')
  }
}
</script>

<template>
  <div class="flex flex-col items-center py-12 text-center">
    <!-- 图标：与仓库语义一致的 git 分支 -->
    <div class="size-12 rounded-full bg-elevated flex items-center justify-center">
      <UIcon name="i-lucide-git-branch" class="size-6 text-muted" />
    </div>

    <h3 class="mt-3 text-sm font-semibold text-highlighted">
      {{ t('repo.emptyRepo.title') }}
    </h3>
    <p class="mt-1 text-xs text-muted max-w-sm leading-relaxed">
      {{ t('repo.emptyRepo.desc') }}
    </p>

    <!-- 推送指引：标题行（说明 + 复制按钮）+ 等宽命令块 -->
    <div class="mt-5 w-full max-w-xl text-left border border-default rounded-lg overflow-hidden">
      <div class="flex items-center gap-2 px-3 h-9 bg-elevated/50 border-b border-default">
        <UIcon name="i-lucide-terminal" class="size-3.5 text-muted shrink-0" />
        <span class="text-xs text-muted truncate">{{ t('repo.emptyRepo.pushHint') }}</span>
        <UButton
          class="ms-auto shrink-0"
          size="xs"
          color="neutral"
          variant="ghost"
          :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
          @click="copyCommands"
        >
          {{ copied ? t('common.copied') : t('common.copy') }}
        </UButton>
      </div>
      <pre class="px-3 py-2.5 text-xs leading-relaxed text-default overflow-x-auto font-mono">{{ commands }}</pre>
    </div>

    <UButton
      class="mt-5"
      size="sm"
      color="neutral"
      variant="outline"
      icon="i-lucide-external-link"
      @click="openInBrowser"
    >
      {{ t('common.openInBrowser') }}
    </UButton>
  </div>
</template>
