<script setup lang="ts">
import { computed } from 'vue'
import { useHead } from '@unhead/vue'
import { useColorMode } from '@vueuse/core'
// Nuxt UI 内置组件（搜索按钮/命令面板等）的文案不走 vue-i18n，而是读
// UApp 注入的 locale 上下文（默认 en，因此"搜索"框会固定显示英文）。
// 这里按应用语言动态注入对应语言包，让 Nuxt UI 内置文案跟随语言设置。
import { en, zh_cn, zh_tw } from '@nuxt/ui/locale'
import { resolvedLocale } from './composables/useAppLocale'

const colorMode = useColorMode()
const themeColor = computed(() => colorMode.value === 'dark' ? '#18181b' : '#ffffff')

/**
 * Nuxt UI 组件库语言包：跟随应用语言（resolvedLocale）。
 * 键名对应 @nuxt/ui/locale 的导出（下划线命名），映射关系与 vue-i18n
 * 的 locale 代码一一对应；切换语言时 UApp 重新 provide，内置文案热切换。
 */
const uiLocale = computed(() => {
  switch (resolvedLocale.value) {
    case 'zh-CN':
      return zh_cn
    case 'zh-TW':
      return zh_tw
    default:
      return en
  }
})

useHead({
  meta: [
    { name: 'theme-color', content: themeColor }
  ]
})
</script>

<template>
  <Suspense>
    <!--
      :toaster="{ progress: false, position: 'top-center' }"：全局 toast 配置
      - progress: false —— 关闭 toast 的倒计时进度条（Nuxt UI UToast 默认
        在底部渲染一条随自动关闭时间渐隐的 progress，UApp.toaster 原样
        透传给内部 UToaster，false 即条件不渲染）。用户要求所有 toast 都
        不显示 progress —— 成功/失败反馈本身足够，进度条视觉噪音大且与
        下载进度条（更新弹窗 UProgress）语义易混淆。
      - position: 'top-center' —— 所有 toast 顶部居中显示（UToaster 合法
        取值：top-left / top-center / top-right / bottom-left /
        bottom-center / bottom-right），用户要求居中弹出更醒目，
        不与右下角系统通知、左侧栏等元素抢位置。
      :locale="uiLocale" —— Nuxt UI 内置文案语言包（左侧栏搜索按钮的
      "Search..."、命令面板 placeholder 等都读这里的上下文；不传时永远
      英文，表现为"选了简体中文搜索框还是英文"）。跟随 resolvedLocale
      动态切换，与 vue-i18n 的语言设置保持一致。
    -->
    <UApp :toaster="{ progress: false, position: 'top-center' }" :locale="uiLocale">
      <RouterView />
    </UApp>
  </Suspense>
</template>
