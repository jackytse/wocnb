<script setup lang="ts">
/**
 * 托盘快捷面板（点击系统托盘图标弹出的小窗口）—— 独立页面。
 *
 * # 与原实现的区别
 *
 * 这不是主应用里的一个路由页，而是由 tray-panel.html 单独引导的 Vue 应用
 * （见 ./main.ts）：不加载主应用的路由、布局与启动副作用，窗口里只可能
 * 出现这块面板本身，不会出现"弹窗里显示整个应用"的情况。
 *
 * # 视觉与信息结构（对齐参考设计）
 *
 * ┌ 头部：应用图标 + Recently Opened 标题 + 条目数量徽标
 * ├ 列表：彩色语言方块 + 仓库名 + [可见性徽标] 仓库路径 + 右侧相对时间
 * └ 底部：「Check updates + 结果文案」｜「Settings」「退出」
 *
 * # 交互
 *
 * - 点条目：交给 Rust 的 tray_panel_open_target —— 隐藏面板 → 前置主窗口
 *   → 主窗口路由跳转到对应仓库页（面板自身不做站内导航）；
 * - 点 Check updates：复用主应用的更新检查数据层（同通道口径、同节流），
 *   结果内联在底部状态栏；
 * - Settings：同一个通道打开主窗口的设置页；
 * - 电源按钮：plugin-process exit(0) 真正退出应用；
 * - Esc：隐藏面板（失焦隐藏由 Rust 窗口事件负责，双保险）。
 *
 * # 数据刷新
 *
 * 最近访问记录存 SQLite（useRecentRepos → recent_repos 表，按登录
 * 账号隔离）。面板是常驻窗口，每次弹出都必须重新查询：主刷新信号是
 * Rust 在显示面板后 emit 的 `cnb://tray-panel-shown`，window focus
 * 作为兜底。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { invoke } from '@tauri-apps/api/core'
import { exit } from '@tauri-apps/plugin-process'
import { loadRecentRepos, recentRepos } from '../composables/useRecentRepos'
import { checkForUpdate } from '../composables/useAppUpdate'
import { encodeRepoPathForRoute, formatRelativeTime } from '../utils'
import { resolveRepoBadge } from './languageBadge'

const { t } = useI18n()

/**
 * 可见性徽标的展示配置（小写三值 → 文案键 + 语义色）。
 *
 * 色彩约定：公开绿（可见范围最大）、私有琥珀（受限）、保密紫红（最强受限）；
 * 都走低饱和的彩色前景 + 同色 10% 底，与面板整体的中性灰调不抢戏。
 */
const VIS_META: Record<string, { labelKey: string, fg: string, bg: string }> = {
  public: { labelKey: 'trayPanel.visPublic', fg: '#1a7f37', bg: 'rgba(52,199,89,0.12)' },
  private: { labelKey: 'trayPanel.visPrivate', fg: '#9a6700', bg: 'rgba(255,159,10,0.14)' },
  secret: { labelKey: 'trayPanel.visSecret', fg: '#8250df', bg: 'rgba(191,90,242,0.14)' },
}

/**
 * 检测更新的界面状态机（与数据层 status 解耦）：
 * idle 未检测 → latest 已是最新 / newer 有新版本 / failed 检测失败。
 * 面板不弹 toast，结论只体现在底部状态栏那一行文字上。
 */
type CheckState = 'idle' | 'latest' | 'newer' | 'failed'

const checking = ref(false)
const checkState = ref<CheckState>('idle')
const newerVersion = ref('')

/**
 * 底部「检测更新」右侧的结果文案。
 *
 * 注意 idle 时返回空串：参考设计在未检测状态下只有按钮本身，不占位，
 * 避免首屏出现一句无意义的占位文本。
 */
const statusText = computed(() => {
  switch (checkState.value) {
    case 'latest':
      return t('trayPanel.latest')
    case 'newer':
      return t('trayPanel.newer', { version: newerVersion.value })
    case 'failed':
      return t('trayPanel.failed')
    default:
      return ''
  }
})

/** 条目数量徽标文案（空列表也显示 0，与参考设计一致） */
const repoCount = computed(() => recentRepos.value.length)

/**
 * 列表渲染数据：把「语言徽标」在渲染前算好。
 *
 * 放在 computed 里而不是模板内联调用：一是每行只算一次（模板里会用到
 * label/color/fg 三处，内联调用等于每行算三遍），二是模板更易读。
 */
