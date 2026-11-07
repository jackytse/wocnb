/**
 * useRepoRoute 单测：catch-all 参数解码 + query 读写语义（风险区 #3）。
 *
 * vue-router 的 useRoute/useRouter 以假对象 mock，捕获 push/replace 的
 * 调用参数断言 query 编解码行为；不启动真实 router（纯函数原则）。
 * 覆盖：多级子组织路径、ref 含 '/'、非法 number/page、replace/push 语义、
 * state/keyword 变更重置 page、切 ref 清 path/sha。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// 假 route/router：可变状态对象（测试内改写 params/query 后，composable
// 在调用时读取到最新值），push/replace 仅记录调用参数
const routerPush = vi.fn()
const routerReplace = vi.fn()

const routeState = {
  path: '/repos/org/repo',
  params: {} as Record<string, string | string[]>,
  query: {} as Record<string, string>,
}

vi.mock('vue-router', () => ({
  useRoute: () => routeState,
  useRouter: () => ({
    push: (...args: unknown[]) => routerPush(...args),
    replace: (...args: unknown[]) => routerReplace(...args),
  }),
}))

import { parsePositiveInt, useRepoRoute } from '../useRepoRoute'

beforeEach(() => {
  routerPush.mockClear()
  routerReplace.mockClear()
  // 只重置 routeState 的属性（保持对象引用稳定），避免 mock 捕获旧值
  routeState.params = { repoPath: ['org', 'repo'] }
  routeState.query = {}
})

// ---------------------------------------------------------------------------
// parsePositiveInt：正整数校验（number/sn 非法 → 页面"未找到"态）
// ---------------------------------------------------------------------------

describe('parsePositiveInt', () => {
  it('正整数与合法数字串放行', () => {
    expect(parsePositiveInt('7')).toBe(7)
    expect(parsePositiveInt(42)).toBe(42)
    expect(parsePositiveInt('05')).toBe(5)
  })

  it('0 / 负数 / 小数 / 非数字 / 空 → null', () => {
    expect(parsePositiveInt('0')).toBeNull()
    expect(parsePositiveInt('-3')).toBeNull()
    expect(parsePositiveInt('3.5')).toBeNull()
    expect(parsePositiveInt('abc')).toBeNull()
    expect(parsePositiveInt('')).toBeNull()
    expect(parsePositiveInt(null)).toBeNull()
    expect(parsePositiveInt(undefined)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// repoPath / query 读取：catch-all 数组解码 + 非法值清洗
// ---------------------------------------------------------------------------

describe('useRepoRoute 读取侧', () => {
  it('多级子组织数组 join 为完整路径', () => {
    routeState.params ={ repoPath: ['org', 'sub', 'api'] }
    expect(useRepoRoute().repoPath.value).toBe('org/sub/api')
  })

  it('URL 编码段被解码（%20 → 空格）', () => {
    routeState.params ={ repoPath: ['my%20org', 'repo'] }
    expect(useRepoRoute().repoPath.value).toBe('my org/repo')
  })

  it('字符串参数与空参数兜底', () => {
    routeState.params ={ repoPath: 'org/repo' }
    expect(useRepoRoute().repoPath.value).toBe('org/repo')
    routeState.params ={}
    expect(useRepoRoute().repoPath.value).toBe('')
  })

  it('tab 非法值归一为 code（含空/缺省）', () => {
    routeState.query ={ tab: 'bogus' }
    expect(useRepoRoute().tab.value).toBe('code')
    routeState.query ={}
    expect(useRepoRoute().tab.value).toBe('code')
    routeState.query ={ tab: 'pulls' }
    expect(useRepoRoute().tab.value).toBe('pulls')
  })

  it('number 非法（0/负数/非数字）→ null（页面渲染"未找到"不发请求）', () => {
    routeState.query ={ number: '7' }
    expect(useRepoRoute().number.value).toBe(7)
    routeState.query ={ number: 'abc' }
    expect(useRepoRoute().number.value).toBeNull()
    routeState.query ={ number: '0' }
    expect(useRepoRoute().number.value).toBeNull()
  })

  it('page 非法归一为 1；大页码（越界上不封顶）原样透传由接口兜底', () => {
    routeState.query ={ page: '2' }
    expect(useRepoRoute().page.value).toBe(2)
    routeState.query ={ page: 'abc' }
    expect(useRepoRoute().page.value).toBe(1)
    routeState.query ={ page: '999999' }
    expect(useRepoRoute().page.value).toBe(999999)
  })
})

// ---------------------------------------------------------------------------
// 写入侧：navigate 语义（replace/push、保留/清空、重置 page）
// ---------------------------------------------------------------------------

describe('useRepoRoute 写入侧', () => {
  it('switchTab 用 replace，切回 code 时移除 tab 键', () => {
    routeState.query ={ tab: 'issues' }
    const r = useRepoRoute()
    r.switchTab('pulls')
    expect(routerReplace).toHaveBeenCalledTimes(1)
    expect(routerReplace.mock.calls[0][0].query).toEqual({ tab: 'pulls' })
    r.switchTab('code')
    expect(routerReplace.mock.calls[1][0].query).toEqual({})
  })

  it('switchRef 用 replace 且清空 path/sha（ref 含 / 不破坏 query 结构；page 不在清空范围）', () => {
    routeState.query ={ tab: 'code', path: 'src/a.ts', sha: 'abc123', page: '2' }
    useRepoRoute().switchRef('feature/x')
    const call = routerReplace.mock.calls[0][0]
    expect(call.path).toBe('/repos/org/repo')
    // 设计 §3：切 ref 仅清空 path/sha（内容源已变），page 等其余键保留
    expect(call.query).toEqual({ tab: 'code', page: '2', ref: 'feature/x' })
    expect(call.query.ref).toContain('/')
  })

  it('openIssue 用 push 且保留既有筛选态（state/keyword/page）', () => {
    routeState.query ={ tab: 'issues', state: 'open', keyword: 'bug', page: '2' }
    useRepoRoute().openIssue(7)
    expect(routerPush).toHaveBeenCalledTimes(1)
    expect(routerPush.mock.calls[0][0].query).toEqual({
      tab: 'issues',
      state: 'open',
      keyword: 'bug',
      page: '2',
      number: '7',
    })
  })

  it('backToList 用 push 清定位参数（number/sn/sha/path），保留筛选', () => {
    routeState.query ={ tab: 'issues', number: '7', state: 'open' }
    useRepoRoute().backToList()
    expect(routerPush.mock.calls[0][0].query).toEqual({ tab: 'issues', state: 'open' })
  })

  it('setState 用 replace 且重置 page=1（移除 page 键）', () => {
    routeState.query ={ tab: 'issues', state: 'open', page: '3' }
    useRepoRoute().setState('closed')
    expect(routerReplace).toHaveBeenCalledTimes(1)
    expect(routerReplace.mock.calls[0][0].query).toEqual({ tab: 'issues', state: 'closed' })
  })

  it('setKeyword 空串移除键且重置 page；setPage 1 移除键（page=1 即缺省）', () => {
    routeState.query ={ tab: 'issues', keyword: 'x', page: '2' }
    const r = useRepoRoute()
    // setKeyword 语义：replace 且重置 page=1 —— keyword 与 page 同时移除
    r.setKeyword('')
    expect(routerReplace.mock.calls[0][0].query).toEqual({ tab: 'issues' })
    // 假 router 不会真正回写 query，逐步同步模拟导航后的新路由状态
    routeState.query =routerReplace.mock.calls[0][0].query
    r.setPage(1)
    expect(routerReplace.mock.calls[1][0].query).toEqual({ tab: 'issues' })
    routeState.query =routerReplace.mock.calls[1][0].query
    r.setPage(3)
    expect(routerReplace.mock.calls[2][0].query).toEqual({ tab: 'issues', page: '3' })
  })

  it('openPath 用 push 携带 tab=code 与 path（目录下钻）', () => {
    useRepoRoute().openPath('src/components')
    expect(routerPush).toHaveBeenCalledTimes(1)
    expect(routerPush.mock.calls[0][0].query).toEqual({ tab: 'code', path: 'src/components' })
  })

  it('openBuild/openCommit 用 push 携带定位参数', () => {
    const r = useRepoRoute()
    r.openBuild('1024')
    expect(routerPush.mock.calls[0][0].query).toEqual({ tab: 'builds', sn: '1024' })
    r.openCommit('abc123')
    expect(routerPush.mock.calls[1][0].query).toEqual({ tab: 'commits', sha: 'abc123' })
  })
})
