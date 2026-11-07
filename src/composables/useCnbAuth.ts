/**
 * CNB 认证与 API 访问的组合式函数。
 *
 * 设计说明：
 * - 令牌存储于 localStorage（桌面应用单用户场景，后续可升级为系统钥匙串安全存储）
 * - 使用 @vueuse/core 的 useStorage 包装，令牌/用户信息变更时所有引用处自动响应
 * - PAT 校验依据 CNB Open API：GET /user（Bearer 认证），200 即有效，
 *   同时返回的用户详情（username/nickname/avatar 等）可用于界面展示
 * - 接口地址与认证方式均来自 CNB 官方文档：
 *   https://docs.cnb.cool/zh/develops/openapi.html
 */
import { ref } from 'vue'
import { useStorage } from '@vueuse/core'
// 错误文案的 i18n 翻译：composable 层不依赖组件上下文，直接使用全局 Composer
// （legacy:false 模式下 i18n.global 即 reactive 翻译函数，语言切换后新抛出的
// 错误自动使用新语言；已展示在界面上的错误信息由组件层重新触发时更新）
import { i18n } from '../i18n'

/**
 * cnb-user 的自定义存储序列化器（防御性）。
 *
 * 背景（踩坑记录）：useStorage<CnbUser | null>('cnb-user', null) 的默认值为
 * null，vueuse 据此猜测序列化器为 'any' —— 其 write 是 String(v)，把对象
 * 直接存成了字面量 "[object Object]"，重启后读回的是垃圾字符串。
 * 此处显式指定 JSON 序列化，并做三重防御：
 * 1. 兼容清理旧版本落盘的 "[object Object]" 等非法 JSON（返回 null）；
 * 2. 校验解析结果必须是含 username 的对象，否则视为未登录信息；
 * 3. 序列化 null 时写入 "null"（JSON.parse("null") === null，往返一致）。
 */
const cnbUserSerializer = {
  read: (raw: string | null): CnbUser | null => {
    try {
      if (raw == null) {
        return null
      }
      const parsed = JSON.parse(raw) as Partial<CnbUser> | null
      return parsed && typeof parsed === 'object' && parsed.username
        ? (parsed as CnbUser)
        : null
    }
    catch {
      // 旧数据非法（如 "[object Object]"）：按"无用户信息"处理，
      // 由 restoreSession() 重新拉取补全
      return null
    }
  },
  write: (value: CnbUser | null): string => JSON.stringify(value),
}

/**
 * 按运行环境选择请求通道。
 *
 * 背景（两次踩坑的结论）：
 * 1. CNB API 不返回 CORS 响应头，在 Tauri 的 Webview（origin 为
 *    tauri://localhost）中用原生 fetch 会被浏览器内核直接拦截；
 * 2. tauri-plugin-http 底层 rustls 的 TLS 指纹被 CNB 网关风控拦截，
 *    认证请求一律 403 "Forbidden"（诊断实验：同进程 native-tls reqwest 全 200）。
 *
 * 最终方案：Tauri 环境统一走自建 Rust 命令 `cnb_http_request`
 * （native-tls + 强制直连 + 域名白名单），把结果包装成标准 Response
 * 返回，调用方（loginWithPat/cnbFetch）无需感知差异；
 * 浏览器环境（直接 pnpm dev 调试）保持原生 fetch。
 */
async function httpFetch(input: string, init?: RequestInit): Promise<Response> {
  if (isTauriEnv()) {
    const { invoke } = await import('@tauri-apps/api/core')
    // 把 HeadersInit 归一化为普通对象传给 Rust 侧
    const headers: Record<string, string> = {}
    const headerBag = new Headers(init?.headers)
    headerBag.forEach((value, key) => {
      headers[key] = value
    })
    const result = await invoke<{ status: number, body: string }>('cnb_http_request', {
      method: init?.method ?? 'GET',
      url: input,
      headers,
      // 写操作（POST/PATCH/PUT）的请求体透传给 Rust 侧（reqwest 自动计算
      // Content-Length，Content-Type 由上方 headers 提供）；GET 传 null
      body: typeof init?.body === 'string' ? init.body : null,
    })
    // 包装为标准 Response：上层使用的 status/ok/json()/text() 全部可用
    return new Response(result.body, {
      status: result.status,
      headers: { 'content-type': 'application/json' },
    })
  }
  return fetch(input, init)
}

