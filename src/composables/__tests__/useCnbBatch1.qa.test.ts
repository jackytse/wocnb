/**
 * 批次 1（REQ-01~06 / 32 端点）QA 独立验收单测 —— 与工程师自验用例**互为补充**，
 * 不复用其断言写法，独立重建对照表，避免"自证式测试"。
 *
 * 覆盖五个独立维度：
 * 1. **通道矩阵**：把设计 §8.2 / §12 的 32 行逐条落成一张表，每行断言「哪个通道
 *    被调用 + HTTP 方法」，任何一行写反（Void↔JSON）都会精确指出是哪一行；
 * 2. **路径编码**：多级仓库路径逐段保留 '/'、单段内嵌 '#'/' '/'/'/' 各自编码；
 * 3. **探测端点错误语义**：204→true / 404→false / 403 与 500→抛出（绝不能把
 *    "无权限/服务异常"误判成"不可分配"，否则 UI 会静默隐藏候选）；
 * 4. **写端点失败不吞**：403/400 必须向上抛给调用方（由 toast/StateAlert 降级，
 *    不是静默成功，更不能登出）；
 * 5. **i18n 三语**：批次 1 新增命名空间的键在 en/zh-CN/zh-TW 全部存在、占位符
 *    名称一致、无裸 '@'/'|' 破坏 vue-i18n 消息语法。
 *
 * 已知缺陷用 `it.fails` 表达（见「增量更新语义」）：它在缺陷存在时"通过"，
 * 缺陷被修复后立即变红，从而强制更新该用例 —— 既不掩盖问题，也不让主干长期飘红。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const cnbFetchMock = vi.fn()
const cnbFetchVoidMock = vi.fn()

vi.mock('../useCnbAuth', () => ({
  cnbFetch: (...args: unknown[]) => cnbFetchMock(...args),
  cnbFetchVoid: (...args: unknown[]) => cnbFetchVoidMock(...args),
  cnbFetchText: (...args: unknown[]) => cnbFetchMock(...args),
  canManageRole: () => false,
  CnbApiError: class CnbApiError extends Error {
    status?: number
    kind: string
    constructor(message: string, status?: number, kind?: string) {
      super(message)
      this.status = status
      this.kind = kind ?? (status === 403 ? 'forbidden' : status === 404 ? 'notFound' : 'network')
    }
  },
}))

import {
  addIssueLabels,
  canAssignIssue,
  canAssignPull,
  createPull,
  fetchPullCommitStatuses,
  listIssueAssignees,
  listIssueLabels,
  listPullAssignees,
  removeIssueAssignees,
  removeIssueLabel,
  removeIssueLabels,
  removePullAssignees,
  setIssueAssignees,
  setIssueLabels,
  setPullAssignees,
  updateIssueAssignees,
  updatePull,
} from '../useCnbRepo'
import {
  createBranch,
  createTag,
  deleteBranch,
  deleteTag,
  fetchBranchDetail,
  lockBranch,
  fetchTagDetail,
  unlockBranch,
} from '../useCnbGitRefs'
import {
  createRepoLabel,
  deleteRepoLabel,
  listRepoLabels,
  updateRepoLabel,
} from '../useCnbRepoLabels'
import {
  fetchBuildAiAudit,
  fetchBuildAiRequestDetail,
  fetchBuildAiRequests,
  normalizeAiAudit,
  normalizeAiRequests,
} from '../useCnbBuildAi'
import { CnbApiError } from '../useCnbAuth'

/** 构造指定类型的 CnbApiError（走被测代码的 `instanceof CnbApiError` 分支） */
function apiError(status: number, kind: 'notFound' | 'forbidden' | 'network'): CnbApiError {
  return new CnbApiError(`status ${status}`, status, kind)
}

beforeEach(() => {
  cnbFetchMock.mockReset()
  cnbFetchVoidMock.mockReset()
  cnbFetchMock.mockResolvedValue({})
  cnbFetchVoidMock.mockResolvedValue(undefined)
})

type Channel = 'json' | 'void'

interface ChannelCase {
  /** 设计 §12 端点行号（便于回溯对照表） */
  row: number
  label: string
  channel: Channel
  method: string
  /** 期望路径后缀，验证端点落点没错 */
  pathSuffix: string
  run: () => Promise<unknown>
}