const rows = computed(() => recentRepos.value.map((item) => {
  const badge = resolveRepoBadge(item.name, item.language, item.languageColor)
  // 可见性徽标：仅三值之一才渲染（旧记录/脏数据 visibility 为空 → 不显示，
  // 绝不把未知可见性默认成"公开"误标）
  const vis = item.visibility ? VIS_META[item.visibility] : undefined
  return {
    ...item,
    badge,
    vis,
    visLabel: vis ? t(vis.labelKey) : '',
    relativeTime: formatRelativeTime(item.time),
  }
}))

/**
 * 点击条目：把「去哪个仓库」交给 Rust 处理。
 *
 * 为什么不在面板里 router.push：面板是独立应用，没有主窗口的路由实例；
 * 即使有也只会把面板自己导航走（用户看到弹窗变成仓库页）。Rust 侧
 * 命令会隐藏面板、前置主窗口并把路由字符串发给主窗口。
 */
async function openRepo(repoPath: string): Promise<void> {
  await openInMainWindow(`/repos/${encodeRepoPathForRoute(repoPath)}`)
}

/** 通用「隐藏面板 + 主窗口跳路由」，失败只记录不打断交互 */
async function openInMainWindow(path: string): Promise<void> {
  try {
    await invoke('tray_panel_open_target', { path })
  }
  catch (err) {
    console.warn('[wocnb] 面板跳转失败:', err)
  }
}

/**
 * 检测更新。
 *
 * 两段式交互（与参考设计一致）：首次点击执行检查，结果留在行内；
 * 若已有新版本，再点一次直接去「设置 · 关于」看下载/安装说明。
 */
async function onCheckUpdate(): Promise<void> {
  if (checkState.value === 'newer') {
    await openInMainWindow('/settings/about')
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
      newerVersion.value = result.latestVersion
      checkState.value = 'newer'
      return
    }
    checkState.value = 'latest'
  }
  finally {
    checking.value = false
  }
}

/** 打开主窗口设置页（底部 Settings 按钮） */
async function onSettings(): Promise<void> {
  await openInMainWindow('/settings')
}

/** 退出应用：与托盘菜单「退出应用」同路径（Rust app.exit(0)） */
async function onQuit(): Promise<void> {
  try {
    await exit(0)
  }
  catch (err) {
    console.warn('[wocnb] 退出应用失败:', err)
  }
}

/** Esc 隐藏面板（失焦隐藏由 Rust 负责；这里只处理键盘意图） */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    void invoke('hide_tray_panel').catch(() => {})
  }
}

/** 每次弹出都重新读盘，保证列表反映主窗口最新访问记录 */
function refresh(): void {
  loadRecentRepos()
  // 检测结论与当前列表属于两次不同的"会话"，弹出时复位避免展示过期状态
  checkState.value = 'idle'
}

