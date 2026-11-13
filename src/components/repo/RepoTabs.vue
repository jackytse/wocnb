<script setup lang="ts">
/**
 * 仓库详情八页签（代码 / 提交 / Issue / 合并请求 / 流水线 / Releases / 制品库 / 社区）。
 *
 * 页签切换统一经 useRepoRoute.switchTab（replace 语义 + 清空下钻键，
 * 见 §6 R3 修复）。label 用 computed 包裹保证语言热切换生效。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { TabsItem } from '@nuxt/ui'
import { useRepoRoute, type RepoTab } from '../../composables/useRepoRoute'

const { tab, switchTab } = useRepoRoute()
const { t } = useI18n()

/**
 * 八页签定义（value 与 RepoTab 对应；非法值已在 useRepoRoute 归一为 code）。
 * 后三个为本次增量的新页签：Releases（tag）/ 制品库（package）/ 社区（users-round）。
 */
const items = computed((): TabsItem[] => [
  { label: t('repo.tabs.code'), icon: 'i-lucide-folder-git-2', value: 'code' },
  { label: t('repo.tabs.commits'), icon: 'i-lucide-git-commit-horizontal', value: 'commits' },
  { label: t('repo.tabs.issues'), icon: 'i-lucide-circle-dot', value: 'issues' },
  { label: t('repo.tabs.pulls'), icon: 'i-lucide-git-pull-request', value: 'pulls' },
  { label: t('repo.tabs.builds'), icon: 'i-lucide-workflow', value: 'builds' },
  { label: t('repo.tabs.releases'), icon: 'i-lucide-tag', value: 'releases' },
  { label: t('repo.tabs.packages'), icon: 'i-lucide-package', value: 'packages' },
  { label: t('repo.tabs.community'), icon: 'i-lucide-users-round', value: 'community' },
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