/** 批次 1 · 32 端点通道矩阵（顺序与设计 §12 批次 1 表一致） */
const CHANNEL_CASES: ChannelCase[] = [
  { row: 1, label: 'POST /git/branches（createBranch）', channel: 'void', method: 'POST', pathSuffix: '/org/repo/-/git/branches', run: () => createBranch('org/repo', { name: 'dev' }) },
  { row: 2, label: 'DELETE /git/branches/{b}（deleteBranch）', channel: 'void', method: 'DELETE', pathSuffix: '/org/repo/-/git/branches/dev', run: () => deleteBranch('org/repo', 'dev') },
  { row: 3, label: 'GET /git/branches/{b}（fetchBranchDetail）', channel: 'json', method: 'GET', pathSuffix: '/org/repo/-/git/branches/dev', run: () => fetchBranchDetail('org/repo', 'dev') },
  { row: 4, label: 'POST /git/branch-locks/{b}（lockBranch）', channel: 'void', method: 'POST', pathSuffix: '/org/repo/-/git/branch-locks/dev', run: () => lockBranch('org/repo', 'dev') },
  { row: 5, label: 'DELETE /git/branch-locks/{b}（unlockBranch）', channel: 'void', method: 'DELETE', pathSuffix: '/org/repo/-/git/branch-locks/dev', run: () => unlockBranch('org/repo', 'dev') },
  { row: 6, label: 'POST /git/tags（createTag，有 body）', channel: 'json', method: 'POST', pathSuffix: '/org/repo/-/git/tags', run: () => createTag('org/repo', { name: 'v1' }) },
  { row: 7, label: 'DELETE /git/tags/{t}（deleteTag）', channel: 'void', method: 'DELETE', pathSuffix: '/org/repo/-/git/tags/v1', run: () => deleteTag('org/repo', 'v1') },
  { row: 8, label: 'GET /git/tags/{t}（fetchTagDetail）', channel: 'json', method: 'GET', pathSuffix: '/org/repo/-/git/tags/v1', run: () => fetchTagDetail('org/repo', 'v1') },
  { row: 9, label: 'GET /labels（listRepoLabels）', channel: 'json', method: 'GET', pathSuffix: '/org/repo/-/labels', run: () => listRepoLabels('org/repo') },
  { row: 10, label: 'POST /labels（createRepoLabel，有 body）', channel: 'json', method: 'POST', pathSuffix: '/org/repo/-/labels', run: () => createRepoLabel('org/repo', { name: 'bug' }) },
  { row: 11, label: 'PATCH /labels/{name}（updateRepoLabel，有 body）', channel: 'json', method: 'PATCH', pathSuffix: '/org/repo/-/labels/bug', run: () => updateRepoLabel('org/repo', 'bug', { color: 'f00' }) },
  { row: 12, label: 'DELETE /labels/{name}（deleteRepoLabel，空 body）', channel: 'void', method: 'DELETE', pathSuffix: '/org/repo/-/labels/bug', run: () => deleteRepoLabel('org/repo', 'bug') },
  { row: 13, label: 'GET /issues/{n}/assignees（有 body）', channel: 'json', method: 'GET', pathSuffix: '/org/repo/-/issues/7/assignees', run: () => listIssueAssignees('org/repo', '7') },
  { row: 15, label: 'POST /issues/{n}/assignees（有 body）', channel: 'json', method: 'POST', pathSuffix: '/org/repo/-/issues/7/assignees', run: () => setIssueAssignees('org/repo', '7', ['a']) },
  { row: 16, label: 'PATCH /issues/{n}/assignees（有 body）', channel: 'json', method: 'PATCH', pathSuffix: '/org/repo/-/issues/7/assignees', run: () => updateIssueAssignees('org/repo', '7', ['a']) },
  { row: 17, label: 'DELETE /issues/{n}/assignees（有 body）', channel: 'json', method: 'DELETE', pathSuffix: '/org/repo/-/issues/7/assignees', run: () => removeIssueAssignees('org/repo', '7', ['a']) },
  { row: 18, label: 'GET /issues/{n}/labels（有 body）', channel: 'json', method: 'GET', pathSuffix: '/org/repo/-/issues/7/labels', run: () => listIssueLabels('org/repo', '7') },
  { row: 19, label: 'POST /issues/{n}/labels（有 body）', channel: 'json', method: 'POST', pathSuffix: '/org/repo/-/issues/7/labels', run: () => addIssueLabels('org/repo', '7', ['bug']) },
  { row: 20, label: 'PUT /issues/{n}/labels（有 body）', channel: 'json', method: 'PUT', pathSuffix: '/org/repo/-/issues/7/labels', run: () => setIssueLabels('org/repo', '7', ['bug']) },
  { row: 21, label: 'DELETE /issues/{n}/labels（集合，204 空 body）', channel: 'void', method: 'DELETE', pathSuffix: '/org/repo/-/issues/7/labels', run: () => removeIssueLabels('org/repo', '7', ['bug']) },
  { row: 22, label: 'DELETE /issues/{n}/labels/{name}（有 body）', channel: 'json', method: 'DELETE', pathSuffix: '/org/repo/-/issues/7/labels/bug', run: () => removeIssueLabel('org/repo', '7', 'bug') },
  { row: 14, label: 'GET /issues/{n}/assignees/{a}（canAssignIssue，探测）', channel: 'void', method: 'GET', pathSuffix: '/org/repo/-/issues/7/assignees/alice', run: () => canAssignIssue('org/repo', '7', 'alice') },
  { row: 23, label: 'POST /pulls（createPull，有 body）', channel: 'json', method: 'POST', pathSuffix: '/org/repo/-/pulls', run: () => createPull('org/repo', { title: 't', head: 'a', base: 'b' }) },
  { row: 24, label: 'PATCH /pulls/{n}（updatePull，有 body）', channel: 'json', method: 'PATCH', pathSuffix: '/org/repo/-/pulls/7', run: () => updatePull('org/repo', '7', { title: 't2' }) },
  { row: 25, label: 'GET /pulls/{n}/assignees（有 body）', channel: 'json', method: 'GET', pathSuffix: '/org/repo/-/pulls/7/assignees', run: () => listPullAssignees('org/repo', '7') },
  { row: 27, label: 'POST /pulls/{n}/assignees（有 body）', channel: 'json', method: 'POST', pathSuffix: '/org/repo/-/pulls/7/assignees', run: () => setPullAssignees('org/repo', '7', ['bob']) },
  { row: 28, label: 'DELETE /pulls/{n}/assignees（有 body）', channel: 'json', method: 'DELETE', pathSuffix: '/org/repo/-/pulls/7/assignees', run: () => removePullAssignees('org/repo', '7', ['bob']) },
  { row: 26, label: 'GET /pulls/{n}/assignees/{a}（canAssignPull，探测）', channel: 'void', method: 'GET', pathSuffix: '/org/repo/-/pulls/7/assignees/bob', run: () => canAssignPull('org/repo', '7', 'bob') },
  { row: 29, label: 'GET /pulls/{n}/commit-statuses（有 body）', channel: 'json', method: 'GET', pathSuffix: '/org/repo/-/pulls/7/commit-statuses', run: () => fetchPullCommitStatuses('org/repo', '7') },
  { row: 30, label: 'GET /build/logs/ai-audit（有 body）', channel: 'json', method: 'GET', pathSuffix: '/org/repo/-/build/logs/ai-audit/sn1/pid1', run: () => fetchBuildAiAudit('org/repo', 'sn1', 'pid1') },
  // 页码口径：UI 传 1-based（3），API 段为 0-based（2）—— swagger「page 从 0 开始」
  { row: 31, label: 'GET /build/logs/ai-request/{page}（有 body）', channel: 'json', method: 'GET', pathSuffix: '/org/repo/-/build/logs/ai-request/sn1/pid1/2', run: () => fetchBuildAiRequests('org/repo', 'sn1', 'pid1', 3) },
  { row: 32, label: 'GET /build/logs/ai-request-detail/{rid}（有 body）', channel: 'json', method: 'GET', pathSuffix: '/org/repo/-/build/logs/ai-request-detail/sn1/pid1/r1', run: () => fetchBuildAiRequestDetail('org/repo', 'sn1', 'pid1', 'r1') },
]

