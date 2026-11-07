<template>
  <!-- 空白布局：无侧边栏/导航，用于登录页等需要全屏独占的页面。
       注意：vite-plugin-vue-layouts 把页面组件作为子路由注入，
       布局中必须用 <RouterView /> 渲染（用 <slot /> 会导致页面空白） -->
  <main class="min-h-screen flex items-center justify-center bg-default">
    <RouterView />
  </main>
</template>
