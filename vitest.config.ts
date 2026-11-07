/**
 * vitest 最小配置（仅覆盖纯函数单测，不加载 vite.config.ts 的重型插件）。
 *
 * 为什么独立配置：根目录 vite.config.ts 挂载了 vueRouter/layouts/@nuxt/ui
 * 等构建期插件，vitest 直接复用会拖慢启动且无必要 —— 本项目单测只测
 * 纯函数（格式化 / 归一化 / query 解析），无组件渲染、无 DOM 依赖，
 * 因此 node 环境即可，路径显式限定在 src 下的 __tests__ 目录。
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
  },
})