/** 判断当前是否运行在 Tauri 桌面环境（Webview 会注入 __TAURI_INTERNALS__） */
function isTauriEnv(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** CNB Open API 服务地址（官方文档约定） */
export const CNB_API_BASE = 'https://api.cnb.cool'

/** 访问令牌引导文档地址（官方指南：如何创建/查看访问令牌） */
export const CNB_TOKEN_GUIDE_URL = 'https://docs.cnb.cool/zh/guide/access-token.html'

/** 访问令牌创建/管理页（个人设置 → 访问令牌） */
export const CNB_TOKEN_MANAGE_URL = 'https://cnb.cool/profile/token'

/**
 * CNB 用户头像 URL 规则：https://cnb.cool/users/{username}/avatar/s。
 * 背景：GET /user 返回的 avatar 字段在用户未自定义头像时为空字符串，
 * 但 CNB 网站本身仍会展示默认头像 —— 该 URL 由 CNB 官方前端使用
 * （社区开源项目 open-cnb 等均按此规则渲染），始终可访问，
 * 因此 avatar 为空时以此规则 URL 兜底，保证应用内头像与 CNB 网站一致。
 */
export function cnbAvatarUrl(username: string): string {
  return `https://cnb.cool/users/${username}/avatar/s`
}

/**
 * CNB 组织（group）图标 URL 规则：https://cnb.cool/{path}/-/logos/s。
 *
 * 考证过程（2026-10）：
 * - GET /user/groups 与 GET /{path} 的响应（dto.OrganizationAccess /
 *   dto.OrganizationUnion）均**不含** avatar/logo 类字段；
 * - 抓取 cnb.cool 官网组织主页（SSR HTML）发现，组织图标的 img src 为
 *   "/{path}/-/logos/s"，即官方前端按此规则渲染组织图标；
 * - 实测验证：/s、/m、/l 三个尺寸均返回 image/*（200），
 *   未自定义图标的组织同样返回默认占位图（不会 404）。
 * 因此组织图标直接按此 URL 规则展示，与 CNB 网站视觉一致。
 * @param path 组织路径（CnbGroup.path，支持子组织多级路径）
 */
export function cnbGroupLogoUrl(path: string): string {
  return `https://cnb.cool/${path}/-/logos/s`
}

/** 用户详情结构（仅声明登录页用到的字段，来源：Swagger dto.UsersResult） */
export interface CnbUser {
  username: string
  nickname: string
  avatar: string
  email: string
}

/** 全局共享的令牌与用户信息（localStorage 持久化 + 响应式） */
export const cnbToken = useStorage<string>('cnb-token', '')
// 用户信息必须显式指定序列化器（默认值为 null 时 vueuse 会误用 String() 写入，
// 详见 cnbUserSerializer 注释中的踩坑记录）
export const cnbUser = useStorage<CnbUser | null>('cnb-user', null, undefined, {
  serializer: cnbUserSerializer,
})

/** 是否已登录（存在令牌即视为已登录，有效性由 API 调用时按需校验） */
export const isLoggedIn = () => !!cnbToken.value

/**
 * 登录态恢复：应用启动时调用。
 *
 * 场景：本地已保存令牌（登录态持久化生效、路由守卫放行），但用户信息
 * 缺失或已被判定为非法数据（如旧版本落盘的脏数据被序列化器清洗为 null）。
 * 此时用已保存的令牌重新拉取 GET /user 补全用户信息，避免侧边栏出现
 * "有令牌却无头像/昵称"的中间态。
 *
 * 静默失败策略：网络异常时保持现状（令牌仍在），下次启动重试；
 * 若令牌已失效（401/403）则清除登录态，强制用户重新登录。
 */
export async function restoreSession(): Promise<void> {
  // 未登录或用户信息完整（含 username）时无需恢复
  if (!cnbToken.value || cnbUser.value?.username) {
    return
  }
  try {
    const response = await httpFetch(`${CNB_API_BASE}/user`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${cnbToken.value}`,
      },
    })
    if (responseIsUnauthorized(response.status)) {
      // 令牌已失效：清除本地登录态，路由守卫会自动引导到登录页
      logout()
      return
    }
    if (!response.ok) {
      // 其他服务端错误：静默跳过，下次启动重试
      return
    }
    const raw = (await response.json()) as Partial<CnbUser>
    if (raw.username) {
      cnbUser.value = {
        username: raw.username,
        nickname: raw.nickname || raw.username,
        avatar: raw.avatar || cnbAvatarUrl(raw.username),
        email: raw.email || '',
      }
    }
  }
  catch {
    // 网络异常：静默跳过，保持已保存的令牌不动
  }
}

/**
 * CNB API 错误类别（由 HTTP 状态码归一）。
 * - unauthorized：401，全局拦截器已登出跳转，页面无需处理；
 * - forbidden：403，令牌有效但权限不足 —— 绝不登出（否则缺 scope 的用户
 *   会被踢回登录页死循环），由 StateAlert 统一呈现"缺权限"提示；
 * - notFound：404，资源不存在或无权访问私有资源；
 * - network：网络层异常（fetch reject / 超时）。
 */
export type CnbApiErrorKind = 'unauthorized' | 'forbidden' | 'notFound' | 'network'

/**
 * CNB API 通用错误：携带 HTTP 状态码、错误类别与缺失的权限 scope。
 * missingScope 仅在 403 时尝试从 errmsg 解析（形如 "repo-code:r" /
 * "group-manage:rw"），StateAlert 据此给出"管理令牌"等可操作提示。
 */
export class CnbApiError extends Error {
  status?: number
  kind: CnbApiErrorKind
  missingScope?: string
  constructor(message: string, status?: number, kind?: CnbApiErrorKind, missingScope?: string) {
    super(message)
    this.status = status
    // kind 未显式给出时按状态码归一（404 → notFound，403 → forbidden，其余 → network；
    // 401 场景由 cnbFetch 显式传 'unauthorized'，构造前已登出）
    this.kind = kind ?? (status === 403 ? 'forbidden' : status === 404 ? 'notFound' : 'network')
    this.missingScope = missingScope
  }
}

/**
 * 从 CNB 错误响应的 errmsg 中解析缺失的权限 scope。
 * CNB 403 响应形如 { errmsg: "Missing ... repo-code:r ..." }，
 * 正则匹配形如 xxx:r / xxx:rw 的资源权限标识。
 *
 * 严格小写（QA 回归口径）：CNB scope 名均为小写（repo-issue:rw、
 * group-resource:r），不加 /i —— 否则 "Forbidden:Restricted" 会误抽出
 * "Forbidden:R" 展示在 403 提示里。负向断言 (?![\w-]) 防止匹配更长
 * token 的前缀（如 ":rwx" 中的 ":r"）。
 * 解析不到返回 undefined（如 403 由风控等其他原因引起），上层退化为通用权限提示。
 */
export function parseMissingScope(errmsg: string): string | undefined {
  const match = errmsg.match(/[a-z][a-z0-9-]*:(?:r|rw)(?![\w-])/)
  return match?.[0]
}

/**
 * 文本通道：与 cnbFetch 同一网络链路，但不做 response.json()，
 * 返回原始文本，供 raw 文件、阶段日志等非 JSON 场景使用。
 *
 * 端点示例：GET /{repo}/-/git/raw/{ref_with_path}（Accept: text/plain）、
 * GET /{repo}/-/build/logs/stage/{sn}/{pipelineId}/{stageId}（JSON，由调用方自行 parse）。
 *
 * 401 时仍触发全局登出拦截（与 cnbFetch 行为一致）；403/404/其他错误
 * 不抛异常，以 { status, ok, text } 返回由调用方按需处理（raw 文件
 * 404 时页面给"在浏览器打开"兜底，而不是整页报错）。
 */
export async function cnbFetchText(path: string, options: {
  accept?: string
  headers?: Record<string, string>
} = {}): Promise<{ status: number, ok: boolean, text: string }> {
  const response = await httpFetch(`${CNB_API_BASE}${path}`, {
    headers: {
      // Accept 可由调用方覆盖（raw 文本需 text/plain；Rust 侧仅在未指定时兜底 JSON）
      Accept: options.accept || 'application/json',
      ...(cnbToken.value ? { Authorization: `Bearer ${cnbToken.value}` } : {}),
      ...options.headers,
    },
  })
  // 401 与 cnbFetch 同语义：令牌失效，统一登出后返回（ok=false，调用方自然中断流程）
  if (response.status === 401) {
    handleUnauthorized()
  }
  const text = await response.text()
  return { status: response.status, ok: response.ok, text }
}

/**
 * 调用 CNB Open API 的通用封装。
 * 自动附加 Bearer 认证头与 Accept 头（官方文档要求的两个 Header）。
 */
export async function cnbFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response
  try {
    response = await httpFetch(`${CNB_API_BASE}${path}`, {
      ...options,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        // 令牌可能为空（登录前调用公开接口时），此时不发送认证头
        ...(cnbToken.value ? { Authorization: `Bearer ${cnbToken.value}` } : {}),
        ...options.headers,
      },
    })
  }
  catch (err) {
    // 网络层异常（fetch reject / Rust 命令错误）：归一为 kind=network，
    // 页面 StateAlert 呈现"网络异常 + 重试"，不与权限错误混淆
    console.error(`[cnb] network error on ${path}:`, err)
    throw new CnbApiError(i18n.global.t('auth.networkError'), undefined, 'network')
  }
  if (!response.ok) {
    // 401 拦截器：令牌已失效 —— 清除本地登录态并跳转登录页（登录成功后
    // 可通过 redirect 参数原路返回当前页面），再抛出异常中断调用链
    if (response.status === 401) {
      handleUnauthorized()
      throw new CnbApiError(i18n.global.t('auth.sessionExpired'), response.status, 'unauthorized')
    }
    // 非 401 错误：尝试透出服务器原始 errmsg（CNB 错误响应含 errcode/errmsg，
    // 如 403 时提示"Missing required scopes: account-profile:rw"等权限细节），
    // 便于用户定位"令牌缺权限 / 资源不存在 / 参数非法"等具体原因
    const base = i18n.global.t('auth.apiFailed', { status: response.status })
    const detail = await extractServerMessage(response)
    // 403：解析缺失的权限 scope（如 repo-code:r），供 StateAlert 给出
    // "管理令牌"等可操作提示 —— 红线：403 绝不登出（令牌本身有效，
    // 强制登出会让缺 scope 的用户陷入登录死循环）
    const missingScope = response.status === 403 ? parseMissingScope(detail) : undefined
    throw new CnbApiError(
      detail ? `${base}${i18n.global.t('auth.serverDetail', { detail })}` : base,
      response.status,
      response.status === 403 ? 'forbidden' : response.status === 404 ? 'notFound' : 'network',
      missingScope,
    )
  }
  return response.json() as Promise<T>
}

/**
 * 使用 PAT 登录：校验令牌有效性并拉取用户信息。
 *
 * 校验端点依据官方文档：GET /user —— 获取当前认证用户的详情，
 * 令牌无效时返回 401，借此完成登录校验。
 *
 * @param pat 用户输入的访问令牌（Personal Access Token）
 * @throws CnbApiError 状态码 401/403 表示令牌无效或已过期
 */
export async function loginWithPat(pat: string): Promise<CnbUser> {
  const trimmed = sanitizePat(pat)
  // 临时令牌仅用于本次校验请求，避免污染全局状态（校验通过后才正式保存）
  const savedToken = cnbToken.value
  cnbToken.value = trimmed
  try {
    // 经 httpFetch 发起：Tauri 环境走 Rust 侧（绕过 CORS），浏览器走原生 fetch
    const user = await httpFetch(`${CNB_API_BASE}/user`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${trimmed}`,
      },
    })
    if (responseIsUnauthorized(user.status)) {
      // 读取服务器返回的原始错误信息（CNB 响应体含 errcode/errmsg），
      // 透出详情便于区分"令牌确实无效"与"权限不足/账号未激活"等情况
      const detail = await extractServerMessage(user)
      throw new CnbApiError(
        // 服务器原始信息按当前语言拼接（detail 为空时不追加"服务器返回"片段）
        i18n.global.t('auth.tokenInvalid', {
          status: user.status,
          detail: detail ? i18n.global.t('auth.serverDetail', { detail }) : '',
        }),
        user.status,
      )
    }
    if (!user.ok) {
      const detail = await extractServerMessage(user)
      throw new CnbApiError(
        i18n.global.t('auth.otherFail', {
          status: user.status,
          detail: detail ? i18n.global.t('auth.serverDetail', { detail }) : '',
        }),
        user.status,
      )
    }
    const raw = (await user.json()) as Partial<CnbUser>
    // 兜底字段：用户名是 CNB 资源路径的组成部分，必须存在
    if (!raw.username) {
      throw new CnbApiError(i18n.global.t('auth.missingUsername'), user.status)
    }
    const normalized: CnbUser = {
      username: raw.username,
      nickname: raw.nickname || raw.username,
      // avatar 为空（用户未在 CNB 设置自定义头像）时回退到 CNB 官方默认头像 URL，
      // 与 cnb.cool 网站上看到的头像保持一致
      avatar: raw.avatar || cnbAvatarUrl(raw.username),
      email: raw.email || '',
    }
    // 校验通过：正式保存令牌与用户信息（触发所有响应式引用更新）
    cnbToken.value = trimmed
    cnbUser.value = normalized
    return normalized
  }
  catch (err) {
    // 校验失败：回滚令牌，保持"未登录"状态干净
    cnbToken.value = savedToken
    // 网络层异常（fetch reject）统一转译为友好提示
    if (err instanceof CnbApiError) {
      throw err
    }
    throw new CnbApiError(i18n.global.t('auth.networkError'))
  }
}

