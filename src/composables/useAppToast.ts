/**
 * 统一的 toast 封装 —— 在 Nuxt UI `useToast` 之上按 color 注入默认图标。
 *
 * 背景（2026-11-19 需求）：全应用约 140 处 `toast.add(...)` 调用点此前都
 * 没有传 icon，Nuxt UI 的 Toast 组件只在 `props.icon` 存在时才渲染图标
 * （见 @nuxt/ui/dist/runtime/components/Toast.vue 的 leading 插槽分支），
 * Toaster 也不会按 color 补默认图标 —— 导致通知永远"光秃秃"只有文字，
 * 成功/失败在视觉上无法快速区分。
 *
 * 方案取舍：逐个调用点补 `icon: '...'` 需要 140 处修改且难以保证后续
 * 新增代码不忘写；集中封装只改 39 处 `const toast = useToast()` 的声明行，
 * 且之后所有新调用点自动获得图标，维护成本最低。
 *
 * 使用方式：组件里 `const toast = useAppToast()`，其余 API 与 Nuxt UI
 * 的 `useToast` 完全一致（add/update/remove/clear/toasts 原样透传）。
 *
 * 图标规则：
 * - 显式传了 `icon` 的调用原样保留（尊重调用方的自定义意图）；
 * - 否则按 `color` 取映射表：success=✓、error=✕、warning=⚠、
 *   info/neutral=ℹ，均为 lucide 线性图标（与全站 i-lucide-* 风格一致）；
 * - 未知 color 不注入图标（Toast 无图标兜底渲染，不会报错）。
 */
import { useToast } from '@nuxt/ui/composables'

/**
 * color → 默认图标名映射。
 *
 * 图标名使用 lucide 新版命名（circle-check / circle-x / triangle-alert），
 * 由 @iconify/vue 在运行时按需加载，与项目既有 i-lucide-* 图标同一来源。
 */
const COLOR_ICONS: Record<string, string> = {
  success: 'i-lucide-circle-check',
  error: 'i-lucide-circle-x',
  warning: 'i-lucide-triangle-alert',
  info: 'i-lucide-info',
  neutral: 'i-lucide-info',
}

/** toast.add 的入参类型：直接复用 Nuxt UI 的 add 方法签名首参 */
type ToastAddProps = Parameters<ReturnType<typeof useToast>['add']>[0]

/**
 * 按需注入默认图标的 toast 工厂。
 *
 * 返回值在 Nuxt UI toast 实例之上覆写了 `add`（其余方法展开透传），
 * 调用方的 `toast.add({ title, color: 'success', duration })` 无需任何
 * 改动即可获得图标；`toast.update / remove / clear` 语义不变。
 */
export function useAppToast() {
  const toast = useToast()

  return {
    ...toast,
    /**
     * 弹出通知：补默认图标后转发给 Nuxt UI。
     *
     * @param props 与 Nuxt UI toast.add 完全一致的入参
     */
    add(props: ToastAddProps) {
      toast.add({
        // 先展开原入参，再覆写 icon：显式传过 icon 的调用方意图优先，
        // 未传（undefined）时才按 color 注入默认图标
        ...props,
        icon: props.icon ?? COLOR_ICONS[String(props.color ?? '')],
      })
    },
  }
}
