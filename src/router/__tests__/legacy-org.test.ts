/**
 * /org → /group 旧链接重定向的行为单测（对应 PRD §7.3 的 C1 / C3 / C4）。
 *
 * 为什么测「真身」而不是复刻路由表：把生产的路由定义复制进测试，将来改了
 * main.ts 忘改测试就会假绿 —— 比没有测试更糟。因此重定向记录已抽到
 * src/router/legacy-org.ts，本测试 import 同一个常量对象。
 *
 * 不覆盖 C2（未登录 → /login?redirect=/group）：它依赖 main.ts 里读取 cnbToken
 * 的守卫闭包，要测就得把守卫也抽出来，超出本次改造范围。
 * C2 手工判据：清 localStorage 的 cnb-token 后访问 /org，应落 /login?redirect=/group。
 *
 * 断言只用 path / fullPath / hasRoute / getRoutes 这些稳定契约：
 * - 不能用 router.resolve('/org')：它不解析 redirect 记录，仍返回 /org；
 * - 不用 redirectedFrom：该场景实测为 undefined，且属实现细节，易随实现漂移。
 *
 * 环境：createMemoryHistory 不需要 DOM，vitest.config.ts 的 environment: 'node'
 * 即可运行，无需加载 vite 插件。注意 tsconfig.app.json 的 include 覆盖
 * `src/**\/*.ts`，因此本文件同时会被 `pnpm typecheck`（vue-tsc）检查。
 * 上面那个反斜杠是必需的：删掉它，`**` 与紧随的 `/` 会拼成块注释的结束符，
 * 整段注释提前闭合，文件直接 SyntaxError（实测）。看着像多余转义，实则不能动。
 */
import { describe, expect, it } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { defineComponent } from 'vue'
import { LEGACY_ORG_ROUTE_NAME, legacyOrgRedirect } from '../legacy-org'

/**
 * /group 的占位组件。
 *
 * 用 defineComponent 而非裸对象 { template: '<div />' }：前者类型上必然满足
 * RouteRecordRaw 要求的 RouteComponent，后者在 strict 下有类型风险，且依赖
 * 运行时模板编译器。真实的 /group 由 unplugin-vue-router 从 pages/group.vue
 * 生成，单测环境不加载该插件；本测试只验证重定向记录本身，不验证页面渲染，
 * 且从不 mount，故组件不会被实际渲染。
 */
const GroupStub = defineComponent({ render: () => null })

/** 构造只含「/group 占位 + legacy-org 重定向」的最小 router */
function createTestRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/group', component: GroupStub },
      legacyOrgRedirect,
    ],
  })
}

describe('legacy-org 旧链接重定向', () => {
  it('C1/C4：访问 /org 落到 /group（只有 push 才解析 redirect）', async () => {
    const router = createTestRouter()
    await router.push('/org')
    expect(router.currentRoute.value.path).toBe('/group')
  })

  it('C1：地址栏归一为 /group，不残留 /org', async () => {
    const router = createTestRouter()
    await router.push('/org')
    expect(router.currentRoute.value.fullPath).toBe('/group')
  })

  it('C3：登记在路由表，且记录形状被锁死（防加 pathMatch 兜底）', () => {
    const router = createTestRouter()
    // 登记性：能从路由表按 name 查到，且 /org 前缀下只有一条记录
    expect(router.hasRoute(LEGACY_ORG_ROUTE_NAME)).toBe(true)
    expect(router.getRoutes().filter(r => r.path.startsWith('/org'))).toHaveLength(1)
    // 形状锁：必须是**精确**静态段，不是 /org/:pathMatch(.*)* 之类的兜底。
    // 依据：pages/org.vue 是叶子页面、pages/org/ 目录不存在，不存在 /org/xxx
    // 深链接；加兜底会把 /org/* 这类现在正确返回 404 的深链接变成跳组织页
    // （兜底只吃 /org/ 前缀，不影响 /other/path，实测口径见 PRD §4 订正）。
    // 注意这条约定 route-map.d.ts 探不到 —— 它只投影 src/pages/**，看不见手工路由。
    // 局限：本断言只锁住模块导出的这条记录；若有人绕过模块在 main.ts 的 appRoutes
    // 里另加一条 pathMatch，本测试看不见，只能靠 code review。
    expect(legacyOrgRedirect.path).toBe('/org')
    expect(legacyOrgRedirect.redirect).toBe('/group')
    expect(legacyOrgRedirect.name).toBe(LEGACY_ORG_ROUTE_NAME)
    // 第四个字段 children 单列一条直读断言。上面的记录数断言只是"间接推理"，
    // 实测有两种变体它抓不住（`children: []`、绝对子路径 `{path:'/x'}`，两者在
    // getRoutes() 里都仍是 /org 前缀下 1 条）。直读四字段让人不必在脑子里跑
    // getRoutes() 的 children 展开规则。
    // 最危险的变体是空路径子记录 `children:[{path:''}]`：它与父记录同段匹配，
    // 解析时命中子记录、父级 redirect 完全不参与，push('/org') 落在 /org 而非
    // /group —— 旧链接静默失效，用户停在空白页。该变体会让记录数断言变红，但
    // 红了看不出原因，这里直写一条把原因钉在断言旁（实测，非推测）。
    // 注意：给空路径子记录补 name 能让 dev 的 [VUE_ROUTER_R0103] 警告消失，
    // 但 redirect 依然失效（实测 push 返回 undefined、落在 /org）——警告沉默 ≠ 修复。
    expect(legacyOrgRedirect.children).toBeUndefined()
    expect(LEGACY_ORG_ROUTE_NAME).toBe('legacy-org')
  })

  it('无环：直接访问 /group 不会再被重定向出去', async () => {
    const router = createTestRouter()
    await router.push('/group')
    expect(router.currentRoute.value.path).toBe('/group')
  })

  it('HMR 补挂幂等 + 多 router 复用同一记录不串（记录对象不被回写）', async () => {
    // 模拟 main.ts 的 handleHotUpdate 回调重复补挂：同名 addRoute 是"替换"而非叠加
    const routerA = createTestRouter()
    expect(() => routerA.addRoute(legacyOrgRedirect)).not.toThrow()
    expect(routerA.getRoutes().filter(r => r.path === '/org')).toHaveLength(1)

    // 第二个独立 router 复用同一个 const 记录，行为应与第一个完全一致
    const routerB = createTestRouter()
    routerB.addRoute(legacyOrgRedirect)
    await routerB.push('/org')
    expect(routerB.currentRoute.value.path).toBe('/group')

    // 记录对象未被回写：vue-router 的 normalizeRouteRecord 会构造新对象（标量按值
    // 复制），所以两个 router 共享同一 const 是安全的。这条断言防的是将来有人给它
    // 加 meta/children —— 那两者是引用共享，children 数组会被两个 router 共用。
    expect(legacyOrgRedirect.path).toBe('/org')
    expect(legacyOrgRedirect.redirect).toBe('/group')
    expect(legacyOrgRedirect.name).toBe(LEGACY_ORG_ROUTE_NAME)
  })
})
