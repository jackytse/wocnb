/// <reference types="vite/client" />

/** 自定义 Vite 环境变量类型声明（配合 .env.development 使用） */
interface ImportMetaEnv {
  /** [仅 dev] 本地调试预填的 CNB 测试令牌；production 构建中不存在（空串兜底） */
  readonly VITE_CNB_TEST_TOKEN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
