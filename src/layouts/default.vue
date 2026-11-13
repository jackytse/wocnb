<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import type { NavigationMenuItem, CommandPaletteItem } from '@nuxt/ui'
import { useOverlayUnlockGuard } from '../composables/useOverlayUnlockGuard'

// 侧边栏导航文案随语言切换（computed 依赖 t 的响应式 locale）
const { t } = useI18n()
const router = useRouter()

const open = ref(false)

/**
 * 全局搜索（⌘K）浮层的开关状态。
 *
 * 为什么要显式接管 v-model:open：组件内部的 open 是私有的，布局拿不到它，就
 * 无法在「关闭之后」做收尾 —— 而浮层关闭恰恰是本应用最容易整窗卡死的时刻
 * （详见 useOverlayUnlockGuard 顶部注释：body 的 pointer-events / overflow 锁
 * 与 #app 的 aria-hidden 标记只在卸载时还原，链路一断就残留成「界面还在但
 * 点不动」）。接管之后这里既能挂自愈守卫，也能把键盘焦点还给触发按钮。
 */
const searchOpen = ref(false)

// 挂上自愈守卫：每次关闭后 + 低频巡检，清理可能残留的全局副作用
useOverlayUnlockGuard(searchOpen)

/**
 * 关闭搜索后把焦点还给触发按钮。
 *
 * 这不是可选的无障碍优化，而是 mac 上的必需修补：WKWebView（Safari 内核）
 * **点击 <button> 不会让它获得焦点**，因此 reka-ui 的 DialogContent 在挂载时
 * 拿不到 triggerElement（它靠 document.activeElement 记录触发器），关闭时
 * 无处归还焦点，activeElement 掉到 <body> 上 —— 用户接着按 ⌘K 之外的任何
 * 单键快捷键（如 n 打开通知、g h 跳首页）都要先点一下页面才能生效，体感就是
 * 「界面死了」。这里在关闭后主动兜底归还。
 *
 * 为什么不能只在 nextTick 里做一次：关闭要走 ~200ms 的退场动画，此时浮层
 * 还挂在 DOM 上、焦点还在输入框里 —— 那一刻 activeElement 不是 body，
 * 会被「不打断用户焦点」的判断挡掉，随后浮层卸载时焦点才掉到 body，就再也
 * 没人管了。所以要等浮层真正消失（轮询 role=dialog）再判断。
 */
watch(searchOpen, async (isOpen) => {
  if (isOpen) {
    return
  }
  // 退场动画时长由主题决定（当前 200ms），这里留 800ms 上限，每 50ms 探一次
  for (let waited = 0; waited < 800; waited += 50) {
    await new Promise(resolve => setTimeout(resolve, 50))
    if (document.querySelector('[role="dialog"]')) {
      continue
    }
    const active = document.activeElement
    // 只在焦点确实「丢了」（body / null）时才接管，不打断用户已经移走的焦点
    if (!active || active === document.body) {
      document.getElementById('dashboard-search-trigger')?.focus()
    }
    return
  }
})

// 注意：必须用 computed 包裹——语言切换时 t() 依赖的 locale 变化会触发重算，
// 若写成普通常量数组则导航文案将停留在首屏语言
const links = computed((): NavigationMenuItem[][] => [[{
  label: t('layout.home'),
  icon: 'i-lucide-house',
  to: '/',
  onSelect: () => {
    open.value = false
  }
}, {
  // 探索页（T15）：公共仓库搜索 + 仓库排行榜；导航位次在首页之后（验收 1）
  label: t('layout.explore'),
  icon: 'i-lucide-compass',
  to: '/explore',
  onSelect: () => {
    open.value = false
  }
}, {
  // 组织页：展示 GroupsMenu 当前选中组织的基本信息、统计与本月用量
  label: t('layout.group'),
  icon: 'i-lucide-building-2',
  to: '/group',
  onSelect: () => {
    open.value = false
  }
}, {
  // 仓库页：展示 GroupsMenu 当前选中组织下的仓库（GET /{slug}/-/repos）
  label: t('layout.repos'),
  icon: 'i-lucide-folder-git-2',
  to: '/repos',
  onSelect: () => {
    open.value = false
  }
}, {
  // 组织成员页：成员 / 外部贡献者双页签（GET /{group}/-/members 等）
  label: t('layout.members'),
  icon: 'i-lucide-users',
  to: '/members',
  onSelect: () => {
    open.value = false
  }
}, {
  label: t('layout.settings'),
  to: '/settings',
  icon: 'i-lucide-settings',
  defaultOpen: true,
  type: 'trigger',
  // 设置子项 6 个（「通用」指向 /settings 本身，exact 匹配避免与子页同时高亮）
  children: [{
    label: t('layout.general'),
    to: '/settings',
    exact: true,
    onSelect: () => {
      open.value = false
    }
  }, {
    label: t('layout.appearance'),
    to: '/settings/appearance',
    onSelect: () => {
      open.value = false
    }
  }, {
    label: t('layout.language'),
    to: '/settings/language',
    onSelect: () => {
      open.value = false
    }
  }, {
    label: t('layout.shortcuts'),
    to: '/settings/shortcuts',
    onSelect: () => {
      open.value = false
    }
  }, {
    label: t('layout.token'),
    to: '/settings/token',
    onSelect: () => {
      open.value = false
    }
  }, {
    label: t('layout.about'),
    to: '/settings/about',
    onSelect: () => {
      open.value = false
    }
  }]
}], [{
  // 以下链接均指向 CNB 官方资源，经 main.ts 全局外链拦截器在系统浏览器打开。
  //
  // 外链标识（红线，勿删 target）：UNavigationMenu 只在条目
  // `target === '_blank'` 时于标签后自动渲染 ↗ 图标
  // （appConfig.ui.icons.external）。删掉 target 不仅会让链接改在应用内
  // 导航（Webview 白屏/无返回入口），外链标识也会随之消失。
  label: t('layout.feedback'),
  icon: 'i-lucide-message-circle',
  // CNB 官方使用反馈仓库（Issue 提交使用问题与建议）
  to: 'https://cnb.cool/cnb/feedback',
  target: '_blank'
}, {
  label: t('layout.helpSupport'),
  icon: 'i-lucide-book-open',
  // CNB 官方文档站
  to: 'https://docs.cnb.cool/zh/',
  target: '_blank'
}, {
  label: t('layout.bestPractices'),
  icon: 'i-lucide-lightbulb',
  // CNB 官方完整示例/最佳实践集（构建、部署、AI 等各场景）
  to: 'https://cnb.cool/examples/showcase',
  target: '_blank'
}]])

