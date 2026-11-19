<route lang="yaml">
meta:
  layout: blank
</route>

<script setup lang="ts">
/**
 * 托盘快捷面板（系统托盘图标左键单击弹出的小窗口）。
 *
 * 定位：不打开完整主窗口，只给"最近的项目"速览 —— 点任意项目直达该
 * 仓库；底部状态栏提供检测更新 / 设置 / 退出应用三个快捷动作。
 * 视觉参考 Recent Projects 弹窗（标题 + 数量徽标、双行条目、底部工具条）。
 *
 * 数据来源与刷新：最近访问记录由 useRecentRepos 写 localStorage（仓库
 * 详情页加载成功时记录）。面板是独立 WebView，每次获得焦点（弹出）时
 * 重新读盘刷新，避免展示上次弹出时的旧列表。
 *
 * 窗口为 decorations:false 的无边框小窗（配置见 tauri.conf.json 的
 * tray-panel 条目）；失焦自动隐藏、Esc 隐藏由 Rust 窗口事件 + 本页
 * keydown 处理（hide_tray_panel 命令）。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { invoke } from '@tauri-apps/api/core'
import { exit } from '@tauri-apps/plugin-process'
import { loadRecentRepos, recentRepos } from '../composables/useRecentRepos'
import { useAppUpdate } from '../composables/useAppUpdate'
import { encodeRepoPathForRoute, formatRelativeTime } from '../utils'

// 面板页显式使用空白布局（见文件顶部 <route> 块：文件式路由默认会套
// 带侧边栏的 default 布局，在 360x440 的小窗里会直接撑破）

const { t } = useI18n()
const { checkForUpdate } = useAppUpdate()

/** 是否正在检测更新（按钮图标旋转 + 文本切换） */
const checking = ref(false)
/** 检测结果的内联状态（面板不做 toast，直接在状态栏文本上体现） */
const checkState = ref<'idle' | 'latest' | 'newer' | 'failed'>('idle')
/** 检测到的新版本号（checkState === 'newer' 时展示） */
const newerVersion = ref('')

/** 底部「检测更新」按钮文案：随检测状态内联变化（与参考弹窗一致） */
const checkLabel = computed(() => {
  if (checking.value) {
    return t('trayPanel.checking')
  }
  switch (checkState.value) {
    case 'latest':
      return t('trayPanel.latest')
    case 'newer':
      return t('trayPanel.newer', { version: newerVersion.value })
    case 'failed':
      return t('trayPanel.failed')
    default:
      return t('trayPanel.checkUpdate')
  }
})

/** 列表条目：仓库名首字母充当图标底色上的字符（无 logo 的通用占位） */
function initialOf(name: string): string {
  return (name.trim()[0] || '?').toUpperCase()
}

/** 列表条目左侧色块的内联样式（仓库主语言色；无语言回退主题色块） */
function iconStyle(languageColor?: string): Record<string, string> {
  return languageColor
    ? { backgroundColor: languageColor, color: '#fff' }
    : {}
}

/**
 * 点击项目：隐藏面板 → 前置主窗口 → 主窗口路由到该仓库。
 * 路由拼接复用 encodeRepoPathForRoute（与通知/侧边栏同一编码口径）。
 */
async function openRepo(repoPath: string): Promise<void> {
  try {
    await invoke('tray_panel_open_target', {
      path: `/repos/${encodeRepoPathForRoute(repoPath)}`,
    })
  }
  catch (err) {
    console.warn('[wocnb] 面板跳转仓库失败:', err)
  }
}

/**
 * 检测更新：
 * - 首次点击执行检查，结果内联展示（已是最新 / 可更新 x.y.z / 检查失败）；
 * - 已有新版本时再点一次 = 去「关于」页（那里有完整下载与更新说明）。
 */
async function onCheckUpdate(): Promise<void> {
  if (checkState.value === 'newer') {
    await openTarget('/settings/about')
    return
  }
  if (checking.value) {
    return
  }
  checking.value = true
  checkState.value = 'idle'
  try {
    const result = await checkForUpdate()
    if (result.error) {
      checkState.value = 'failed'
      return
    }
    if (result.available) {
      checkState.value = 'newer'
      newerVersion.value = result.latestVersion
      return
    }
    checkState.value = 'latest'
  }
  finally {
    checking.value = false
  }
}

/** 通用"去主窗口某路由"（设置页等） */
async function openTarget(path: string): Promise<void> {
  try {
    await invoke('tray_panel_open_target', { path })
  }
  catch (err) {
    console.warn('[wocnb] 面板跳转失败:', err)
  }
}

