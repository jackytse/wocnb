<script setup lang="ts">
import { computed } from 'vue'
import { useHead } from '@unhead/vue'
import { useColorMode } from '@vueuse/core'

const colorMode = useColorMode()
const themeColor = computed(() => colorMode.value === 'dark' ? '#18181b' : '#ffffff')

useHead({
  meta: [
    { name: 'theme-color', content: themeColor }
  ]
})
</script>

<template>
  <Suspense>
    <!--
      :toaster="{ progress: false }"：全局关闭 toast 的倒计时进度条
      （Nuxt UI UToast 默认在底部渲染一条随自动关闭时间渐隐的 progress，
      UApp.toaster 原样透传给内部 UToaster，false 即条件不渲染）。
      用户要求所有 toast 都不显示 progress —— 成功/失败反馈本身足够，
      进度条视觉噪音大且与下载进度条（更新弹窗 UProgress）语义易混淆。
    -->
    <UApp :toaster="{ progress: false }">
      <RouterView />
    </UApp>
  </Suspense>
</template>
