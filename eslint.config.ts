import betterTailwindcss from 'eslint-plugin-better-tailwindcss'
import { getDefaultAttributes } from 'eslint-plugin-better-tailwindcss/api/defaults'
import eslintPluginVue from 'eslint-plugin-vue'
import ts from 'typescript-eslint'

export default ts.config(
  ...ts.configs.recommended,
  ...eslintPluginVue.configs['flat/recommended'],
  {
    files: ['*.vue', '**/*.vue'],
    languageOptions: {
      parserOptions: {
        parser: '@typescript-eslint/parser'
      }
    },
    rules: {
      'vue/multi-word-component-names': 'off',
      'vue/max-attributes-per-line': ['error', { singleline: 3 }],
      'no-undef': 'off'
    }
  },
  betterTailwindcss.configs['correctness-error'],
  {
    settings: {
      'better-tailwindcss': {
        entryPoint: 'src/assets/css/main.css',
        attributes: [
          ...getDefaultAttributes(),
          ['^v-bind:ui$', [{ match: 'objectValues' }]]
        ]
      }
    }
  },
  {
    // v-html 容器的自定义 class（markdown-body / code-surface 等）：
    // 非 Tailwind 工具类，全局样式表中定义，排除 unknown-classes 检查
    files: ['*.vue', '**/*.vue'],
    rules: {
      'better-tailwindcss/no-unknown-classes': ['error', { ignore: ['markdown-body', 'code-surface', 'shiki-plain'] }],
      // v-html 仅用于 DOMPurify/shiki 已消毒/转义的输出（useMarkdown 管线），
      // 关闭模板行内告警，安全边界由 useMarkdown.ts 保证
      'vue/no-v-html': 'off'
    }
  }
)
