import type { RouteRecordRaw } from 'vue-router'

/**
 * 旧链接 /org 的兼容重定向记录。单独成模块，供 main.ts（挂载 + HMR 补挂）与
 * legacy-org 单测共同 import —— 测试拿真身而非复刻一份路由表，避免"改了
 * main.ts 忘改测试"的假绿。
 *
 * 用途一句话：术语统一为 Group 后页面文件由 pages/org.vue 改为 pages/group.vue、
 * 正式路由随之为 /group，/org 作为已发布出去的旧链接（书签、文档、外链、Tauri
 * 深链接）必须长期可达，故保留一条**精确匹配**的重定向记录。SPA 内的 redirect
 * 没有 HTTP 状态码，"永久"体现为入口永不删除且不回退，不发送 301。
 *
 * 与登录守卫的顺序（最容易被误判成 bug，故写明）：vue-router 的 redirect 在全局
 * beforeEach **之前**解析（pushWithRedirect → handleRedirectRecord 早于 navigate），
 * 因此守卫永远看不到 to.path === '/org'。未登录访问 /org 时守卫收到的目标已是
 * /group，最终落到 /login?redirect=/group，登录后回到 /group。无环：全表只有
 * /org → /group 这一条边，/group 无出边。
 *
 * 断言方式（同样容易踩）：router.resolve('/org') **不**解析 redirect（它不走
 * pushWithRedirect），仍返回 /org —— 验证旧链接行为必须 push/replace 之后读
 * currentRoute，不能用 resolve。另 redirectedFrom 在该场景实测为 undefined，且
 * 属实现细节、易随实现漂移，不要拿来当断言。
 *
 * 更完整的设计背景（为什么不用 pages/org.vue 跳转页、为什么只做精确匹配而不加
 * `:pathMatch(.*)*` 兜底）见 docs/design/group-terminology-design.md 的 §3.1 / §4.1。
 */

/** 旧链接 /org 的兼容路由名（main.ts 的 HMR 补挂用它做幂等判断） */
export const LEGACY_ORG_ROUTE_NAME = 'legacy-org'

/** 旧链接 /org 永久重定向到 /group（术语统一为 Group 后的兼容入口） */
export const legacyOrgRedirect: RouteRecordRaw = {
  name: LEGACY_ORG_ROUTE_NAME,
  path: '/org',
  redirect: '/group',
}