/**
 * 清洗用户输入的令牌，规避常见的粘贴问题：
 * - 去掉误粘贴的 "Bearer " 前缀（从文档/他人示例复制时常见，会导致认证头变成 "Bearer Bearer xxx"）
 * - 移除所有空白字符（换行、制表符、全角空格等，复制时经常混入且肉眼不可见）
 */
function sanitizePat(raw: string): string {
  return raw
    .replace(/^bearer\s+/i, '')
    .replace(/\s+/g, '')
}

/**
 * 从错误响应中提取服务器原始错误信息。
 * CNB API 错误响应格式：{ "errcode": ..., "errmsg": "..." }；
 * 解析失败（非 JSON/网络中断）时返回空串，不影响主错误信息展示。
 */
async function extractServerMessage(response: Response): Promise<string> {
  try {
    const text = await response.text()
    const parsed = JSON.parse(text) as { errmsg?: string }
    return parsed.errmsg || ''
  }
  catch {
    return ''
  }
}

/** 判断状态码是否属于认证失败（用于区分"令牌错误"与"服务/网络问题"） */
function responseIsUnauthorized(status: number): boolean {
  return status === 401 || status === 403
}

// ---------------------------------------------------------------------------
// 401 统一拦截器
// ---------------------------------------------------------------------------

