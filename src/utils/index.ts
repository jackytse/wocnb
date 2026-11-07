/**
 * 通用工具函数（格式化等纯函数，无 Vue 依赖）。
 *
 * 时间格式化约定（设计文档 §9.5）：全应用统一使用本文件的
 * formatDateTime / formatRelativeTime / formatDuration，组件内不再私有实现。
 * ISO 空串返回 ''，由调用方决定是否隐藏对应区块。
 */
import { format, formatDistanceToNow } from 'date-fns'
import { zhCN, zhTW, enUS } from 'date-fns/locale'
import { resolvedLocale } from '../composables/useAppLocale'

/**
 * ISO 时间 -> 'yyyy-MM-dd HH:mm'（列表/详情时间戳的统一展示格式）。
 * 解析失败（非法时间串）时原样返回，不抛错。
 */
export function formatDateTime(iso: string): string {
  if (!iso) {
    return ''
  }
  try {
    return format(new Date(iso), 'yyyy-MM-dd HH:mm')
  }
  catch {
    return iso
  }
}

/**
 * ISO 时间 -> 相对时间（date-fns formatDistanceToNow，i18n locale 随语言切换）。
 * '3 分钟前' / '3 minutes ago' 等；解析失败原样返回。
 */
export function formatRelativeTime(iso: string): string {
  if (!iso) {
    return ''
  }
  try {
    const date = new Date(iso)
    // 无效 Date（NaN）：date-fns 会抛 RangeError，提前拦截原样返回
    if (Number.isNaN(date.getTime())) {
      return iso
    }
    const locale = resolvedLocale.value === 'zh-CN'
      ? zhCN
      : resolvedLocale.value === 'zh-TW' ? zhTW : enUS
    return formatDistanceToNow(date, { addSuffix: true, locale })
  }
  catch {
    return iso
  }
}

/**
 * 毫秒耗时 -> 人类可读（构建/流水线耗时展示）。
 * <1s → '0.8s'；<60s → '12.3s'；≥60s → '3m 25s'；≥1h → '1h 05m'；空值返回 ''。
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return ''
  }
  if (ms < 1000) {
    return `${(ms / 1000).toFixed(1)}s`
  }
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 60) {
    return `${totalSeconds}s`
  }
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m`
  }
  return `${minutes}m ${seconds}s`
}

/**
 * 字节数 -> 人类可读大小（文件列表/降级提示用）。
 * '1.2 KB' / '3.4 MB'；0 返回 '0 B'。
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B'
  }
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex++
  }
  return `${value.toFixed(value >= 100 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}