/** 退出应用：走 Rust app.exit(0)（与托盘菜单"退出应用"同路径） */
async function onQuit(): Promise<void> {
  try {
    await exit(0)
  }
  catch (err) {
    console.warn('[wocnb] 退出应用失败:', err)
  }
}

/** Esc 关闭面板（失焦由 Rust 侧 Focused(false) 自动隐藏，双保险） */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    void invoke('hide_tray_panel').catch(() => {})
  }
}

/** 面板重新获得焦点（每次弹出）时刷新最近项目列表 */
function onWindowFocus(): void {
  loadRecentRepos()
  // 焦点回归时把检测结果复位为初始态，避免长期驻留显示过期结论
  checkState.value = 'idle'
}

onMounted(() => {
  loadRecentRepos()
  window.addEventListener('focus', onWindowFocus)
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('focus', onWindowFocus)
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div class="h-screen w-screen flex flex-col bg-default text-default overflow-hidden select-none">
    <!-- 标题栏：标题 + 数量徽标（参考 Recent Projects 弹窗）。
         不做 data-tauri-drag-region：面板位置跟随托盘图标定位，
         允许拖动反而会让它脱离图标（还需额外 window 拖拽权限） -->
    <header
      class="flex items-center justify-between gap-2 px-3.5 py-2.5 border-b border-default shrink-0"
    >
      <h1 class="text-[13px] font-semibold text-highlighted">
        {{ t('trayPanel.title') }}
      </h1>
      <span class="text-[11px] leading-5 text-muted border border-default rounded-md px-1.5">
        {{ recentRepos.length }}
      </span>
    </header>

    <!-- 最近项目列表：双行条目（名称 + 路径），右侧相对时间 -->
    <div class="flex-1 overflow-y-auto py-1">
      <button
        v-for="item in recentRepos"
        :key="item.repoPath"
        type="button"
        class="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-elevated transition-colors"
        @click="openRepo(item.repoPath)"
      >
        <span
          class="size-7 rounded-lg flex items-center justify-center text-xs font-semibold shrink-0"
          :class="item.languageColor ? '' : 'bg-elevated text-muted'"
          :style="iconStyle(item.languageColor)"
        >
          {{ initialOf(item.name) }}
        </span>
        <span class="min-w-0 flex-1">
          <span class="block text-[13px] font-medium text-highlighted truncate">{{ item.name }}</span>
          <span class="block text-[11px] text-muted truncate">{{ item.repoPath }}</span>
        </span>
        <span class="text-[11px] text-muted whitespace-nowrap shrink-0">
          {{ formatRelativeTime(item.time) }}
        </span>
      </button>

      <!-- 空态：还没打开过任何仓库（面板不放登录入口，登录在主窗口完成） -->
      <div
        v-if="recentRepos.length === 0"
        class="h-full flex flex-col items-center justify-center gap-2 px-6 text-center"
      >
        <UIcon name="i-lucide-folder-clock" class="size-6 text-dimmed" />
        <p class="text-xs text-muted">
          {{ t('trayPanel.empty') }}
        </p>
      </div>
    </div>

    <!-- 底部状态栏：左（应用标识 + 检测更新） / 右（设置 + 退出应用） -->
    <footer class="flex items-center justify-between gap-1 px-2 py-1.5 border-t border-default shrink-0">
      <div class="flex items-center gap-1 min-w-0">
        <!-- 应用图标：W 字母标识（与托盘图标同款视觉） -->
        <span
          class="size-6 rounded-md bg-inverted text-inverted flex items-center justify-center text-[11px] font-bold shrink-0"
        >
          W
        </span>
        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          :icon="checkState === 'newer' ? 'i-lucide-arrow-up-circle' : 'i-lucide-refresh-cw'"
          :label="checkLabel"
          :loading="checking"
          :disabled="checking"
          class="min-w-0"
          @click="onCheckUpdate"
        />
      </div>
      <div class="flex items-center gap-0.5 shrink-0">
        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          icon="i-lucide-settings"
          :aria-label="t('trayPanel.settings')"
          :title="t('trayPanel.settings')"
          @click="openTarget('/settings')"
        />
        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          icon="i-lucide-power"
          :aria-label="t('trayPanel.quit')"
          :title="t('trayPanel.quit')"
          @click="onQuit"
        />
      </div>
    </footer>
  </div>
</template>
