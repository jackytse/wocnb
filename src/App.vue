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
    -->
    <UApp :toaster="{ progress: false, position: 'top-center' }">
      <RouterView />
    </UApp>
  </Suspense>
</template>
