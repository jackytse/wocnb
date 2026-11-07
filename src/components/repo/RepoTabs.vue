<script setup lang="ts">
/**
 * 仓库详情五页签（代码 / 提交 / Issue / 合并请求 / 流水线）。
 *
 * 页签切换统一经 useRepoRoute.switchTab（replace 语义，不污染历史）。
 * label 用 computed 包裹保证语言热切换生效。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { TabsItem } from '@nuxt/ui'
import { useRepoRoute, type RepoTab } from '../../composables/useRepoRoute'

const { tab, switchTab } = useRepoRoute()
const { t } = useI18n()

/** 五页签定义（value 与 RepoTab 对应；非法值已在 useRepoRoute 归一为 code） */
const items = computed((): TabsItem[] => [
  { label: t('repo.tabs.code'), icon: 'i-lucide-folder-git-2', value: 'code' },
  { label: t('repo.tabs.commits'), icon: 'i-lucide-git-commit-horizontal', value: 'commits' },
  { label: t('repo.tabs.issues'), icon: 'i-lucide-circle-dot', value: 'issues' },
  { label: t('repo.tabs.pulls'), icon: 'i-lucide-git-pull-request', value: 'pulls' },
  { label: t('repo.tabs.builds'), icon: 'i-lucide-workflow', value: 'builds' },
])

/** UTabs 更新事件 → query 写回（受控模式） */
function onChange(value: string | number) {
  switchTab(value as RepoTab)
}
</script>

<template>
  <UTabs
    :model-value="tab"
    :items="items"
    color="neutral"
    class="mb-4"
    @update:model-value="onChange"
  />
</template>
