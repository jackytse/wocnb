/**
 * cnbFetch 的 401 / 403 分流单测（QA 补充）。
 *
 * 构建通知功能有一条硬红线：**403（缺 repo-cnb-history:r 权限）绝不登出，
 * 401 才登出**。403 的处理在轮询层（useCnbBuildWatch.markScopeMissing），
 * 而"是否登出"的判定在通道层 cnbFetch —— 本文件把通道层这一半钉住，
 * 两层合起来才构成可验证的结论。
 *
 * 环境：node（无 window/localStorage）→ useStorage 退化为普通 ref，
 * 正好把"持久化"从断言里摘掉；httpFetch 走原生 fetch，用替身注入响应。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cnbFetch, CnbApiError, cnbToken, setUnauthorizedHandler } from '../useCnbAuth'

/** 构造一个假的 fetch 响应 */
function responseOf(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

let unauthorizedCalls: string[] = []

beforeEach(() => {
  // handleUnauthorized() 内部要读 window.location 拼回跳地址
  ;(globalThis as unknown as { window: unknown }).window = {
    location: { pathname: '/repos/org/repo', search: '?tab=builds&sn=42' },
  }
  unauthorizedCalls = []
  setUnauthorizedHandler(from => unauthorizedCalls.push(from))
  cnbToken.value = 'test-token'
})

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window
  delete (globalThis as unknown as { fetch?: unknown }).fetch
})

describe('cnbFetch：403 不登出', () => {
  it('403 → CnbApiError(kind=forbidden)、令牌保留、不触发 401 跳转', async () => {
    ;(globalThis as unknown as { fetch: unknown }).fetch = vi.fn(async () =>
      responseOf(403, { errcode: 403, errmsg: 'Missing required scopes: repo-cnb-history:r' }))

    await expect(cnbFetch('/org/repo/-/build/logs')).rejects.toBeInstanceOf(CnbApiError)
    await expect(cnbFetch('/org/repo/-/build/logs')).rejects.toMatchObject({
      kind: 'forbidden',
      status: 403,
      // 缺的 scope 要透出，设置页据此提示"去管理令牌"
      missingScope: 'repo-cnb-history:r',
    })

    expect(cnbToken.value).toBe('test-token')
    expect(unauthorizedCalls).toEqual([])
  })
})

describe('cnbFetch：401 才登出', () => {
  it('401 → 清空令牌 + 触发跳转回调（携带当前路径）', async () => {
    ;(globalThis as unknown as { fetch: unknown }).fetch = vi.fn(async () =>
      responseOf(401, { errcode: 401, errmsg: 'unauthorized' }))

    await expect(cnbFetch('/user')).rejects.toMatchObject({ kind: 'unauthorized', status: 401 })

    expect(cnbToken.value).toBe('')
    expect(unauthorizedCalls).toEqual(['/repos/org/repo?tab=builds&sn=42'])
  })

  it('网络层异常 → kind=network，不登出（断网不应把用户踢下线）', async () => {
    ;(globalThis as unknown as { fetch: unknown }).fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })

    await expect(cnbFetch('/user')).rejects.toMatchObject({ kind: 'network' })

    expect(cnbToken.value).toBe('test-token')
    expect(unauthorizedCalls).toEqual([])
  })
})

describe('cnbFetch：空 body 兜底（2026-11-20 系统性加固）', () => {
  it('2xx + 空响应体 → 返回 undefined，不抛 JSON 解析错（POST /user 场景）', async () => {
    ;(globalThis as unknown as { fetch: unknown }).fetch = vi.fn(async () =>
      new Response('', { status: 200 }))

    // 旧行为：WKWebView 下 JSON.parse('') 抛 "The string did not match the
    // expected pattern."，把空 body 写端点的成功误报成失败
    const result = await cnbFetch<unknown>('/user', { method: 'POST', body: '{}' })
    expect(result).toBeUndefined()
  })

  it('2xx + 空白字符响应体 → 同样返回 undefined（部分网关会带换行）', async () => {
    ;(globalThis as unknown as { fetch: unknown }).fetch = vi.fn(async () =>
      new Response('  \n', { status: 201 }))

    const result = await cnbFetch<unknown>('/x/y', { method: 'POST' })
    expect(result).toBeUndefined()
  })

  it('2xx + 非空 body → 正常 JSON 解析（读端点不受兜底影响）', async () => {
    ;(globalThis as unknown as { fetch: unknown }).fetch = vi.fn(async () =>
      responseOf(200, { username: 'someone', nickname: '张三' }))

    const result = await cnbFetch<{ username: string, nickname: string }>('/user')
    expect(result.username).toBe('someone')
    expect(result.nickname).toBe('张三')
  })
})