onMounted(() => {
  refresh()
  window.addEventListener('focus', refresh)
  window.addEventListener('keydown', onKeydown)
  // Rust 显示面板后显式 emit 刷新信号（比 window focus 更可靠：
  // 面板从"已显示但失焦"再次点开时不一定触发 focus）
  if ('__TAURI_INTERNALS__' in window) {
    import('@tauri-apps/api/event')
      .then(({ listen }) => listen('cnb://tray-panel-shown', refresh))
      .catch((err) => {
        console.warn('[wocnb] 注册面板刷新事件失败:', err)
      })
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('focus', refresh)
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <!-- 根元素圆角裁切：窗口 transparent: true 后，圆角外区域是真正透明、
       直接透出桌面（黑边框与方角一并消失）；overflow-hidden 把头部/
       底部以及条目 hover 背景裁进圆角内。12px 与 macOS 原生浮层观感一致。 -->
  <div class="h-screen w-screen rounded-[12px] flex flex-col bg-default text-default overflow-hidden select-none">
    <!-- 头部：应用图标 + 标题 + 数量徽标（无拖拽区域：位置跟随托盘图标） -->
    <header class="shrink-0 flex items-center gap-2.5 px-4 h-[46px] border-b border-default">
      <img
        src="/app-icon.png"
        alt=""
        class="size-[18px] rounded-full shrink-0"
        draggable="false"
      >
      <h1 class="text-[15px] font-semibold text-highlighted tracking-[-0.01em] truncate">
        {{ t('trayPanel.title') }}
      </h1>
      <span
        class="ml-auto shrink-0 text-[11px] leading-[17px] px-1.5 rounded-md border border-default text-muted tabular-nums"
      >
        {{ repoCount }}
      </span>
    </header>

    <!-- 最近项目列表：整行可点，右侧时间不参与截断。
         滚动条：全局 main.css 的 * 规则把滚动条彻底隐藏，唯一例外是
         本容器（data-tray-scroll）——样式写在 main.css 的未分层规则里，
         原因见该处注释（Tailwind 工具类在 @layer 里，压不过未分层的 * 规则） -->
    <div
      data-tray-scroll
      class="flex-1 overflow-y-auto"
    >
      <button
        v-for="item in rows"
        :key="item.repoPath"
        type="button"
        class="w-full h-[58px] px-4 flex items-center gap-3 text-left transition-colors hover:bg-elevated focus:outline-none focus-visible:bg-elevated"
        @click="openRepo(item.repoPath)"
      >
        <!-- 语言方块：真实主色 + 语言缩写；无语言信息时退化为首字母中性块 -->
        <span
          class="size-8 rounded-[9px] flex items-center justify-center shrink-0 text-[10px] font-bold tracking-tight"
          :class="item.badge.fallback ? 'bg-elevated text-muted' : ''"
          :style="item.badge.fallback ? {} : { backgroundColor: item.badge.color, color: item.badge.fg || '#fff' }"
        >
          {{ item.badge.label }}
        </span>

        <span class="min-w-0 flex-1 leading-tight">
          <span class="block text-[14px] font-medium text-highlighted truncate">{{ item.name }}</span>
          <span class="flex items-center gap-1.5 mt-0.5 min-w-0">
            <!-- 可见性徽标：公开绿 / 私有琥珀 / 保密紫红；旧记录不渲染 -->
            <span
              v-if="item.vis"
              class="shrink-0 text-[10px] leading-[15px] px-1.5 rounded-[5px] font-medium"
              :style="{ color: item.vis.fg, backgroundColor: item.vis.bg }"
            >
              {{ item.visLabel }}
            </span>
            <span class="min-w-0 text-[11.5px] text-muted truncate">{{ item.repoPath }}</span>
          </span>
        </span>

        <span class="shrink-0 text-[11.5px] text-muted whitespace-nowrap">
          {{ item.relativeTime }}
        </span>
      </button>

      <!-- 空态：未登录 / 从未打开过仓库（面板不提供登录入口，登录在主窗口） -->
      <div
        v-if="repoCount === 0"
        class="h-full flex flex-col items-center justify-center gap-2 px-8 text-center"
      >
        <UIcon name="i-lucide-folder-clock" class="size-6 text-dimmed" />
        <p class="text-[12px] text-muted leading-relaxed">
          {{ t('trayPanel.empty') }}
        </p>
      </div>
    </div>

    <!-- 底部状态栏：左（检测更新 + 行内结论） / 右（设置 + 退出） -->
    <footer class="shrink-0 h-11 px-2 flex items-center gap-1 border-t border-default">
      <button
        type="button"
        class="flex items-center gap-1.5 px-2 h-8 rounded-md text-[12.5px] text-default hover:bg-elevated disabled:opacity-60 whitespace-nowrap"
        :disabled="checking"
        @click="onCheckUpdate"
      >
        <UIcon
          :name="checkState === 'newer' ? 'i-lucide-arrow-up-circle' : 'i-lucide-refresh-cw'"
          class="size-[15px] shrink-0"
          :class="checking ? 'animate-spin' : checkState === 'newer' ? 'text-primary' : 'text-muted'"
        />
        <span class="whitespace-nowrap">{{ t('trayPanel.checkUpdate') }}</span>
      </button>

      <span class="min-w-0 text-[11.5px] text-muted truncate">
        {{ checking ? t('trayPanel.checking') : statusText }}
      </span>

      <div class="ml-auto flex items-center gap-1 shrink-0">
        <button
          type="button"
          class="flex items-center gap-1.5 px-2 h-8 rounded-md text-[12.5px] text-default hover:bg-elevated whitespace-nowrap"
          @click="onSettings"
        >
          <UIcon name="i-lucide-sliders-horizontal" class="size-[15px] text-muted shrink-0" />
          <span class="whitespace-nowrap">{{ t('trayPanel.settings') }}</span>
        </button>
        <button
          type="button"
          class="flex items-center justify-center size-8 rounded-md text-default hover:bg-elevated"
          :aria-label="t('trayPanel.quit')"
          :title="t('trayPanel.quit')"
          @click="onQuit"
        >
          <UIcon name="i-lucide-power" class="size-[16px] text-muted" />
        </button>
      </div>
    </footer>
  </div>
</template>