/**
 * 401 处理回调（由应用入口注入，composable 层不直接依赖 router 实例）。
 * 参数为触发 401 时的页面路径，供登录页登录成功后原路返回。
 */
type UnauthorizedHandler = (fromPath: string) => void

let unauthorizedHandler: UnauthorizedHandler | null = null

/**
 * 注册 401 拦截回调（main.ts 启动时调用一次）。
 * @param handler 收到 401 时的跳转逻辑（通常是 router.push 到登录页）
 */
export function setUnauthorizedHandler(handler: UnauthorizedHandler) {
  unauthorizedHandler = handler
}

/**
 * 401 统一处理：清除本地登录态（令牌 + 用户信息）并触发跳转回调。
 *
 * 设计说明：
 * - 只在 401 时触发（令牌确定无效/过期）；403 可能是"令牌有效但无该资源
 *   权限"，此时不应强制登出，由调用方按业务展示错误即可；
 * - logout() 幂等，多个并发请求同时收到 401 不会产生副作用；
 * - 回调内部需自行判断当前已在登录页则跳过跳转，避免循环重定向。
 */
function handleUnauthorized() {
  logout()
  const fromPath = `${window.location.pathname}${window.location.search}`
  unauthorizedHandler?.(fromPath)
}

/** 退出登录：清空本地令牌与用户信息（不清除 CNB 服务端的令牌本身） */
export function logout() {
  cnbToken.value = ''
  cnbUser.value = null
}

