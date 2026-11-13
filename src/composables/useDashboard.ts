import { ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { createSharedComposable } from '@vueuse/core'

/**
 * 通知面板开关 ref。
 *
 * # 为什么提到模块顶层而不是 _useDashboard 内部（本次改动）
 *
 * "系统通知点击直达构建详情"需要在 main.ts（无组件上下文）里打开面板：
 * main.ts 不能调用 useDashboard()（内部 useRoute/useRouter 需要组件实例），
 * 但可以把"开关 ref"提升到模块作用域直接 import。ref 是单例、与共享
 * composable 返回的是同一份引用，组件内的 v-model 与 main.ts 的置位
 * 操作天然同步，不产生双份真相。defineShortcuts / route watch 仍留在
 * _useDashboard 里（它们依赖组件上下文，语义不变）。
 */
const isNotificationsSlideoverOpen = ref(false)

// 直接导出原始 ref：供 main.ts 等无组件上下文的入口做"打开面板"操作
export { isNotificationsSlideoverOpen }

const _useDashboard = () => {
  const route = useRoute()
  const router = useRouter()

  // 快捷键（与设置页「快捷键」列表一致，新增/删除需同步 settings/shortcuts.vue）：
  // 注：g-i / g-c（收件箱/客户）已随模板清理移除，不再指向已删除页面
  defineShortcuts({
    'g-h': () => router.push('/'),
    'g-s': () => router.push('/settings'),
    'n': () => isNotificationsSlideoverOpen.value = !isNotificationsSlideoverOpen.value
  })

  watch(() => route.fullPath, () => {
    isNotificationsSlideoverOpen.value = false
  })

  return {
    isNotificationsSlideoverOpen
  }
}

export const useDashboard = createSharedComposable(_useDashboard)
