/**
 * CI · AI 用量数据层（REQ-06，3 端点）。
 *
 * 端点（scope: repo-cnb-history:r）：
 * - GET /{repo}/-/build/logs/ai-audit/{sn}/{pipelineId}              → dto.BuildAiAuditResult
 * - GET /{repo}/-/build/logs/ai-request/{sn}/{pipelineId}/{page}     → dto.BuildAiRequestResult
 * - GET /{repo}/-/build/logs/ai-request-detail/{sn}/{pipelineId}/{rid} → dto.BuildAiRequestDetailResult
 *
 * 通道：三者均为 200 + JSON body → 一律 cnbFetch。
 *
 * ⚠️ 与其他端点的关键差异（风险 A2）：三个响应都带业务码 `code`（0 = 成功）。
 * HTTP 200 也可能 code≠0，此时 content 不是有效数据 —— 数据层判 code 返回空结构，
 * UI 据此渲染空态而非把错误对象当 token 明细渲染。
 *
 * content 在 audit/detail 中是**无 schema 的自由对象**（swagger type 为空），
 * 保留 Record<string, unknown> 原样给 UI 做键值对折叠 + JSON 代码块，不猜字段。
 *
 * 关于 pipelineId（主理人 Q2 裁决）：构建状态响应 fetchBuildStatus 的
 * pipelines[].id（来自 pipelinesStatus map 的 key）即 pipelineId，UI 从详情
 * 取得；若构建无流水线（parseOk=false）则以 sn 占位并标注需在真机复核。
 * 数据层不臆造来源，只按调用方传入的 pipelineId 拼路径。
 */
import { cnbFetch } from './useCnbAuth'
import { encodeRepoPath } from './useCnbRepo'

// ---------------------------------------------------------------------------
// 类型（camelCase，界面层不判空）
// ---------------------------------------------------------------------------

/** AI 用量汇总（GET ai-audit） */
export interface AiUsageSummary {
  /** 业务码（0 = 成功） */
  code: number
  /** 自由对象：token 总量 / 费用 / 请求数等，UI 按 key 友好化展示 */
  content: Record<string, unknown>
  /** 每页条数（源 request_log_page_size） */
  pageSize: number
  /** 总页数（源 request_log_pages） */
  pages: number
}

/** AI 请求明细条目（GET ai-request 的 content[]） */
export interface AiRequestEntry {
  /** 请求 id（用于下钻单次详情） */
  requestId: string
  /** 请求时间（ISO 8601，原样保留） */
  timestamp: string
  /** 模型名 */
  model: string
  /** 是否成功 */
  success: boolean
  /** 提示 token 数 */
  promptTokens: number
  /** 补全 token 数 */
  completionTokens: number
  /** 总 token 数 */
  totalTokens: number
  /** 思考 token 数 */
  thinkingTokens: number
  /** 命中缓存的提示 token 数 */
  promptCachedTokens: number
  /** 写入缓存的提示 token 数 */
  promptCacheWriteTokens: number
  /** 消耗（毫 credit） */
  milliCredit: number
  /** 原始消耗（未打折，缺失为 null 而非 0 —— 0 是合法值，语义不同） */
  originalMilliCredit: number | null
  /** 折扣（缺失为 null） */
  discount: number | null
  /** HTTP 状态码 */
  statusCode: number
  /** 失败原因（成功时为空） */
  failureReason: string
  /** 是否有单次详情可下钻 */
  hasDetail: boolean
  /** 首字响应耗时（毫秒） */
  responseStartDurationMs: number
  /** 完整响应耗时（毫秒） */
  responseEndDurationMs: number
}

