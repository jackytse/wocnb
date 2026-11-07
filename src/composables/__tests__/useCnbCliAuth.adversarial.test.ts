/**
 * useCnbCliAuth 对抗性单测（QA 补充，与 useCnbCliAuth.test.ts 互补）。
 *
 * 覆盖（任务 3 指定场景）：
 * 1. 状态机：取消（waiting / preparing 竞态）、超时清理、失败分支、
 *    成功链路、组件卸载（onScopeDispose → cancelCliLogin 杀子进程）；
 * 2. applyCliToken：cnbFetch('/user') 失败时回滚登录态（无半登录态）；
 * 3. refreshCliTokenIfNeeded：临期判定触发、PAT 不触发、失败清登录态。
 *
 * IPC mock：@tauri-apps/api/core 的 invoke 按 command 名路由到 handlers，
 * 每个 handler 可按用例覆写（mockResolvedValueOnce 等）。
 * 全部令牌为假值 cnb_test_*。
 */
import { afterEach, beforeEach, describe, expect, it, vi, beforeAll } from 'vitest'
import { effectScope, ref } from 'vue'

// —— 共享 mock 句柄（vi.hoisted 保证提升后可用） ——
const mocks = vi.hoisted(() => ({
  logout: vi.fn(),
  cnbFetch: vi.fn(),
}))

vi.mock('@vueuse/core', async () => {
  const { ref } = await import('vue')
  return { useStorage: (_key: string, initial: unknown) => ref(initial) }
})

// 注意：mock 路径按测试文件解析，src/i18n 应为 '../../i18n'
vi.mock('../../i18n', () => ({
  i18n: { global: { t: (key: string) => key } },
}))

vi.mock('../useCnbAuth', async () => {
  const { ref } = await import('vue')
  const cnbToken = ref('')
  const cnbUser = ref(null)
  return {
    cnbToken,
    cnbUser,
    cnbAvatarUrl: (u: string) => `https://cnb.cool/users/${u}/avatar/s`,
    cnbFetch: (...args: unknown[]) => mocks.cnbFetch(...args),
    // 与真实 logout 同语义：清空令牌与用户信息
    logout: () => {
      cnbToken.value = ''
      cnbUser.value = null
      mocks.logout()
    },
    // applyCliToken 的 catch 只做回滚不判类型；登录页才用 CnbApiError
    CnbApiError: class extends Error {},
  }
})

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) =>
    (handlers as unknown as Record<string, (a?: Record<string, unknown>) => unknown>)[cmd](args),
}))

// —— IPC 命令路由 mock ——
let nextHandle = 1
const handlers = {
  cnb_cli_detect: vi.fn(async () => ({ found: true, path: '/usr/local/bin/cnb', version: '1.18.3', source: 'system' })),
  cnb_cli_install: vi.fn(async () => ({ path: '/app/bin/cnb', version: '1.18.3' })),
  cnb_cli_login: vi.fn(async () => ({
    handle: nextHandle++,
    verificationUrl: 'https://cnb.cool/oauth2/device/verify?user_code=TESTCODE',
    userCode: 'TESTCODE',
    rawOutput: '',
  })),
  cnb_cli_login_poll: vi.fn(async () => ({ status: 'pending', message: '' })),
  cnb_cli_cancel_login: vi.fn(async () => undefined),
  cnb_cli_read_token: vi.fn(async () => ({
    accessToken: 'cnb_test_new_access_0001',
    refreshToken: 'cnb_test_new_refresh',
    expiresAt: 9_999_999_999,
    platformUrl: 'https://cnb.cool',
    clientId: 'cnb_cli',
    loginHost: 'https://api.cnb.cool',
  })),
  cnb_cli_refresh_token: vi.fn(async () => ({
    accessToken: 'cnb_test_refreshed_access',
    expiresAt: 9_999_999_999,
    refreshed: true,
  })),
}

import * as useCnbAuthModule from '../useCnbAuth'
import {
  applyCliToken,
  cnbAuthMethod,
  cnbTokenExpiresAt,
  detectCli,
  refreshCliTokenIfNeeded,
  useCliDeviceLogin,
  type CliDetectResult,
} from '../useCnbCliAuth'

type StateMachine = ReturnType<typeof useCliDeviceLogin>