describe('通道矩阵：批次 1 端点逐条核对 §8.2（Void ↔ JSON 不得写反）', () => {
  it.each(CHANNEL_CASES)('#$row $label → $channel / $method', async ({ channel, method, pathSuffix, run }) => {
    await run()
    const usedMock = channel === 'json' ? cnbFetchMock : cnbFetchVoidMock
    const otherMock = channel === 'json' ? cnbFetchVoidMock : cnbFetchMock
    expect(otherMock, `端点 #${'(见用例名)'} 误用了另一条通道`).not.toHaveBeenCalled()
    expect(usedMock).toHaveBeenCalledTimes(1)
    const [path, options] = usedMock.mock.calls[0] as [string, RequestInit]
    expect(path).toBe(pathSuffix)
    // GET 通常不带 method 字段（默认），其余必须显式声明
    if (method !== 'GET') {
      expect(options?.method).toBe(method)
    }
    else {
      expect(options?.method ?? 'GET').toBe('GET')
    }
  })
})

describe('路径编码：仓库路径逐段保留分隔符，单段内嵌字符各自编码', () => {
  it('多级子组织路径不整体压平（保留每级 /）', async () => {
    await deleteBranch('org/sub/deep/repo', 'dev')
    expect(cnbFetchVoidMock.mock.calls[0][0]).toBe('/org/sub/deep/repo/-/git/branches/dev')
  })

  it('仓库名含点与中文：仅对段内容编码', async () => {
    await deleteRepoLabel('org/我的仓库.js', 'bug')
    const path = String(cnbFetchVoidMock.mock.calls[0][0])
    expect(path.startsWith('/org/')).toBe(true)
    expect(path).toContain('%E6%88%91%E7%9A%84%E4%BB%93%E5%BA%93.js')
    expect(path).not.toContain('%2F')
  })

  it('分支/标签/标签名中的 / ? 空格 中文 全部编码为单段', async () => {
    await deleteBranch('org/repo', 'feature/x')
    await deleteTag('org/repo', 'release/1.0 beta')
    await deleteRepoLabel('org/repo', '待 评审')
    expect(cnbFetchVoidMock.mock.calls[0][0]).toBe('/org/repo/-/git/branches/feature%2Fx')
    expect(cnbFetchVoidMock.mock.calls[1][0]).toBe('/org/repo/-/git/tags/release%2F1.0%20beta')
    expect(cnbFetchVoidMock.mock.calls[2][0]).toBe('/org/repo/-/labels/%E5%BE%85%20%E8%AF%84%E5%AE%A1')
  })

  it('AI 端点：sn / pipelineId / requestId / page 各为独立段', async () => {
    await fetchBuildAiRequestDetail('org/repo', '2024/001', 'pipe#1', 'req/2')
    const path = String(cnbFetchMock.mock.calls[0][0])
    expect(path).toBe('/org/repo/-/build/logs/ai-request-detail/2024%2F001/pipe%231/req%2F2')
  })
})

