import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueRouter from 'vue-router/vite'
import vueLayouts from 'vite-plugin-vue-layouts'
import ui from '@nuxt/ui/vite'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    vueRouter({
      dts: 'src/route-map.d.ts'
    }),
    vueLayouts(),
    vue(),
    ui({
      ui: {
        colors: {
          primary: 'green',
          neutral: 'zinc'
        }
      }
    })
  ],
  build: {
    rollupOptions: {
      /**
       * 多入口构建：
       * - index.html：主应用 SPA（路由 + 布局 + 全部页面）；
       * - tray-panel.html：托盘快捷面板的独立应用（见 src/tray-panel/），
       *   与主应用互不加载。两入口共用同一套 Tailwind/Nuxt UI 主题。
       */
      input: {
        main: 'index.html',
        'tray-panel': 'tray-panel.html'
      }
    }
  }
})