/**
 * 命令面板（⌘K）里的外链标识后缀。
 *
 * 为什么需要单独处理：侧边栏/下拉菜单用的 UNavigationMenu、UDropdownMenu
 * 内置了外链图标逻辑 —— 条目只要带 `target: '_blank'`，框架就会在标签后
 * 自动渲染 ↗（appConfig.ui.icons.external）。但命令面板（UCommandPalette）
 * 没有这段逻辑，`CommandPaletteItem` 也不支持 trailingIcon，只接受字符串
 * `suffix`，因此这里统一补一个箭头后缀，保证「菜单」这一族的外链标识
 * 表达一致（都在标签右侧、都指向"会跳出应用"）。
 */
const EXTERNAL_SUFFIX = '↗'

/** 判断是否为外链条目：全站统一以 target === '_blank' 作为外链标记 */
function isExternalItem(item: NavigationMenuItem): boolean {
  return item.target === '_blank'
}

const groups = computed(() => [{
  id: 'links',
  label: t('layout.home'),
  // UDashboardSearch 的 groups 要求 CommandPaletteItem[]；导航条目类型
  // NavigationMenuItem 与其结构兼容但字段联合类型更宽，显式收窄以通过类型检查。
  // 这里额外为外链条目补 suffix：侧边栏由框架自动加图标，命令面板没有该能力，
  // 不补的话用户在 ⌘K 里搜到"使用反馈/帮助支持"时无法预知会跳到浏览器。
  items: links.value.flat().map(item => (isExternalItem(item)
    ? { ...item, suffix: EXTERNAL_SUFFIX }
    : item)) as CommandPaletteItem[]
}, {
  id: 'actions',
  label: t('layout.actions'),
  // T15 验收 5 + R14 红线：⌘K 只加「跳转探索页」动作项 —— **远程搜索
  // 不进命令面板**（面板输入是受控弹层，塞异步远程数据会破坏
  // useOverlayUnlockGuard 守护的弹层生命周期，整窗点不动，踩过真坑）。
  // 关键词经 ?q= 带入探索页后由页面内 300ms 防抖搜索承接。
  items: [{
    id: 'goto-explore',
    label: t('layout.explore'),
    icon: 'i-lucide-compass',
    onSelect: () => {
      searchOpen.value = false
      void router.push('/explore')
    }
  }]
}, {
  id: 'code',
  label: 'Code',
  items: [{
    id: 'source',
    label: 'View page source',
    // 本项目源码仓库（CNB）：点击在系统浏览器打开仓库首页。
    // 前置图标用「源码」语义，外链标识仍由统一的 suffix 箭头承担
    // （此前这里用 i-lucide-external-link 当左侧图标，与其它外链条目的
    // 右侧箭头标识不一致，已统一）。
    icon: 'i-lucide-file-code',
    to: 'https://cnb.cool/jackytse/wocnb',
    target: '_blank',
    suffix: EXTERNAL_SUFFIX
  }]
}])
</script>

<template>
  <UDashboardGroup unit="rem" storage="local">
    <UDashboardSidebar
      id="default"
      v-model:open="open"
      collapsible
      resizable
      class="bg-elevated/25"
      :ui="{ footer: 'lg:border-t lg:border-default' }"
    >
      <template #header="{ collapsed }">
        <GroupsMenu :collapsed="collapsed" />
      </template>

      <template #default="{ collapsed }">
        <!-- id 仅供关闭浮层后归还键盘焦点使用（见 script 中的 watch(searchOpen)） -->
        <UDashboardSearchButton
          id="dashboard-search-trigger"
          :collapsed="collapsed"
          class="bg-transparent ring-default"
        />

        <UNavigationMenu
          :collapsed="collapsed"
          :items="links[0]"
          orientation="vertical"
          tooltip
          popover
        />

        <UNavigationMenu
          :collapsed="collapsed"
          :items="links[1]"
          orientation="vertical"
          tooltip
          class="mt-auto"
        />
      </template>

      <template #footer="{ collapsed }">
        <UserMenu :collapsed="collapsed" />
      </template>
    </UDashboardSidebar>

    <UDashboardSearch v-model:open="searchOpen" :groups="groups" />

    <RouterView />

    <NotificationsSlideover />
  </UDashboardGroup>
</template>
