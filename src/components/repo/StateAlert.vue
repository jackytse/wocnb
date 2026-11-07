<script setup lang="ts">
/**
 * 统一状态组件：loading / empty / error / 403 / 404（设计文档 §9.2/§9.3）。
 *
 * 所有数据区块的三态+权限态统一经本组件呈现，页面只传 state 与 error：
 * - loading：按 loadingVariant 输出形状匹配的 USkeleton（列表 5 行 / 详情 3 段 /
 *   diff 2 块），不整页 spinner；
 * - empty：图标 + 主文案 + 可选说明；
 * - error：UAlert error + 重试（retry prop 存在时）；
 * - error.kind=forbidden（403）：warning —— 「令牌缺少 xxx 权限」+「管理令牌」
 *   外跳 cnb.cool/profile/token +「在浏览器打开」（siteUrl prop）；
 *   403 绝不引导登出（红线）；
 * - error.kind=notFound（404）：「资源不存在，或当前令牌无权访问」+ 返回列表；
 * - 401 由全局拦截器处理（登出跳登录），不会到达本组件。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { openUrl } from '@tauri-apps/plugin-opener'
import { CNB_TOKEN_MANAGE_URL, type CnbApiError } from '../../composables/useCnbAuth'

const props = defineProps<{
  /** 当前状态 */
  state: 'loading' | 'empty' | 'error'
  /** 错误对象（state=error 时使用；CnbApiError 的 kind/missingScope 决定 403/404/网络分支） */
  error?: Error | CnbApiError | null
  /** 空态主文案（缺省用通用文案） */
  emptyText?: string
  /** 空态说明（如区分"无数据"与"筛选无结果"） */
  emptyDesc?: string
  /** 骨架屏形状（与内容匹配，防布局跳动） */
  loadingVariant?: 'list' | 'detail' | 'diff' | 'plain'
  /** 网络错误时的重试回调（存在才显示重试按钮） */
  retry?: () => void
  /** 「在浏览器打开」的外跳地址（403/404 态提供兜底出口） */
  siteUrl?: string
}>()

const emit = defineEmits<{
  /** 404 态「返回列表」按钮（页面自行决定回哪） */
  (e: 'back'): void
}>()

const { t } = useI18n()

/** 错误类别分支（403/404 有专属界面，其余按网络错误渲染） */
const errorKind = computed(() => (props.error as CnbApiError | undefined)?.kind ?? 'network')

/** 缺失的权限 scope（403 且 errmsg 可解析时存在） */
const missingScope = computed(() => (props.error as CnbApiError | undefined)?.missingScope)

/** 在系统浏览器打开链接（非 Tauri 环境兜底 window.open） */
function openExternal(url: string) {
  if ('__TAURI_INTERNALS__' in window) {
    void openUrl(url)
  }
  else {
    window.open(url, '_blank')
  }
}
</script>

<template>
  <!-- 加载中：形状匹配的骨架屏 -->
  <div v-if="state === 'loading'" class="flex flex-col gap-2">
    <template v-if="loadingVariant === 'detail'">
      <USkeleton class="h-8 w-2/3 rounded-md" />
      <USkeleton class="h-4 w-1/3 rounded-md" />
      <USkeleton class="h-24 w-full rounded-md" />
    </template>
    <template v-else-if="loadingVariant === 'diff'">
      <USkeleton class="h-32 w-full rounded-md" />
      <USkeleton class="h-20 w-full rounded-md" />
    </template>
    <template v-else-if="loadingVariant === 'plain'">
      <USkeleton class="h-16 w-full rounded-md" />
    </template>
    <template v-else>
      <USkeleton v-for="i in 5" :key="i" class="h-12 w-full rounded-md" />
    </template>
  </div>

  <!-- 空态：图标 + 主文案 + 可选说明 -->
  <div v-else-if="state === 'empty'" class="flex flex-col items-center gap-2 py-10 text-center">
    <UIcon name="i-lucide-inbox" class="size-10 text-dimmed" />
    <p class="text-sm text-muted">
      {{ emptyText || t('state.empty') }}
    </p>
    <p v-if="emptyDesc" class="text-xs text-dimmed">
      {{ emptyDesc }}
    </p>
  </div>

  <!-- 403：权限不足（绝不登出）—— scope 提示 + 管理令牌 + 浏览器打开 -->
  <UAlert
    v-else-if="errorKind === 'forbidden'"
    icon="i-lucide-shield-alert"
    color="warning"
    variant="soft"
    :title="missingScope
      ? t('state.forbiddenScope', { scope: missingScope })
      : t('state.forbidden')"
    :description="t('state.forbiddenDesc')"
  >
    <template #actions>
      <UButton
        size="sm"
        color="warning"
        variant="soft"
        icon="i-lucide-key-round"
        @click="openExternal(CNB_TOKEN_MANAGE_URL)"
      >
        {{ t('state.manageToken') }}
      </UButton>
      <UButton
        v-if="siteUrl"
        size="sm"
        color="neutral"
        variant="ghost"
        icon="i-lucide-external-link"
        @click="openExternal(siteUrl)"
      >
        {{ t('common.openInBrowser') }}
      </UButton>
    </template>
  </UAlert>

  <!-- 404：资源不存在或无权访问私有资源 -->
  <UAlert
    v-else-if="errorKind === 'notFound'"
    icon="i-lucide-file-question"
    color="neutral"
    variant="soft"
    :title="t('state.notFound')"
    :description="t('state.notFoundDesc')"
  >
    <template #actions>
      <UButton
        size="sm"
        color="neutral"
        variant="soft"
        icon="i-lucide-arrow-left"
        @click="emit('back')"
      >
        {{ t('state.backToList') }}
      </UButton>
      <UButton
        v-if="siteUrl"
        size="sm"
        color="neutral"
        variant="ghost"
        icon="i-lucide-external-link"
        @click="openExternal(siteUrl)"
      >
        {{ t('common.openInBrowser') }}
      </UButton>
    </template>
  </UAlert>

  <!-- 网络错误：error + 重试 -->
  <UAlert
    v-else
    icon="i-lucide-cloud-alert"
    color="error"
    variant="soft"
    :title="t('state.error')"
    :description="error?.message || t('state.errorDesc')"
  >
    <template #actions>
      <UButton
        v-if="retry"
        size="sm"
        color="error"
        variant="soft"
        icon="i-lucide-refresh-cw"
        @click="retry()"
      >
        {{ t('common.retry') }}
      </UButton>
    </template>
  </UAlert>
</template>