/** 组织详情结构（界面用到的字段，来源：Swagger dto.OrganizationAccess） */
export interface CnbGroup {
  /** 组织唯一标识 */
  id: string
  /** 组织名称（展示用） */
  name: string
  /** 组织路径（CNB 资源路径组成部分，也是 URL slug） */
  path: string
  /** 组织描述 */
  description: string
  /** 直接成员数 */
  member_count: number
  /** 全部子仓库数（含子组织） */
  all_sub_repo_count: number
  /** 当前用户在组织内的权限角色（如 Owner / Master / Developer） */
  access_role: string
  // —— 以下字段用于 Home 页组织概览（API 恒返回，声明为可选以防御旧数据） ——
  /** 全部成员数（含子组织，dto.all_member_count） */
  all_member_count?: number
  /** 下一级子组织数量 */
  sub_group_count?: number
  /** 下一级任务集数量 */
  sub_mission_count?: number
  /** 下一级制品库数量 */
  sub_registry_count?: number
  /** 关注数 */
  follow_count?: number
  /** 组织官网 */
  site?: string
  /** 组织域名 */
  domain?: string
  /** 创建时间（ISO 8601） */
  created_at?: string
  /** 最近更新时间（ISO 8601） */
  updated_at?: string
}

/** CNB 相关页面地址（创建/管理组织，URL 以 CNB 站点实际入口为准） */
export const CNB_GROUP_CREATE_URL = 'https://cnb.cool/new/groups'

/**
 * 组织管理页 URL：按当前登录用户名拼接。
 * CNB 的组织管理入口是用户维度页面 /u/{username}/groups。
 */
export function cnbGroupManageUrl(username: string): string {
  return `https://cnb.cool/u/${username}/groups`
}

/** 组织主页 URL：按组织路径拼接 */
export function cnbGroupUrl(path: string): string {
  return `https://cnb.cool/${path}`
}

/**
 * 获取当前用户所在的顶层组织（group）列表。
 * 端点依据 CNB Open API：GET /user/groups —— 获取顶层组织列表，
 * 返回 dto.OrganizationAccess 数组（含组织信息 + 当前用户权限角色）。
 */
export async function fetchCnbGroups(): Promise<CnbGroup[]> {
  const raw = await cnbFetch<CnbGroup[]>('/user/groups')
  // 兜底：接口应返回数组，异常时按空列表处理，避免调用方空指针
  return Array.isArray(raw) ? raw : []
}

/**
 * 当前选中的组织（全局共享状态）。
 * 侧边栏 GroupsMenu 切换组织时写入，首页等组织维度的页面读取，
 * 保证"侧边栏选中哪个组织、首页就展示哪个组织的仓库"。
 * 注意：不持久化，每次启动默认选中组织列表第一项。
 */
export const selectedGroup = ref<CnbGroup | null>(null)

/** 组织仓库信息（仅声明界面用到的字段，来源：Swagger dto.Repos4User） */
export interface CnbRepo {
  /** 仓库完整路径（如 guroads/guitu-api），CNB 资源唯一标识 */
  path: string
  /** 仓库名称 */
  name: string
  /** 仓库描述（可能为空） */
  description: string
  /** 仓库 Web 页面地址（cnb.cool 上） */
  webUrl: string
  /** 可见性（constant.Visibility 枚举：Private 私有 / Public 公开 / Secret 加密） */
  visibility: string
  /** Star 数 */
  starCount: number
  /** 开启中的 Issue 数 */
  issueCount: number
  /** 开启中的 PR 数 */
  prCount: number
  /** 主语言名称（可能为空） */
  language: string
  /** 主语言标记色（GitHub linguist 色板，如 #b07219） */
  languageColor: string
  /** 最近更新时间（ISO 8601） */
  updatedAt: string
  /** 最近一次更新者的昵称（可能为空） */
  lastUpdateNickname: string
}

/** GET /{slug}/-/repos 的原始响应条目结构（snake_case，仅声明归一化用到的字段） */
interface RawCnbRepo {
  path?: string
  name?: string
  description?: string
  /** 仓库 Web 地址 */
  web_url?: string
  /** 可见性枚举（Private / Public / Secret）——注意字段名是 visibility_level */
  visibility_level?: string
  star_count?: number
  open_issue_count?: number
  open_pull_request_count?: number
  /** 语言对象 { language: 名称, color: 展示色 }（非字符串） */
  languages?: { language?: string, color?: string }
  updated_at?: string
  last_update_nickname?: string
}