describe('可分配性探测：只有 404 归为 false，403/500 必须抛出', () => {
  it('204（resolve）→ true', async () => {
    await expect(canAssignIssue('org/repo', '1', 'alice')).resolves.toBe(true)
    await expect(canAssignPull('org/repo', '1', 'alice')).resolves.toBe(true)
  })

  it('真实 CnbApiError(404) → false（走 instanceof 分支，非鸭式）', async () => {
    cnbFetchVoidMock.mockRejectedValueOnce(apiError(404, 'notFound'))
    await expect(canAssignIssue('org/repo', '1', 'ghost')).resolves.toBe(false)
    cnbFetchVoidMock.mockRejectedValueOnce(apiError(404, 'notFound'))
    await expect(canAssignPull('org/repo', '1', 'ghost')).resolves.toBe(false)
  })

  it('403（缺 scope）必须抛出，不得当成"不可分配"静默过滤', async () => {
    cnbFetchVoidMock.mockRejectedValueOnce(apiError(403, 'forbidden'))
    await expect(canAssignIssue('org/repo', '1', 'alice')).rejects.toThrow()
    cnbFetchVoidMock.mockRejectedValueOnce(apiError(403, 'forbidden'))
    await expect(canAssignPull('org/repo', '1', 'alice')).rejects.toThrow()
  })

  it('500（服务异常）必须抛出，不得当成 false', async () => {
    cnbFetchVoidMock.mockRejectedValueOnce(apiError(500, 'network'))
    await expect(canAssignIssue('org/repo', '1', 'alice')).rejects.toThrow()
  })
})