/** AI 请求单次详情（GET ai-request-detail） */
export interface AiRequestDetail {
  /** 业务码（0 = 成功） */
  code: number
  /** 自由对象：单次请求明细，UI 折叠 + JSON 代码块展示 */
  content: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// 原始响应结构（snake_case，全可选防御）
// ---------------------------------------------------------------------------

interface RawBuildAiAuditResult {
  code?: number
  content?: unknown
  request_log_pages?: number
  request_log_page_size?: number
}

interface RawBuildAiRequestResult {
  code?: number
  content?: unknown
}

interface RawBuildAiRequestDetailResult {
  code?: number
  content?: unknown
}

/** dto.BuildAiRequestEntry 原始条目（snake_case） */
interface RawAiRequestEntry {
  request_id?: string
  timestamp?: string
  model?: string
  success?: boolean
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  thinking_tokens?: number
  prompt_cached_tokens?: number
  prompt_cache_write_tokens?: number
  milli_credit?: number
  original_milli_credit?: number | null
  discount?: number | null
  status_code?: number
  failure_reason?: string
  has_detail?: boolean
  response_start_duration_ms?: number
  response_end_duration_ms?: number
}

// ---------------------------------------------------------------------------
// 归一化（导出供单测直接断言 code!=0 / 字段兜底）
// ---------------------------------------------------------------------------

/** 把未知 content 收敛成对象；非对象（null/数组/字符串）一律 {}，UI 不判空 */
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

/** 可空数字：null/undefined 保留 null（区别于合法 0），非数字也归 null */
function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 数字兜底：缺失/非数字归 0（0 是合法计数起点） */
function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * 汇总归一化：code!==0 时 content={}、pages/pageSize=0（视为空态，不报错）。
 * content 保留原对象（自由结构）供 UI 折叠渲染。
 */
export function normalizeAiAudit(raw: RawBuildAiAuditResult): AiUsageSummary {
  const code = numberOrZero(raw?.code)
  if (code !== 0) {
    return { code, content: {}, pageSize: 0, pages: 0 }
  }
  return {
    code,
    content: asRecord(raw?.content),
    pageSize: numberOrZero(raw?.request_log_page_size),
    pages: numberOrZero(raw?.request_log_pages),
  }
}

/** 明细条目归一化：全字段 snake_case → camelCase + 空值兜底 */
export function normalizeAiRequestEntry(raw: RawAiRequestEntry): AiRequestEntry {
  return {
    requestId: raw?.request_id || '',
    timestamp: raw?.timestamp || '',
    model: raw?.model || '',
    success: !!raw?.success,
    promptTokens: numberOrZero(raw?.prompt_tokens),
    completionTokens: numberOrZero(raw?.completion_tokens),
    totalTokens: numberOrZero(raw?.total_tokens),
    thinkingTokens: numberOrZero(raw?.thinking_tokens),
    promptCachedTokens: numberOrZero(raw?.prompt_cached_tokens),
    promptCacheWriteTokens: numberOrZero(raw?.prompt_cache_write_tokens),
    milliCredit: numberOrZero(raw?.milli_credit),
    // 这两个字段缺失语义是"未知"而非"零"，故保留 null
    originalMilliCredit: nullableNumber(raw?.original_milli_credit),
    discount: nullableNumber(raw?.discount),
    statusCode: numberOrZero(raw?.status_code),
    failureReason: raw?.failure_reason || '',
    hasDetail: !!raw?.has_detail,
    responseStartDurationMs: numberOrZero(raw?.response_start_duration_ms),
    responseEndDurationMs: numberOrZero(raw?.response_end_duration_ms),
  }
}

/**
 * 明细列表归一化：code!==0 → 空数组；content 非数组 → 空数组（不抛给 UI）。
 */
export function normalizeAiRequests(raw: RawBuildAiRequestResult): AiRequestEntry[] {
  const code = numberOrZero(raw?.code)
  if (code !== 0 || !Array.isArray(raw?.content)) {
    return []
  }
  return raw.content.map(normalizeAiRequestEntry)
}

/** 单次详情归一化：code!==0 → content={} */
export function normalizeAiRequestDetail(raw: RawBuildAiRequestDetailResult): AiRequestDetail {
  const code = numberOrZero(raw?.code)
  return { code, content: code !== 0 ? {} : asRecord(raw?.content) }
}

// ---------------------------------------------------------------------------
// 请求函数（三端点，均 cnbFetch）
// ---------------------------------------------------------------------------

/** 拼 AI 用端点路径：sn / pipelineId / requestId 各为独立路径段，单独编码 */
function aiLogPath(
  repoPath: string,
  kind: 'ai-audit' | 'ai-request' | 'ai-request-detail',
  sn: string,
  pipelineId: string,
  tail?: string,
): string {
  const base = `/${encodeRepoPath(repoPath)}/-/build/logs/${kind}/${encodeURIComponent(sn)}/${encodeURIComponent(pipelineId)}`
  return tail === undefined ? base : `${base}/${encodeURIComponent(tail)}`
}

/**
 * AI 用量汇总（GET ai-audit，scope: repo-cnb-history:r）。
 * **通道选择依据**：200 dto.BuildAiAuditResult（有 body）→ cnbFetch；
 * code!==0 由 normalizeAiAudit 转空结构，UI 显示空态。
 */
export async function fetchBuildAiAudit(
  repoPath: string,
  sn: string,
  pipelineId: string,
): Promise<AiUsageSummary> {
  const raw = await cnbFetch<RawBuildAiAuditResult>(aiLogPath(repoPath, 'ai-audit', sn, pipelineId))
  return normalizeAiAudit(raw)
}

/**
 * AI 请求分页明细（GET ai-request/{page}，scope: repo-cnb-history:r）。
 * **通道选择依据**：200 dto.BuildAiRequestResult（有 body）→ cnbFetch；
 * page 由调用方（AiUsagePanel 内部 ref 或 route.page）传入，从 1 开始。
 */
export async function fetchBuildAiRequests(
  repoPath: string,
  sn: string,
  pipelineId: string,
  page: number,
): Promise<AiRequestEntry[]> {
  const raw = await cnbFetch<RawBuildAiRequestResult>(
    aiLogPath(repoPath, 'ai-request', sn, pipelineId, String(page)),
  )
  return normalizeAiRequests(raw)
}

/**
 * AI 单次请求详情（GET ai-request-detail/{requestId}，scope: repo-cnb-history:r）。
 * **通道选择依据**：200 dto.BuildAiRequestDetailResult（有 body）→ cnbFetch；
 * 详情层级用页内 UModal 展开，不新增路由下钻键（设计 §2.6）。
 */
export async function fetchBuildAiRequestDetail(
  repoPath: string,
  sn: string,
  pipelineId: string,
  requestId: string,
): Promise<AiRequestDetail> {
  const raw = await cnbFetch<RawBuildAiRequestDetailResult>(
    aiLogPath(repoPath, 'ai-request-detail', sn, pipelineId, requestId),
  )
  return normalizeAiRequestDetail(raw)
}