/**
 * 获取组织下的仓库列表。
 * 端点依据 CNB Open API：GET /{slug}/-/repos —— 查询组织可见仓库，
 * 返回 dto.Repos4User 数组；descendant=1 表示包含子组织的仓库。
 *
 * @param slug 组织路径（CnbGroup.path）
 * @param page 页码（从 1 开始）
 * @param pageSize 每页条数（首页列表默认 30）
 */
export async function fetchCnbGroupRepos(
  slug: string,
  page = 1,
  pageSize = 30,
): Promise<CnbRepo[]> {
  const query = new URLSearchParams({
    page: String(page),
    page_size: String(pageSize),
    descendant: '1',
  })
  // slug 是资源路径的一部分，需编码防注入特殊字符
  // 原始响应为 snake_case（dto.Repos4User），字段名与 CnbRepo 不同，
  // 因此用 RawCnbRepo 类型承接后逐字段归一化
  const raw = await cnbFetch<RawCnbRepo[]>(`/${encodeURIComponent(slug)}/-/repos?${query}`)
  if (!Array.isArray(raw)) {
    return []
  }
  // 归一化：snake_case -> camelCase，并给可空字段兜底，界面层无需判空
  return raw.map(item => ({
    path: item.path || '',
    name: item.name || '',
    description: item.description || '',
    webUrl: item.web_url || (item.path ? `https://cnb.cool/${item.path}` : ''),
    // 可见性：源字段为 visibility_level（Private / Public / Secret 三值枚举）；
    // 异常缺失时兜底 Private（宁可误标私有也不把私有仓库暴露为公开）
    visibility: item.visibility_level || 'Private',
    starCount: item.star_count ?? 0,
    issueCount: item.open_issue_count ?? 0,
    prCount: item.open_pull_request_count ?? 0,
    // 语言：源字段为对象 { language, color }（非字符串）
    language: item.languages?.language || '',
    languageColor: item.languages?.color || '',
    updatedAt: item.updated_at || '',
    lastUpdateNickname: item.last_update_nickname || '',
  }))
}

/** 动态类型（通知面板展示与图标映射用） */
export type CnbActivityKind = 'commit' | 'pull_request' | 'issue' | 'code_review' | 'create_repo' | 'join_group'

/** 用户动态条目（通知面板展示用，已归一化） */
export interface CnbActivityItem {
  kind: CnbActivityKind
  /** 关联的仓库/组织路径（点击跳转 cnb.cool 对应页面） */
  targetPath: string
  /** 动态次数（commits 类为提交次数，其余为 1） */
  count: number
  /** 动态时间（ISO 8601；提交类为按仓库聚合、无具体时间则为空） */
  time: string
}

/** 原始动态响应结构（Swagger dto.ActivityDate，仅声明用到的字段） */
interface RawActivityResponse {
  commits?: { time?: number, detail?: { path?: string }, exposed_repo_path?: string }[]
  pull_requests?: { time?: number, detail?: { path?: string }, exposed_repo_path?: string }[]
  issues?: { time?: number, detail?: { path?: string }, exposed_repo_path?: string }[]
  code_reviews?: { time?: number, detail?: { path?: string }, exposed_repo_path?: string }[]
  repos?: { create_at?: string, detail?: { path?: string } }[]
  groups?: { create_at?: string, detail?: { path?: string } }[]
}

/**
 * 获取用户动态（通知面板数据源）。
 *
 * 端点依据 CNB Open API：GET /users/{username}/activities?date=yyyyMM，
 * 返回指定月份按类型分类的动态（提交/PR/Issue/评审/建仓/加组织）。
 *
 * 重要说明：CNB 目前**没有独立的通知 API**——OpenAPI 无 notification
 * 端点，且 CNB 网页端自己的 fetchNotifications 也是返回空数组的桩实现
 * （逆向确认）。因此通知面板以"用户动态"作为数据源，展示本月发生了什么。
 *
 * @param username 用户名（cnbUser.username）
 * @param date 查询月份，格式 yyyyMM
 */
export async function fetchCnbActivities(username: string, date: string): Promise<CnbActivityItem[]> {
  const raw = await cnbFetch<RawActivityResponse>(
    `/users/${encodeURIComponent(username)}/activities?date=${encodeURIComponent(date)}`,
  )
  const items: CnbActivityItem[] = []

  // 仓库维度聚合的动态（提交/PR/Issue/评审）：time 为次数
  const repoKindEntries: [CnbActivityKind, typeof raw.commits][] = [
    ['commit', raw.commits],
    ['pull_request', raw.pull_requests],
    ['issue', raw.issues],
    ['code_review', raw.code_reviews],
  ]
  for (const [kind, list] of repoKindEntries) {
    for (const item of list ?? []) {
      const path = item.detail?.path || item.exposed_repo_path || ''
      if (!path) {
        continue
      }
      items.push({ kind, targetPath: path, count: item.time ?? 1, time: '' })
    }
  }

  // 时间维度明细动态（建仓/加组织）：create_at 为具体时间
  for (const item of raw.repos ?? []) {
    const path = item.detail?.path || ''
    if (path) {
      items.push({ kind: 'create_repo', targetPath: path, count: 1, time: item.create_at || '' })
    }
  }
  for (const item of raw.groups ?? []) {
    const path = item.detail?.path || ''
    if (path) {
      items.push({ kind: 'join_group', targetPath: path, count: 1, time: item.create_at || '' })
    }
  }
  return items
}

