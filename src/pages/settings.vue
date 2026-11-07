<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { NavigationMenuItem } from '@nuxt/ui'

/**
 * 设置页父级（渲染 <RouterView /> 的容器，6 个子页共用导航）。
 *
 * 路由约定（主理人修正版）：不建 settings/general.vue、不做重定向 ——
 * 「通用」即 /settings 本身（settings/index.vue 原地改造，exact 匹配），
 * 这样 /settings 不会命中父级却无子路由而白屏。
 */
const { t } = useI18n()

// 子项导航（label 随语言切换，computed 包裹）
const links = computed((): NavigationMenuItem[][] => [[{
  label: t('layout.general'),
  icon: 'i-lucide-user',
  to: '/settings',
  exact: true
}, {
  label: t('layout.appearance'),
  icon: 'i-lucide-palette',
  to: '/settings/appearance'
}, {
  label: t('layout.language'),
  icon: 'i-lucide-languages',
  to: '/settings/language'
}, {
  label: t('layout.shortcuts'),
  icon: 'i-lucide-keyboard',
  to: '/settings/shortcuts'
}, {
  label: t('layout.token'),
  icon: 'i-lucide-key-round',
  to: '/settings/token'
}, {
  label: t('layout.about'),
  icon: 'i-lucide-info',
  to: '/settings/about'
}], [{
  label: t('layout.helpSupport'),
  icon: 'i-lucide-book-open',
  // CNB 官方文档站（经 main.ts 全局外链拦截器在系统浏览器打开）。
  // target 同时承担两件事：①标记外链（UNavigationMenu 据此自动在标签后
  // 渲染 ↗ 图标，与侧边栏/用户菜单/命令面板的标识保持一致）；②交给全局
  // 拦截器识别为外部链接。缺了它，标识会消失且链接会落在 Webview 内导航。
  to: 'https://docs.cnb.cool/zh/',
  target: '_blank'
}]])

// 页面标题随语言切换
const title = computed(() => t('layout.settings'))
</script>

<template>
  <UDashboardPanel id="settings" :ui="{ body: 'lg:py-12' }">
    <template #header>
      <UDashboardNavbar :title="title">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
      </UDashboardNavbar>

      <UDashboardToolbar>
        <!-- NOTE: The `-mx-1` class is used to align with the `DashboardSidebarCollapse` button here. -->
        <UNavigationMenu :items="links" highlight class="-mx-1 flex-1" />
      </UDashboardToolbar>
    </template>

    <template #body>
      <div class="flex flex-col gap-4 sm:gap-6 lg:gap-12 w-full lg:max-w-2xl mx-auto">
        <RouterView />
      </div>
    </template>
  </UDashboardPanel>
</template>