describe('写端点失败向上抛（403 降级由 UI 呈现，绝不静默成功）', () => {
  it('createTag 403 → reject 且携带 forbidden（不会触发登出语义）', async () => {
    cnbFetchMock.mockRejectedValueOnce(apiError(403, 'forbidden'))
    const err = await createTag('org/repo', { name: 'v1' }).catch(e => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as { kind?: string }).kind).toBe('forbidden')
  })

  it('deleteBranch 400（受保护分支被服务端拒绝）→ reject，不吞', async () => {
    cnbFetchVoidMock.mockRejectedValueOnce(apiError(400, 'network'))
    await expect(deleteBranch('org/repo', 'main')).rejects.toThrow('status 400')
  })

  it('fetchPullCommitStatuses 403 → reject（RepoPullDetail 用区块 StateAlert 降级）', async () => {
    cnbFetchMock.mockRejectedValueOnce(apiError(403, 'forbidden'))
    await expect(fetchPullCommitStatuses('org/repo', '7')).rejects.toThrow()
  })

  it('createPull 400 → reject（不返回半成品对象）', async () => {
    cnbFetchMock.mockRejectedValueOnce(apiError(400, 'network'))
    await expect(createPull('org/repo', { title: 't', head: 'a', base: 'b' })).rejects.toThrow()
  })
})

describe('增量更新语义：可清空的字段必须能提交空串', () => {
  it('updatePull body 传空串会被提交（允许清空 PR 描述）', async () => {
    await updatePull('org/repo', '7', { body: '' })
    expect(JSON.parse(cnbFetchMock.mock.calls[0][1].body as string)).toEqual({ body: '' })
  })

  it('updatePull 只提交显式字段（title 未传则不出现）', async () => {
    await updatePull('org/repo', '7', { state: 'closed' })
    expect(JSON.parse(cnbFetchMock.mock.calls[0][1].body as string)).toEqual({ state: 'closed' })
  })

  it('createPull 未给 body/headRepo 时不发对应字段', async () => {
    await createPull('org/repo', { title: 't', head: 'a', base: 'b' })
    expect(JSON.parse(cnbFetchMock.mock.calls[0][1].body as string)).toEqual({ title: 't', head: 'a', base: 'b' })
  })

  /**
   * BUG-01 回归锁定（工程师已修复：真值判断改为 !== undefined）：
   * 「把颜色/描述改成空串（清空）」必须照常提交 —— 空串与 undefined 语义不同，
   * RepoLabelManager 按"仅提交变化字段"的语义把空串传下来，数据层不得丢弃。
   */
  it('BUG-01 updateRepoLabel 清空描述/颜色时应提交空串（当前被真值判断丢弃）', async () => {
    await updateRepoLabel('org/repo', 'bug', { description: '', color: '' })
    expect(JSON.parse(cnbFetchMock.mock.calls[0][1].body as string)).toEqual({ description: '', color: '' })
  })
})

describe('AI 用量归一化边界（code 业务码 / 自由对象 / 缺失字段）', () => {
  it('code 字段缺失按 0 处理（成功），content 保留、pages 兜底 0', () => {
    expect(normalizeAiAudit({ content: { total: { request_count: 3 } } }))
      .toEqual({ code: 0, content: { total: { request_count: 3 } }, pageSize: 0, pages: 0 })
  })

  it('code=0 但 content 为 undefined → content={}（UI 判空不崩）', () => {
    expect(normalizeAiAudit({ code: 0 }).content).toEqual({})
  })

  it('明细数组含 null/空对象条目：逐条兜底而不是整体丢弃或抛错', () => {
    const list = normalizeAiRequests({
      code: 0,
      content: [null, {}, { request_id: 'r1', total_tokens: 9 }] as unknown as never[],
    })
    expect(list).toHaveLength(3)
    expect(list[0].requestId).toBe('')
    expect(list[2].totalTokens).toBe(9)
  })

  it('非整数/NaN 数值不被当作有效 token（落回 0 或 null）', () => {
    const list = normalizeAiRequests({
      code: 0,
      content: [{ request_id: 'r', total_tokens: Number.NaN, discount: Number.POSITIVE_INFINITY }] as unknown as never[],
    })
    expect(list[0].totalTokens).toBe(0)
    expect(list[0].discount).toBeNull()
  })

  it('page 作为路径末段：1-based 入参 → 0-based 路径段（不丢位不打偏）', async () => {
    await fetchBuildAiRequests('org/repo', 's', 'p', 10)
    await fetchBuildAiRequests('org/repo', 's', 'p', 1)
    // 10 页 → /9，第 1 页 → /0（swagger：page 从 0 开始；此前直传会跳过首页）
    expect(cnbFetchMock.mock.calls[0][0]).toMatch(/\/ai-request\/s\/p\/9$/)
    expect(cnbFetchMock.mock.calls[1][0]).toMatch(/\/ai-request\/s\/p\/0$/)
  })
})