/** 用户资料表单结构（Profile 页字段，对应 Swagger dto.UsersResult 的可编辑子集） */
export interface CnbProfilePayload {
  /** 昵称（只读回显：CNB 不允许通过 API 修改，需在官网操作） */
  nickname: string
  /** 个人简介 */
  bio: string
  /** 公司 */
  company: string
  /** 所在地 */
  location: string
  /** 地址 */
  address: string
  /** 个人主页 */
  site: string
  /** 微信公众号 */
  wechatMp: string
}

/**
 * 获取当前用户的完整资料（Profile 页数据源）。
 * 端点依据 CNB Open API：GET /user —— 返回 dto.UsersResult，
 * 从中提取可编辑字段（snake_case -> camelCase 归一化，空值兜底空串）。
 */
export async function fetchCnbUserProfile(): Promise<CnbProfilePayload> {
  const user = await cnbFetch<Record<string, unknown>>('/user')
  const str = (key: string): string => (typeof user[key] === 'string' ? (user[key] as string) : '')
  return {
    nickname: str('nickname'),
    bio: str('bio'),
    company: str('company'),
    location: str('location'),
    address: str('address'),
    site: str('site'),
    wechatMp: str('wechat_mp'),
  }
}

/**
 * 更新当前用户的个人资料。
 * 端点依据 CNB Open API：POST /user（请求体 dto.UpdateUserInfoPayload），
 * 访问令牌需包含 account-profile:rw 权限，更新成功返回 200（无响应体）。
 *
 * 设计说明（均为实测验证的 API 行为约束）：
 * - 不提交 name 字段：用户名是 CNB 资源路径的唯一标识，重命名属敏感操作
 *   （会影响现有仓库/组织路径归属），官方网页端也是单独流程处理，
 *   客户端不做此能力，避免误改导致路径失效；
 * - 不提交 nickname 字段：实测 CNB 一律拒绝通过该接口改昵称
 *   （携带 nickname 时无论新旧值均返回 403 "Nickname cannot be changed."），
 *   昵称只能走 CNB 官网的个人设置流程，Profile 页将其展示为只读；
 * - site 字段服务器要求必须携带协议前缀（http:// 或 https://），
 *   否则返回 400 "The parameter site is invalid."，前端已做预校验兜底；
 * - 更新成功后重新拉取 GET /user 同步本地登录态（cnbUser）中的头像等字段，
 *   侧边栏用户菜单、通知面板等引用处随响应式状态立即更新。
 * @throws CnbApiError 更新失败时抛出（401 由拦截器统一处理；403 可能是
 *   令牌缺少 account-profile:rw 权限，错误信息透出状态码便于排查）
 */
export async function updateCnbProfile(payload: CnbProfilePayload): Promise<void> {
  await cnbFetch('/user', {
    method: 'POST',
    // 注意：不带 nickname —— CNB 拒绝通过 API 修改昵称（见函数注释），
    // payload.nickname 仅用于界面回显
    body: JSON.stringify({
      bio: payload.bio,
      company: payload.company,
      location: payload.location,
      address: payload.address,
      site: payload.site,
      wechat_mp: payload.wechatMp,
    }),
  })
  // 更新成功：重新拉取用户详情，同步本地登录态中的昵称/头像/邮箱
  const user = await cnbFetch<Partial<CnbUser>>('/user')
  if (user.username) {
    cnbUser.value = {
      username: user.username,
      nickname: user.nickname || user.username,
      avatar: user.avatar || cnbAvatarUrl(user.username),
      email: user.email || '',
    }
  }
}

// ---------------------------------------------------------------------------
// 组织用量统计（Home 页组织概览）
// ---------------------------------------------------------------------------

/** 组织资源用量条目（已归一化：同一资源类型的用量 + 额度合并为一条） */
export interface CnbGroupUsageItem {
  /** 资源类型标识（ci_in_sec / git_in_byte 等，与 CNB API 字段一致） */
  key: string
  /** 本月已用量 */
  used: number
  /** 冻结用量（in-flight 流水线预扣费，对应 freeze_{key} 字段） */
  frozen: number
  /** 本月总额度（含免费/付费/特权额度） */
  total: number
  /** 免费额度 */
  free: number
}

/** 用量/额度涉及的资源类型清单（顺序即界面展示顺序；GPU 两项额度为 0 时界面隐藏） */
const GROUP_USAGE_KEYS = [
  'ci_in_sec',
  'ci_gpu_in_sec',
  'dev_in_sec',
  'dev_gpu_in_sec',
  'git_in_byte',
  'object_in_byte',
  'credit_in_milli',
] as const

