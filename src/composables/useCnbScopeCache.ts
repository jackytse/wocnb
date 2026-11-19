/**
 * 令牌 scope 缺失学习缓存（403 事后学习，全应用唯一事实源）。
 *
 * 独立成模块的原因：useCnbAuth（挂载 403 学习点）与 useCnbCliAuth
 * （scope 正向缓存）互相引用会成环，本模块零依赖，两侧都可安全 import。
 *
 * 学习机制（与「进页探测」相对的零成本方案）：
 * - CNB 的 403 响应体带缺失 scope 明细（如 "Missing required scopes:
 *   account-profile:rw"），cnbRequest 统一解析为 CnbApiError.missingScope；
 * - 本模块把学习到的 missingScope 持久化（localStorage），任何写入口在
 *   渲染判定时即可知道「该令牌确定缺此 scope」→ 事前隐藏按钮（403 红线：
 *   事前隐藏而非事后报错），不再重复撞 403；
 * - 与正向缓存（cnbTokenScopes，来自 token 端点响应）互补：正向缓存
 *   说"有什么权限"，本缓存说"确定没什么权限"，两者合起来构成完整判定。
 *
 * 学习边界（防误学）：
 * - 只记录形如 `xxx:r` / `xxx:rw` 的 scope 词法（正则校验），CNB 其他
 *   403 原因（角色不足、风控）不带此格式，不会混入；
 * - 登录成功/登录态清空时由 useCnbCliAuth 调 clearDeniedScopes() 清空
 *   —— denied 结论绑定"某一次授权的令牌"，换令牌必须重学。
 */
import { useStorage } from '@vueuse/core'
import { computed } from 'vue'

/** 学习到的「确定缺失」scope 列表（localStorage 持久化） */
export const cnbDeniedScopes = useStorage<string[]>('cnb-denied-scopes', [])

/** scope 词法校验：只接受 `域名:权限` 形态（如 repo-issue:rw），防误学 */
const SCOPE_PATTERN = /^[a-z][a-z0-9-]*:(r|rw)$/

/** 学习到的缺失 scope 的响应式 Set（供判定端 computed 使用） */
const deniedSet = computed(() => new Set(cnbDeniedScopes.value))

/**
 * 记录一次「令牌确定缺失 scope」的学习结果（403 解析点调用）。
 * 非法形态（如风控 403 的错误文本误入）直接忽略，绝不污染缓存。
 */
export function recordDeniedScope(scope: string | undefined): void {
  if (!scope || !SCOPE_PATTERN.test(scope)) {
    return
  }
  if (!deniedSet.value.has(scope)) {
    cnbDeniedScopes.value = [...cnbDeniedScopes.value, scope]
  }
}

/** 令牌是否确定缺失指定 scope（学习缓存判定；不知道返回 false） */
export function isScopeDenied(scope: string): boolean {
  return deniedSet.value.has(scope)
}

/** 清空学习缓存（登录成功/登录态重置时调用，换令牌必须重学） */
export function clearDeniedScopes(): void {
  cnbDeniedScopes.value = []
}
