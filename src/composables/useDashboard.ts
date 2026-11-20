import { ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { createSharedComposable } from '@vueuse/core'
import { getCurrentWindow } from '@tauri-apps/api/window'

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
  // 注：meta_ 前缀在 Nuxt UI 里跨平台自适应 —— macOS 触发 ⌘，Windows/Linux
  // 自动改写为 Ctrl（见其 shortcuts 源码 !macOS && metaKey → ctrlKey），
  // 所以这里只写一份 meta_,，三个平台各自拿到 ⌘+, / Ctrl+,（系统设置惯例键位）
  defineShortcuts({
    'g-h': () => router.push('/'),
    'g-s': () => router.push('/settings'),
    'meta_,': () => router.push('/settings'),
    'n': () => isNotificationsSlideoverOpen.value = !isNotificationsSlideoverOpen.value,
    // Ctrl+W（macOS ⌘W）：关闭主窗口。语义与点窗口 X 按钮一致 —— 走
    // getCurrentWindow().close() 触发 Tauri CloseRequested，Rust 侧
    // on_window_event 里 hide + prevent_close（隐藏到托盘、后台常驻），
    // 应用不会退出；真正退出走托盘菜单「退出应用」（app.exit(0)）。
    // 权限依赖 capabilities/default.json 的 core:window:allow-close
    // （core:default 只含窗口只读查询，close 不在其中，缺权限会静默拒绝）。
    'meta_w': () => getCurrentWindow().close(),
  })

  watch(() => route.fullPath, () => {
    isNotificationsSlideoverOpen.value = false
  })

  return {
    isNotificationsSlideoverOpen
  }
}

export const useDashboard = createSharedComposable(_useDashboard)