/** 启动一次设备授权并进入 waiting 阶段 */
async function beginToWaiting(sm: StateMachine): Promise<void> {
  await sm.begin()
  expect(sm.phase.value).toBe('waiting')
}

// 一次性预热 invokeCli 内部的动态 import('@tauri-apps/api/core')，让 mock 模块
// 进入模块缓存。必须用真实定时器（beforeAll）：fake timers 会卡死 vite-node
// 的动态 import 解析。否则两个并发 begin() 同时触发该动态 import 时，
// vitest 的第二个请求会漏拦截拿到真实模块（window 上无 invoke 直接报错），
// 用例结果不再反映被测代码行为。
beforeAll(async () => {
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
  await detectCli().catch(() => {})
  vi.unstubAllGlobals()
})

beforeEach(() => {
  vi.useFakeTimers()
  // Tauri 环境判定：isTauriEnv 检查 window.__TAURI_INTERNALS__
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
  nextHandle = 1
  for (const h of Object.values(handlers)) {
    h.mockClear()
  }
  // 恢复各 handler 默认实现（用例内可用 mockResolvedValueOnce 临时覆写）
  handlers.cnb_cli_detect.mockImplementation(async () => ({ found: true, path: '/usr/local/bin/cnb', version: '1.18.3', source: 'system' }))
  handlers.cnb_cli_login.mockImplementation(async () => ({
    handle: nextHandle++,
    verificationUrl: 'https://cnb.cool/oauth2/device/verify?user_code=TESTCODE',
    userCode: 'TESTCODE',
    rawOutput: '',
  }))
  handlers.cnb_cli_login_poll.mockImplementation(async () => ({ status: 'pending', message: '' }))
  handlers.cnb_cli_read_token.mockImplementation(async () => ({
    accessToken: 'cnb_test_new_access_0001',
    refreshToken: 'cnb_test_new_refresh',
    expiresAt: 9_999_999_999,
    platformUrl: 'https://cnb.cool',
    clientId: 'cnb_cli',
    loginHost: 'https://api.cnb.cool',
  }))
  handlers.cnb_cli_refresh_token.mockImplementation(async () => ({
    accessToken: 'cnb_test_refreshed_access',
    expiresAt: 9_999_999_999,
    refreshed: true,
  }))
  mocks.cnbFetch.mockReset()
  mocks.cnbFetch.mockResolvedValue({ username: 'tester', nickname: 'Tester', avatar: '', email: '' })
  mocks.logout.mockReset()
  ;(useCnbAuthModule.cnbToken as ReturnType<typeof ref>).value = ''
  ;(useCnbAuthModule.cnbUser as ReturnType<typeof ref>).value = null
  cnbAuthMethod.value = ''
  cnbTokenExpiresAt.value = 0
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// 1. refreshCliTokenIfNeeded
// ---------------------------------------------------------------------------

describe('refreshCliTokenIfNeeded', () => {
  it('OAuth + 临期：调用刷新并更新本地令牌与过期时间', async () => {
    cnbAuthMethod.value = 'oauth'
    ;(useCnbAuthModule.cnbToken as ReturnType<typeof ref>).value = 'cnb_test_old'
    cnbTokenExpiresAt.value = Math.floor(Date.now() / 1000) // 已过期

    const did = await refreshCliTokenIfNeeded()

    expect(did).toBe(true)
    expect(handlers.cnb_cli_refresh_token).toHaveBeenCalledTimes(1)
    expect((useCnbAuthModule.cnbToken as ReturnType<typeof ref>).value).toBe('cnb_test_refreshed_access')
    expect(cnbTokenExpiresAt.value).toBe(9_999_999_999)
    expect(mocks.logout).not.toHaveBeenCalled()
  })

  it('OAuth + 未临期（距过期 > 10min）：不触发刷新', async () => {
    cnbAuthMethod.value = 'oauth'
    ;(useCnbAuthModule.cnbToken as ReturnType<typeof ref>).value = 'cnb_test_fresh'
    cnbTokenExpiresAt.value = Math.floor(Date.now() / 1000) + 3600

    const did = await refreshCliTokenIfNeeded()

    expect(did).toBe(false)
    expect(handlers.cnb_cli_refresh_token).not.toHaveBeenCalled()
  })

  it('PAT 登录方式：即使临期也不刷新（PAT 无 refresh_token）', async () => {
    cnbAuthMethod.value = 'pat'
    ;(useCnbAuthModule.cnbToken as ReturnType<typeof ref>).value = 'cnb_test_pat'
    cnbTokenExpiresAt.value = Math.floor(Date.now() / 1000)

    const did = await refreshCliTokenIfNeeded()

    expect(did).toBe(false)
    expect(handlers.cnb_cli_refresh_token).not.toHaveBeenCalled()
  })

  it('刷新失败：清登录态（logout + method/expiry 归零），引导重新授权', async () => {
    cnbAuthMethod.value = 'oauth'
    ;(useCnbAuthModule.cnbToken as ReturnType<typeof ref>).value = 'cnb_test_dying'
    cnbTokenExpiresAt.value = Math.floor(Date.now() / 1000)
    handlers.cnb_cli_refresh_token.mockRejectedValueOnce(new Error('刷新令牌失败（HTTP 400）'))

    const did = await refreshCliTokenIfNeeded()

    expect(did).toBe(true)
    expect(mocks.logout).toHaveBeenCalledTimes(1)
    expect((useCnbAuthModule.cnbToken as ReturnType<typeof ref>).value).toBe('')
    expect(cnbAuthMethod.value).toBe('')
    expect(cnbTokenExpiresAt.value).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 2. applyCliToken 回滚
// ---------------------------------------------------------------------------

describe('applyCliToken', () => {
  it('校验通过：写入完整登录态（token/user/method/expiry）', async () => {
    const user = await applyCliToken({
      accessToken: 'cnb_test_new_access_0001',
      expiresAt: 9_999_999_999,
      platformUrl: 'https://cnb.cool',
      clientId: 'cnb_cli',
      loginHost: 'https://api.cnb.cool',
    })

    expect(user.username).toBe('tester')
    expect((useCnbAuthModule.cnbToken as ReturnType<typeof ref>).value).toBe('cnb_test_new_access_0001')
    expect((useCnbAuthModule.cnbUser as unknown as { value: { avatar: string } | null }).value?.avatar)
      .toBe('https://cnb.cool/users/tester/avatar/s')
    expect(cnbAuthMethod.value).toBe('oauth')
    expect(cnbTokenExpiresAt.value).toBe(9_999_999_999)
  })

  it('cnbFetch 失败：回滚到旧令牌（无半登录态）并抛出错误', async () => {
    ;(useCnbAuthModule.cnbToken as ReturnType<typeof ref>).value = 'cnb_test_prev'
    mocks.cnbFetch.mockRejectedValueOnce(new Error('network down'))

    await expect(applyCliToken({
      accessToken: 'cnb_test_bad_access',
      expiresAt: 9_999_999_999,
      platformUrl: 'https://cnb.cool',
      clientId: 'cnb_cli',
      loginHost: 'https://api.cnb.cool',
    })).rejects.toThrow('network down')

    expect((useCnbAuthModule.cnbToken as ReturnType<typeof ref>).value).toBe('cnb_test_prev')
    expect(cnbAuthMethod.value).toBe('')
    expect(cnbTokenExpiresAt.value).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 3. 状态机 useCliDeviceLogin
// ---------------------------------------------------------------------------

describe('useCliDeviceLogin：等待中取消与超时', () => {
  it('waiting 阶段取消：cancelCliLogin 收到 handle，状态完全重置，可干净重开', async () => {
    const sm = useCliDeviceLogin({ onSuccess: () => {} })
    await beginToWaiting(sm)
    // handle 由 nextHandle 从 1 递增，首个会话必为 1
    const firstHandle = 1

    await sm.cancel()

    expect(handlers.cnb_cli_cancel_login).toHaveBeenCalledWith({ handle: firstHandle })
    expect(sm.phase.value).toBe('idle')
    expect(sm.userCode.value).toBe('')
    expect(sm.verificationUrl.value).toBe('')

    // 取消后立即重开是干净会话：新 handle、无残留轮询报错
    await beginToWaiting(sm)
    expect(handlers.cnb_cli_login).toHaveBeenCalledTimes(2)
    expect(sm.phase.value).toBe('waiting')
  })

  it('5min 超时：清理会话（cancelCliLogin）并进入 failed，提示超时', async () => {
    const sm = useCliDeviceLogin({ onSuccess: () => {} })
    await beginToWaiting(sm)
    const firstHandle = 1

    // 越过 5min 超时线（含一次 2s 轮询间隔）
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 2000)

    expect(handlers.cnb_cli_cancel_login).toHaveBeenCalledWith({ handle: firstHandle })
    expect(sm.phase.value).toBe('failed')
    expect(sm.errorMessage.value).toBe('login.cliAuthTimeout')
  })

  it('scope 卸载（onScopeDispose）：未完成会话被取消，无残留子进程', async () => {
    const scope = effectScope()
    let sm!: StateMachine
    scope.run(() => {
      sm = useCliDeviceLogin({ onSuccess: () => {} })
    })
    await beginToWaiting(sm)
    const firstHandle = 1

    scope.stop()
    // onScopeDispose → void cleanupSession()：异步，flush 微任务让 cancelCliLogin 落地
    await vi.advanceTimersByTimeAsync(0)

    expect(handlers.cnb_cli_cancel_login).toHaveBeenCalledWith({ handle: firstHandle })
  })

  it('轮询返回 failed：直接进入 failed 并透出 message，handle 清空', async () => {
    handlers.cnb_cli_login_poll.mockResolvedValueOnce({ status: 'failed', message: '用户拒绝了授权' })
    const sm = useCliDeviceLogin({ onSuccess: () => {} })
    await beginToWaiting(sm)

    await vi.advanceTimersByTimeAsync(2000)

    expect(sm.phase.value === 'failed').toBe(true)
    expect(sm.errorMessage.value).toBe('用户拒绝了授权')
    // 失败后不再继续轮询
    const pollsBefore = handlers.cnb_cli_login_poll.mock.calls.length
    await vi.advanceTimersByTimeAsync(6000)
    expect(handlers.cnb_cli_login_poll.mock.calls.length).toBe(pollsBefore)
  })

  it('成功链路：poll success → 读令牌 → 写登录态 → onSuccess，无需 cancel（Rust 侧已移除会话）', async () => {
    handlers.cnb_cli_login_poll.mockResolvedValueOnce({ status: 'success', message: '' })
    const onSuccess = vi.fn()
    const sm = useCliDeviceLogin({ onSuccess })

    await beginToWaiting(sm)
    await vi.advanceTimersByTimeAsync(2000)

    expect(onSuccess).toHaveBeenCalledTimes(1)
    expect((useCnbAuthModule.cnbToken as ReturnType<typeof ref>).value).toBe('cnb_test_new_access_0001')
    expect(cnbAuthMethod.value).toBe('oauth')
    expect(handlers.cnb_cli_cancel_login).not.toHaveBeenCalled()
    expect(sm.phase.value).toBe('idle')
  })
})

describe('useCliDeviceLogin：对抗性场景（QA 新增）', () => {
  // 历史（Round 1）：本组前两例曾为缺陷复现（preparing 取消竞态 D3、成功后
  // 错误退化 5min 超时 D4），工程师以代际号方案 + 成功分支内层 try/catch 修复，
  // 两例转绿后保留为回归用例；另补 D3 spawn 后取消边界、D6 重入守卫回归。
  // 并发 begin 场景在 mock 环境不可靠（vitest 并发动态 import 拦截竞态，3 组
  // 探针验证），保留代码审读结论：D6 守卫只拦 preparing/waiting、放行 failed
  // retry —— 该偏离 QA 原建议（phase !== 'idle'）是有意为之且正确（原建议
  // 会拦掉 failed → retry 的合法路径），判定成立。
  it('【缺陷复现】preparing 阶段取消：不应再 spawn cnb login', async () => {
    let resolveDetect!: (v: CliDetectResult) => void
    handlers.cnb_cli_detect.mockImplementation(() => new Promise<CliDetectResult>((r) => { resolveDetect = r }))

    const sm = useCliDeviceLogin({ onSuccess: () => {} })
    const beginning = sm.begin()
    await vi.advanceTimersByTimeAsync(0)
    expect(sm.phase.value).toBe('preparing')

    // 用户在 CLI 检测/下载期间点击取消
    await sm.cancel()
    expect(sm.phase.value).toBe('idle')

    // 检测返回：取消必须生效，不得继续 spawn cnb login
    resolveDetect({ found: true, path: '/usr/local/bin/cnb', version: '1.18.3', source: 'system' })
    await beginning

    expect(handlers.cnb_cli_login).not.toHaveBeenCalled()
    expect(sm.phase.value).toBe('idle')
  })

  it('【缺陷复现】成功后 applyCliToken 失败：应以真实错误进入 failed，而非退化为 5min 超时', async () => {
    // Rust 侧 poll success 后即移除会话 → 后续 poll 报"会话不存在"（模拟真实行为）
    handlers.cnb_cli_login_poll
      .mockResolvedValueOnce({ status: 'success', message: '' })
      .mockRejectedValue(new Error('登录会话不存在或已结束'))
    // /user 校验失败
    mocks.cnbFetch.mockRejectedValueOnce(new Error('network down'))

    const sm = useCliDeviceLogin({ onSuccess: () => {} })
    await beginToWaiting(sm)
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 4000)

    expect(sm.phase.value).toBe('failed')
    // 正确行为：透出 applyCliToken 的真实错误，而不是笼统的超时文案
    expect(sm.errorMessage.value).not.toBe('login.cliAuthTimeout')
  })

  it('【D3 修复回归】startDeviceLogin 已 spawn 后才取消：必须 cancelCliLogin 杀掉子进程', async () => {
    // Rust 侧 cnb_cli_login 已经 spawn 子进程后才返回 handle；取消发生在
    // 该 await 未决期间 —— begin 的代际校验必须对 start.handle 补刀 kill
    let resolveLogin!: (v: { handle: number, verificationUrl: string, userCode: string, rawOutput: string }) => void
    handlers.cnb_cli_login.mockImplementation(() => new Promise((r) => { resolveLogin = r }))

    const sm = useCliDeviceLogin({ onSuccess: () => {} })
    const beginning = sm.begin()
    await vi.advanceTimersByTimeAsync(0)

    // spawn 已发生（Rust 侧子进程在跑），但 handle 尚未写回状态机
    await sm.cancel()
    expect(sm.phase.value).toBe('idle')

    resolveLogin({ handle: 7, verificationUrl: 'https://cnb.cool/oauth2/device/verify?user_code=LATE', userCode: 'LATE', rawOutput: '' })
    await beginning

    // 代际校验必须用已返回的 handle 补杀子进程，且不得进入 waiting/轮询
    expect(handlers.cnb_cli_cancel_login).toHaveBeenCalledWith({ handle: 7 })
    expect(sm.phase.value).toBe('idle')
    expect(sm.verificationUrl.value).toBe('')
    expect(handlers.cnb_cli_login_poll).not.toHaveBeenCalled()
  })

  it('【D6 修复回归】preparing/waiting 中重复 begin 被忽略，failed 态 retry 合法放行', async () => {
    const sm = useCliDeviceLogin({ onSuccess: () => {} })

    // preparing 中重复 begin：不产生第二次 detect
    let resolveDetect!: (v: CliDetectResult) => void
    handlers.cnb_cli_detect.mockImplementation(() => new Promise<CliDetectResult>((r) => { resolveDetect = r }))
    const beginning = sm.begin()
    await vi.advanceTimersByTimeAsync(0)
    await sm.begin()
    expect(handlers.cnb_cli_detect).toHaveBeenCalledTimes(1)
    resolveDetect({ found: true, path: '/x', version: '1.18.3', source: 'system' })
    await beginning

    // 清理 part 1 会话：其挂起的 2s 轮询定时器否则会在 part 2 消费一次性 mock
    await sm.cancel()

    // failed 态 retry 合法（重开新流程）
    // 注意：恢复 detect 的可决议实现 —— part 1 覆写的工厂每次调用都会
    // 创建新的未决议 Promise，不恢复会让 sm2 的 begin 永远卡在检测
    handlers.cnb_cli_detect.mockResolvedValue({ found: true, path: '/x', version: '1.18.3', source: 'system' })
    handlers.cnb_cli_login_poll.mockResolvedValueOnce({ status: 'failed', message: 'boom' })
    const sm2 = useCliDeviceLogin({ onSuccess: () => {} })
    await beginToWaiting(sm2)
    await vi.advanceTimersByTimeAsync(2000)
    expect(sm2.phase.value).toBe('failed')
    handlers.cnb_cli_login.mockClear()
    handlers.cnb_cli_detect.mockClear()
    await sm2.retry()
    expect(sm2.phase.value).toBe('waiting')
    expect(handlers.cnb_cli_login).toHaveBeenCalledTimes(1)
  })
})