/**
 * 获取组织本月资源用量与额度。
 *
 * 端点依据 CNB Open API（均需令牌包含 group-resource:r 权限）：
 * - GET /{slug}/-/charge/volume —— dto.VolumeUsedResp，各资源类型已用量
 *   （含 freeze_* 冻结用量字段，单位与同名字段一致）；
 * - GET /{slug}/-/charge/quota —— dto.VolumeQuotaResp，各资源类型本月额度
 *   （dto.QuotaItem：total 总额度 / free 免费额度）。
 *
 * 单位约定（界面层据此选择格式化函数）：
 * - *_in_sec：核秒（CPU/GPU 核 × 秒）；*_in_byte：字节；
 *   credit_in_milli：milli_credit（1000 = 1 credit）。
 *
 * @param slug 组织路径（CnbGroup.path）
 */
export async function fetchCnbGroupUsage(slug: string): Promise<CnbGroupUsageItem[]> {
  const [used, quota] = await Promise.all([
    cnbFetch<Record<string, number>>(`/${slug}/-/charge/volume`),
    cnbFetch<Record<string, { total?: number; free?: number }>>(`/${slug}/-/charge/quota`),
  ])
  const usedRec = (used ?? {}) as Record<string, number>
  const quotaRec = (quota ?? {}) as Record<string, { total?: number; free?: number }>
  return GROUP_USAGE_KEYS.map(key => ({
    key,
    used: usedRec[key] ?? 0,
    // 冻结用量字段名为 freeze_{key}（如 freeze_ci_in_sec），缺失按 0 处理
    frozen: usedRec[`freeze_${key}`] ?? 0,
    total: quotaRec[key]?.total ?? 0,
    free: quotaRec[key]?.free ?? 0,
  }))
}

// ---------------------------------------------------------------------------
// 我的 Issue 列表（Home 页「待办」「我创建的」选项卡）
// ---------------------------------------------------------------------------

/** Issue 标签（归一化后仅保留界面用到的字段，来源：Swagger api.Label） */
export interface CnbIssueLabel {
  name: string
  color: string
}

/**
 * 我的 Issue 条目（已归一化，来源：Swagger api.UserIssue）。
 *
 * 注意：api.UserIssue 本身不携带 Issue 的 Web 地址，
 * 展示层按 CNB 资源路径约定拼接：https://cnb.cool/{repoPath}/-/issues/{number}
 */
export interface CnbUserIssue {
  /** Issue 编号（仓库内唯一，如 "42"） */
  number: string
  /** 标题 */
  title: string
  /** 状态（open / closed） */
  state: string
  /** 所属仓库完整路径（如 guroads/guitu-api） */
  repoPath: string
  /** 所属仓库名称 */
  repoName: string
  /** 创建者昵称（可能为空） */
  authorName: string
  /** 标签列表（最多 10 个） */
  labels: CnbIssueLabel[]
  /** 优先级（-2P/-1P/P0/P1/P2/P3，可能为空） */
  priority: string
  /** 评论数 */
  commentCount: number
  /** 创建时间（ISO 8601） */
  createdAt: string
  /** 最后更新时间（ISO 8601） */
  updatedAt: string
}

/** GET /user/issues 的原始响应条目（snake_case，仅声明归一化用到的字段） */
interface RawUserIssue {
  number?: string
  title?: string
  state?: string
  priority?: string
  comment_count?: number
  created_at?: string
  updated_at?: string
  author?: { nickname?: string, username?: string }
  repo?: { path?: string, name?: string }
  labels?: { name?: string, color?: string }[]
}

/**
 * 跨仓库查询当前用户相关的 Issue 列表。
 *
 * 端点依据 CNB Open API：GET /user/issues（令牌需包含 repo-issue:r 权限）：
 * - filter=assigned：分配给我的（Home「待办」选项卡数据源）；
 * - filter=created：我创建的（Home「我创建的」选项卡数据源）；
 * - state=open：仅开启中的条目（关闭的 Issue 不再是待办事项）。
 *
 * @param filter 筛选类型：assigned（分配给我的）/ created（我创建的）
 * @param state Issue 状态过滤（默认 open）
 * @param page 页码（从 1 开始）
 * @param pageSize 每页条数（默认 20，接口上限 100）
 */
export async function fetchCnbUserIssues(
  filter: 'assigned' | 'created',
  state: 'open' | 'closed' = 'open',
  page = 1,
  pageSize = 20,
): Promise<CnbUserIssue[]> {
  const query = new URLSearchParams({
    filter,
    state,
    page: String(page),
    page_size: String(pageSize),
  })
  const raw = await cnbFetch<RawUserIssue[]>(`/user/issues?${query}`)
  if (!Array.isArray(raw)) {
    return []
  }
  // 归一化：snake_case -> camelCase，并给可空字段兜底，界面层无需判空
  return raw.map(item => ({
    number: item.number || '',
    title: item.title || '',
    state: item.state || 'open',
    repoPath: item.repo?.path || '',
    repoName: item.repo?.name || item.repo?.path || '',
    authorName: item.author?.nickname || item.author?.username || '',
    labels: (item.labels || []).map(l => ({
      name: l.name || '',
      color: l.color || '',
    })).filter(l => l.name),
    priority: item.priority || '',
    commentCount: item.comment_count ?? 0,
    createdAt: item.created_at || '',
    updatedAt: item.updated_at || '',
  }))
}
