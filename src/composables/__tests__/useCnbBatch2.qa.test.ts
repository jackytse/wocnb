/**
 * 批次 2（P1 / REQ-07~11 / T08~T17 / 39 端点）QA 独立验收单测 —— 与工程师自验
 * 用例（useCnbPullReviews.test.ts 等）互为补充，不复用其断言写法：
 *
 * 1. **通道矩阵**：把设计 §12 批次 2 表的 39 行逐条落成一张表，每行断言
 *    「哪个通道（cnbFetch=JSON / cnbFetchVoid=空体）被调用 + HTTP 方法 + 路径落点」，
 *    任何一行通道写反（Void↔JSON）都会精确指出是哪一行 —— 这是批次 1 实测
 *    最高频的缺陷类型（空 body 走 JSON 通道会抛 "Unexpected end of JSON input"）；
 * 2. **编码形态**：批次 2 两个"互为镜像"的特例必须同时锁定 ——
 *    deleteTagAnnotation（`tag/key` 单段内嵌斜杠，整体编码 → %2F）与
 *    deleteCommitAnnotation（sha/key 两个独立段，分别编码、'/' 保留），
 *    任何一边写错都是 404；多级仓库路径逐段编码保留 '/'；
 * 3. **请求体形态**：snake_case 字段名（reply_to_comment_id / access_level /
 *    is_outside_collaborator / commit_hashes）、可选字段不滥发（空串语义不同）；
 * 4. **错误不吞**：写端点 403/500 必须向上抛（UI 靠它降级提示，静默成功 = 假成功）；
 * 5. **buildReviewThreads 边界**（T16 验收点）：三层回复链归并、孤儿回复降级
 *    顶层不丢失、环状引用链 10 层上限不死循环、输出顺序稳定；
 * 6. **属性更新结果归一化**：HTTP 200 ≠ 全部成功，failed_count 缺失时回退
 *    failed_keys 长度（N2"假成功"陷阱）；
 * 7. **useRepoRoute 评审下钻键**（批次 2 新增）：review/rcomment 归一与联动、
 *    openReview/closeReview/openReviewComment 的 push 语义、switchTab 显式
 *    清空评审下钻键（防跨页签残留）。
 *
 * 本文件只测"数据层契约"，UI 挂载与三语文案分别由组件审查与
 * locales/__tests__/batch2-keys.qa.test.ts 覆盖。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const cnbFetchMock = vi.fn()
const cnbFetchVoidMock = vi.fn()

vi.mock('../useCnbAuth', () => ({
  cnbFetch: (...args: unknown[]) => cnbFetchMock(...args),
  cnbFetchVoid: (...args: unknown[]) => cnbFetchVoidMock(...args),
  cnbFetchText: (...args: unknown[]) => cnbFetchMock(...args),
  // useCnbMembers 归一化头像会调用（与通道矩阵无关，桩掉即可）
  cnbAvatarUrl: (username: string) => `https://avatar.cnb.cool/${username}.png`,
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

// useRepoRoute 的 vue-router 假对象（与 useRepoRoute.test.ts 同范式但独立搭建，
// 不共享 mock 实例，避免"自证式测试"）
const routerPush = vi.fn()
const routerReplace = vi.fn()
const routeState = {
  path: '/repos/org/repo',
  params: { repoPath: ['org', 'repo'] } as Record<string, string | string[]>,
  query: {} as Record<string, string>,
}
vi.mock('vue-router', () => ({
  useRoute: () => routeState,
  useRouter: () => ({
    push: (...args: unknown[]) => routerPush(...args),
    replace: (...args: unknown[]) => routerReplace(...args),
  }),
}))

import { CnbApiError } from '../useCnbAuth'
import {
  createEmptyBranchProtection,
  createRepoBranchProtection,
  deleteRepoBranchProtection,
  fetchRepoBranchProtection,
  fetchRepoBranchProtections,
  updateRepoBranchProtection,
} from '../useCnbBranchProtections'
import {
  deleteCommitAnnotation,
  deleteTagAnnotation,
  listCommitAnnotations,
  listCommitAnnotationsBatch,
  listTagAnnotations,
  putCommitAnnotations,
  putTagAnnotations,
} from '../useCnbAnnotations'
import {
  addRepoMember,
  fetchAllMembers,
  fetchRepoInheritMembers,
  fetchRepoMemberAccessLevel,
  fetchRepoMembers,
  fetchRepoMembersAccessLevel,
  removeRepoMember,
  updateRepoMemberRole,
} from '../useCnbMembers'
import {
  addPullLabels,
  addPullReviewers,
  buildReviewThreads,
  createPullReview,
  listPullLabels,
  listPullReviews,
  listReviewComments,
  removePullLabelByName,
  removePullLabels,
  removePullReviewers,
  replyReviewComment,
  setPullLabels,
  updatePullReview,
  updateReviewComment,
  type ReviewComment,
} from '../useCnbPullReviews'
import {
  fetchIssueComment,
  listIssueProperties,
  listRepoInvisibleProperties,
  listRepoProperties,
  updateIssueComment,
  updateIssueProperties,
} from '../useCnbRepo'
import { useRepoRoute } from '../useRepoRoute'

beforeEach(() => {
  cnbFetchMock.mockReset()
  cnbFetchVoidMock.mockReset()
  cnbFetchMock.mockResolvedValue({})
  cnbFetchVoidMock.mockResolvedValue(undefined)
  routerPush.mockClear()
  routerReplace.mockClear()
  routeState.params = { repoPath: ['org', 'repo'] }
  routeState.query = {}
})

type Channel = 'json' | 'void'

interface ChannelCase {
  /** 设计 §12 批次 2 端点行号（便于回溯对照表） */
  row: number
  label: string
  channel: Channel
  method: string
  /** 期望路径（多级仓库路径逐段编码、'/' 保留） */
  pathSuffix: string
  run: () => Promise<unknown>
}

/** 批次 2 · 39 端点通道矩阵（顺序与设计 §12 批次 2 表一致） */
const CHANNEL_CASES: ChannelCase[] = [
  // —— REQ-10 PR 评审（13） ——
  { row: 1, label: 'GET /pulls/{n}/reviews（listPullReviews）', channel: 'json', method: 'GET', pathSuffix: '/org/repo/-/pulls/5/reviews', run: () => listPullReviews('org/repo', '5') },
  { row: 2, label: 'GET /pulls/{n}/reviews/{rid}/comments（listReviewComments）', channel: 'json', method: 'GET', pathSuffix: '/org/repo/-/pulls/5/reviews/rv1/comments', run: () => listReviewComments('org/repo', '5', 'rv1') },
  { row: 3, label: 'GET /pulls/{n}/labels（listPullLabels）', channel: 'json', method: 'GET', pathSuffix: '/org/repo/-/pulls/5/labels', run: () => listPullLabels('org/repo', '5') },
  { row: 4, label: 'POST /pulls/{n}/reviews（createPullReview，201 空 body）', channel: 'void', method: 'POST', pathSuffix: '/org/repo/-/pulls/5/reviews', run: () => createPullReview('org/repo', '5', { event: 'approve' }) },
  { row: 5, label: 'PATCH /pulls/{n}/reviews/{rid}（updatePullReview，200 有 body）', channel: 'json', method: 'PATCH', pathSuffix: '/org/repo/-/pulls/5/reviews/rv1', run: () => updatePullReview('org/repo', '5', 'rv1', 'edited') },
  { row: 6, label: 'PATCH …/comments/{cid}（updateReviewComment，200 有 body）', channel: 'json', method: 'PATCH', pathSuffix: '/org/repo/-/pulls/5/reviews/rv1/comments/c1', run: () => updateReviewComment('org/repo', '5', 'rv1', 'c1', 'edited') },
  { row: 7, label: 'POST …/reviews/{rid}/replies（replyReviewComment，201 有 body）', channel: 'json', method: 'POST', pathSuffix: '/org/repo/-/pulls/5/reviews/rv1/replies', run: () => replyReviewComment('org/repo', '5', 'rv1', { body: 'reply', replyToCommentId: 'c1' }) },
  { row: 8, label: 'POST /pulls/{n}/reviewers（addPullReviewers，201 api.Pull）', channel: 'json', method: 'POST', pathSuffix: '/org/repo/-/pulls/5/reviewers', run: () => addPullReviewers('org/repo', '5', ['u1']) },
  { row: 9, label: 'DELETE /pulls/{n}/reviewers（removePullReviewers，带 body + 200）', channel: 'json', method: 'DELETE', pathSuffix: '/org/repo/-/pulls/5/reviewers', run: () => removePullReviewers('org/repo', '5', ['u1']) },
  { row: 10, label: 'PUT /pulls/{n}/labels（setPullLabels，200 有 body）', channel: 'json', method: 'PUT', pathSuffix: '/org/repo/-/pulls/5/labels', run: () => setPullLabels('org/repo', '5', ['bug']) },
  { row: 11, label: 'POST /pulls/{n}/labels（addPullLabels，200 有 body）', channel: 'json', method: 'POST', pathSuffix: '/org/repo/-/pulls/5/labels', run: () => addPullLabels('org/repo', '5', ['bug']) },
  { row: 12, label: 'DELETE /pulls/{n}/labels（removePullLabels，204 空 body）', channel: 'void', method: 'DELETE', pathSuffix: '/org/repo/-/pulls/5/labels', run: () => removePullLabels('org/repo', '5') },
  { row: 13, label: 'DELETE /pulls/{n}/labels/{name}（removePullLabelByName，200 有 body）', channel: 'json', method: 'DELETE', pathSuffix: '/org/repo/-/pulls/5/labels/bug', run: () => removePullLabelByName('org/repo', '5', 'bug') },
  // —— REQ-08 注解（7） ——
  { row: 14, label: 'GET /git/tag-annotations/{tag}（listTagAnnotations）', channel: 'json', method: 'GET', pathSuffix: '/org/repo/-/git/tag-annotations/v1', run: () => listTagAnnotations('org/repo', 'v1') },
  { row: 15, label: 'PUT /git/tag-annotations/{tag}（putTagAnnotations，200 空 body）', channel: 'void', method: 'PUT', pathSuffix: '/org/repo/-/git/tag-annotations/v1', run: () => putTagAnnotations('org/repo', 'v1', []) },
  { row: 16, label: 'DELETE /git/tag-annotations/{tag_with_key}（deleteTagAnnotation，空 body）', channel: 'void', method: 'DELETE', pathSuffix: '/org/repo/-/git/tag-annotations/v1.0%2Fci', run: () => deleteTagAnnotation('org/repo', 'v1.0', 'ci') },
  { row: 17, label: 'GET /git/commit-annotations/{sha}（listCommitAnnotations）', channel: 'json', method: 'GET', pathSuffix: '/org/repo/-/git/commit-annotations/abc123', run: () => listCommitAnnotations('org/repo', 'abc123') },
  { row: 18, label: 'PUT /git/commit-annotations/{sha}（putCommitAnnotations，空 body）', channel: 'void', method: 'PUT', pathSuffix: '/org/repo/-/git/commit-annotations/abc123', run: () => putCommitAnnotations('org/repo', 'abc123', []) },
  { row: 19, label: 'DELETE /git/commit-annotations/{sha}/{key}（deleteCommitAnnotation，空 body）', channel: 'void', method: 'DELETE', pathSuffix: '/org/repo/-/git/commit-annotations/abc123/ci%20key', run: () => deleteCommitAnnotation('org/repo', 'abc123', 'ci key') },
  { row: 20, label: 'POST /git/commit-annotations-in-batch（listCommitAnnotationsBatch）', channel: 'json', method: 'POST', pathSuffix: '/org/repo/-/git/commit-annotations-in-batch', run: () => listCommitAnnotationsBatch('org/repo', ['a', 'b']) },
  // —— REQ-07 仓库级保护分支（5） ——
  { row: 21, label: 'GET /{repo}/-/settings/branch-protections（fetchRepoBranchProtections）', channel: 'json', method: 'GET', pathSuffix: '/org/repo/-/settings/branch-protections', run: () => fetchRepoBranchProtections('org/repo') },
  { row: 22, label: 'GET …/branch-protections/{id}（fetchRepoBranchProtection）', channel: 'json', method: 'GET', pathSuffix: '/org/repo/-/settings/branch-protections/p1', run: () => fetchRepoBranchProtection('org/repo', 'p1') },
  { row: 23, label: 'POST …/branch-protections（createRepoBranchProtection，201 空 body）', channel: 'void', method: 'POST', pathSuffix: '/org/repo/-/settings/branch-protections', run: () => createRepoBranchProtection('org/repo', createEmptyBranchProtection()) },
  { row: 24, label: 'PATCH …/branch-protections/{id}（updateRepoBranchProtection，200 空 body）', channel: 'void', method: 'PATCH', pathSuffix: '/org/repo/-/settings/branch-protections/p1', run: () => updateRepoBranchProtection('org/repo', 'p1', createEmptyBranchProtection()) },
  { row: 25, label: 'DELETE …/branch-protections/{id}（deleteRepoBranchProtection，200 空 body）', channel: 'void', method: 'DELETE', pathSuffix: '/org/repo/-/settings/branch-protections/p1', run: () => deleteRepoBranchProtection('org/repo', 'p1') },
  // —— REQ-11 仓库成员（8） ——
  { row: 26, label: 'GET /{repo}/-/members（fetchRepoMembers）', channel: 'json', method: 'GET', pathSuffix: '/org/repo/-/members?page=1&page_size=50', run: () => fetchRepoMembers('org/repo') },
  { row: 27, label: 'POST /{repo}/-/members/{u}（addRepoMember，200 空 body）', channel: 'void', method: 'POST', pathSuffix: '/org/repo/-/members/u1', run: () => addRepoMember('org/repo', 'u1', 'Developer') },
  { row: 28, label: 'PUT /{repo}/-/members/{u}（updateRepoMemberRole，200 空 body）', channel: 'void', method: 'PUT', pathSuffix: '/org/repo/-/members/u1', run: () => updateRepoMemberRole('org/repo', 'u1', 'Master') },
  { row: 29, label: 'DELETE /{repo}/-/members/{u}（removeRepoMember，200 空 body）', channel: 'void', method: 'DELETE', pathSuffix: '/org/repo/-/members/u1', run: () => removeRepoMember('org/repo', 'u1') },
  { row: 30, label: 'GET …/members/access-level（fetchRepoMembersAccessLevel）', channel: 'json', method: 'GET', pathSuffix: '/org/repo/-/members/access-level?include_inherit=true', run: () => fetchRepoMembersAccessLevel('org/repo', true) },
  { row: 31, label: 'GET …/members/{u}/access-level（fetchRepoMemberAccessLevel）', channel: 'json', method: 'GET', pathSuffix: '/org/repo/-/members/u1/access-level', run: () => fetchRepoMemberAccessLevel('org/repo', 'u1') },
  { row: 32, label: 'GET /{repo}/-/list-members（fetchAllMembers）', channel: 'json', method: 'GET', pathSuffix: '/org/repo/-/list-members', run: () => fetchAllMembers('org/repo') },
  { row: 33, label: 'GET /{repo}/-/inherit-members（fetchRepoInheritMembers）', channel: 'json', method: 'GET', pathSuffix: '/org/repo/-/inherit-members', run: () => fetchRepoInheritMembers('org/repo') },
  // —— REQ-09 Issue 属性 / 评论编辑（6） ——
  { row: 34, label: 'GET /issues/{n}/comments/{cid}（fetchIssueComment）', channel: 'json', method: 'GET', pathSuffix: '/org/repo/-/issues/7/comments/c9', run: () => fetchIssueComment('org/repo', '7', 'c9') },
  { row: 35, label: 'PATCH /issues/{n}/comments/{cid}（updateIssueComment，200 有 body）', channel: 'json', method: 'PATCH', pathSuffix: '/org/repo/-/issues/7/comments/c9', run: () => updateIssueComment('org/repo', '7', 'c9', 'edited') },
  { row: 36, label: 'GET /issues/{n}/property（listIssueProperties）', channel: 'json', method: 'GET', pathSuffix: '/org/repo/-/issues/7/property', run: () => listIssueProperties('org/repo', '7') },
  { row: 37, label: 'PATCH /issues/{n}/property（updateIssueProperties，200 有 body）', channel: 'json', method: 'PATCH', pathSuffix: '/org/repo/-/issues/7/property', run: () => updateIssueProperties('org/repo', '7', [{ key: 'k', value: 'v' }]) },
  { row: 38, label: 'GET /{repo}/-/property（listRepoProperties）', channel: 'json', method: 'GET', pathSuffix: '/org/repo/-/property', run: () => listRepoProperties('org/repo') },
  { row: 39, label: 'GET /{repo}/-/property/invisible（listRepoInvisibleProperties）', channel: 'json', method: 'GET', pathSuffix: '/org/repo/-/property/invisible', run: () => listRepoInvisibleProperties('org/repo') },
]

/** 从 mock 调用里取（路径, options）—— GET 可能没有 options */
function lastFetchCall(channel: Channel): { path: string, options?: Record<string, unknown> } {
  const mock = channel === 'json' ? cnbFetchMock : cnbFetchVoidMock
  expect(mock).toHaveBeenCalled()
  const calls = mock.mock.calls as unknown[][]
  const call = calls[calls.length - 1]
  return { path: call[0] as string, options: call[1] as Record<string, unknown> | undefined }
}

describe('批次 2 通道矩阵（39 端点，设计 §12）', () => {
  it.each(CHANNEL_CASES)('row $row：$label', async ({ channel, method, pathSuffix, run }) => {
    await run()
    const target = channel === 'json' ? cnbFetchMock : cnbFetchVoidMock
    const other = channel === 'json' ? cnbFetchVoidMock : cnbFetchMock
    // 通道互斥：走错通道（如空 body 走 JSON）必然抛 "Unexpected end of JSON input"
    expect(target).toHaveBeenCalledTimes(1)
    expect(other).not.toHaveBeenCalled()
    const call = lastFetchCall(channel)
    expect(call.path).toBe(pathSuffix)
    expect((call.options?.method as string | undefined) ?? 'GET').toBe(method)
  })

  it('通道分布统计：void 11 个 / json 28 个（与设计表逐行核对后的总量）', () => {
    const voidRows = CHANNEL_CASES.filter(row => row.channel === 'void')
    expect(voidRows.map(row => row.row)).toEqual([4, 12, 15, 16, 18, 19, 23, 24, 25, 27, 28, 29])
    expect(CHANNEL_CASES.length).toBe(39)
  })
})

describe('批次 2 路径编码形态', () => {
  it('deleteTagAnnotation：tag/key 单段整体编码，斜杠必须变 %2F', async () => {
    await deleteTagAnnotation('org/repo', 'v1.0', 'ci')
    const call = lastFetchCall('void')
    expect(call.path).toBe('/org/repo/-/git/tag-annotations/v1.0%2Fci')
    expect(call.path.split('/-/git/tag-annotations/')[1]).not.toContain('/')
  })

  it('deleteCommitAnnotation：sha 与 key 是两个独立段，分别编码、真实 / 保留', async () => {
    await deleteCommitAnnotation('org/repo', 'abc123', 'ci key')
    const call = lastFetchCall('void')
    expect(call.path).toBe('/org/repo/-/git/commit-annotations/abc123/ci%20key')
    const segments = call.path.split('/-/git/commit-annotations/')[1].split('/')
    expect(segments).toEqual(['abc123', 'ci%20key'])
  })

  it('多级仓库路径逐段编码且保留层级（org/sub/repo）', async () => {
    await fetchRepoBranchProtections('org/sub/repo')
    expect(cnbFetchMock.mock.calls[0][0]).toBe('/org/sub/repo/-/settings/branch-protections')
  })

  it('含空格的仓库路径段编码（%20），斜杠不被压扁', async () => {
    await fetchRepoMembers('my org/repo')
    expect(cnbFetchMock.mock.calls[0][0]).toBe('/my%20org/repo/-/members?page=1&page_size=50')
  })

  it('PR 标签名内嵌斜杠整体编码（按名删除单个标签）', async () => {
    await removePullLabelByName('org/repo', '5', 'a/b')
    expect(cnbFetchMock.mock.calls[0][0]).toBe('/org/repo/-/pulls/5/labels/a%2Fb')
  })

  it('成员用户名编码（含 URL 语义字符）', async () => {
    await removeRepoMember('org/repo', 'user/1')
    expect(cnbFetchVoidMock.mock.calls[0][0]).toBe('/org/repo/-/members/user%2F1')
  })
})

describe('批次 2 请求体形态（snake_case / 可选字段不滥发）', () => {
  it('createPullReview：只发 event；body 空串不发（空串会被当成"清空正文"）', async () => {
    await createPullReview('org/repo', '5', { event: 'approve' })
    expect(JSON.parse(cnbFetchVoidMock.mock.calls[0][1].body)).toEqual({ event: 'approve' })

    await createPullReview('org/repo', '5', { event: 'comment', body: '' })
    expect(JSON.parse(cnbFetchVoidMock.mock.calls[1][1].body)).toEqual({ event: 'comment' })

    await createPullReview('org/repo', '5', { event: 'comment', body: 'note', comments: [{ path: 'a.ts' }] })
    expect(JSON.parse(cnbFetchVoidMock.mock.calls[2][1].body)).toEqual({
      event: 'comment',
      body: 'note',
      comments: [{ path: 'a.ts' }],
    })
  })

  it('replyReviewComment：字段名是 reply_to_comment_id（snake_case）', async () => {
    await replyReviewComment('org/repo', '5', 'rv1', { body: 'r', replyToCommentId: 'c1' })
    const body = JSON.parse(cnbFetchMock.mock.calls[0][1].body)
    expect(body).toEqual({ body: 'r', reply_to_comment_id: 'c1' })
  })

  it('removePullReviewers：DELETE 带 body 且必须走 JSON 通道（返回 api.Pull）', async () => {
    await removePullReviewers('org/repo', '5', ['u1', 'u2'])
    const call = lastFetchCall('json')
    expect(call.options?.method).toBe('DELETE')
    expect(JSON.parse(call.options?.body as string)).toEqual({ reviewers: ['u1', 'u2'] })
  })

  it('addRepoMember / updateRepoMemberRole：access_level + 可选 is_outside_collaborator', async () => {
    await addRepoMember('org/repo', 'u1', 'Developer', { isOutsideCollaborator: true })
    expect(JSON.parse(cnbFetchVoidMock.mock.calls[0][1].body)).toEqual({
      access_level: 'Developer',
      is_outside_collaborator: true,
    })

    await updateRepoMemberRole('org/repo', 'u1', 'Master')
    expect(JSON.parse(cnbFetchVoidMock.mock.calls[1][1].body)).toEqual({ access_level: 'Master' })
  })

  it('成员写端点空参防御：空 repoPath / 空用户名直接抛错不发请求', async () => {
    await expect(addRepoMember('', 'u1', 'Developer')).rejects.toThrow()
    await expect(updateRepoMemberRole('org/repo', '', 'Developer')).rejects.toThrow()
    expect(cnbFetchVoidMock).not.toHaveBeenCalled()
    expect(cnbFetchMock).not.toHaveBeenCalled()
  })

  it('fetchRepoMembersAccessLevel：include_inherit 显式写入 query（true/false 两态）', async () => {
    await fetchRepoMembersAccessLevel('org/repo', true)
    expect(cnbFetchMock.mock.calls[0][0]).toBe('/org/repo/-/members/access-level?include_inherit=true')
    await fetchRepoMembersAccessLevel('org/repo', false)
    expect(cnbFetchMock.mock.calls[1][0]).toBe('/org/repo/-/members/access-level?include_inherit=false')
  })

  it('updateIssueProperties：payload 为 { properties: [{ key, value }] }', async () => {
    await updateIssueProperties('org/repo', '7', [
      { key: 'priority', value: 'high' },
      { key: 'due', value: '2025-01-01' },
    ])
    const call = lastFetchCall('json')
    expect(call.options?.method).toBe('PATCH')
    expect(JSON.parse(call.options?.body as string)).toEqual({
      properties: [{ key: 'priority', value: 'high' }, { key: 'due', value: '2025-01-01' }],
    })
  })

  it('updateIssueComment：PATCH body 为 { body }，字段名与创建评论一致', async () => {
    await updateIssueComment('org/repo', '7', 'c9', 'edited text')
    expect(JSON.parse(cnbFetchMock.mock.calls[0][1].body)).toEqual({ body: 'edited text' })
  })

  it('listCommitAnnotationsBatch：keys 非空才发送（空数组语义 ≠ 查全部）', async () => {
    cnbFetchMock.mockResolvedValueOnce([])
    await listCommitAnnotationsBatch('org/repo', ['a', 'b'], ['ci', 'owner'])
    expect(JSON.parse(cnbFetchMock.mock.calls[0][1].body)).toEqual({
      commit_hashes: ['a', 'b'],
      keys: ['ci', 'owner'],
    })

    cnbFetchMock.mockResolvedValueOnce([])
    await listCommitAnnotationsBatch('org/repo', ['a'])
    expect(JSON.parse(cnbFetchMock.mock.calls[1][1].body)).toEqual({ commit_hashes: ['a'] })
    expect(JSON.parse(cnbFetchMock.mock.calls[1][1].body)).not.toHaveProperty('keys')
  })

  it('putTagAnnotations / putCommitAnnotations：annotations 数组包一层，过滤空 key 条目', async () => {
    await putTagAnnotations('org/repo', 'v1', [
      { key: 'ci', value: 'pass', meta: {} },
      { key: '', value: 'dropped', meta: {} },
    ])
    expect(JSON.parse(cnbFetchVoidMock.mock.calls[0][1].body)).toEqual({
      annotations: [expect.objectContaining({ key: 'ci', value: 'pass' })],
    })
  })
})

describe('批次 2 错误语义：写失败不吞（403/500 向上抛）', () => {
  it('createPullReview 403 抛 CnbApiError（Void 通道同样不能吞错）', async () => {
    cnbFetchVoidMock.mockRejectedValueOnce(new CnbApiError('403', 403, 'forbidden'))
    await expect(createPullReview('org/repo', '5', { event: 'approve' })).rejects.toMatchObject({
      status: 403,
      kind: 'forbidden',
    })
  })

  it('addRepoMember 403 抛出；updateRepoMemberRole 500 抛出', async () => {
    cnbFetchVoidMock.mockRejectedValueOnce(new CnbApiError('403', 403, 'forbidden'))
    await expect(addRepoMember('org/repo', 'u1', 'Developer')).rejects.toBeInstanceOf(CnbApiError)

    cnbFetchVoidMock.mockRejectedValueOnce(new CnbApiError('500', 500, 'network'))
    await expect(updateRepoMemberRole('org/repo', 'u1', 'Master')).rejects.toBeInstanceOf(CnbApiError)
  })

  it('updateIssueProperties 403 抛出（JSON 通道）', async () => {
    cnbFetchMock.mockRejectedValueOnce(new CnbApiError('403', 403, 'forbidden'))
    await expect(updateIssueProperties('org/repo', '7', [])).rejects.toBeInstanceOf(CnbApiError)
  })

  it('createRepoBranchProtection 422（10 条上限）抛出', async () => {
    cnbFetchVoidMock.mockRejectedValueOnce(new CnbApiError('422', 422, 'network'))
    await expect(createRepoBranchProtection('org/repo', createEmptyBranchProtection())).rejects.toMatchObject({ status: 422 })
  })

  it('deleteTagAnnotation 403 抛出（空 body 删除端点同样不吞错）', async () => {
    cnbFetchVoidMock.mockRejectedValueOnce(new CnbApiError('403', 403, 'forbidden'))
    await expect(deleteTagAnnotation('org/repo', 'v1', 'ci')).rejects.toBeInstanceOf(CnbApiError)
  })
})

describe('批次 2 归一化语义', () => {
  it('updateIssueProperties：HTTP 200 ≠ 全部成功，failedCount 按服务端明细归一', async () => {
    cnbFetchMock.mockResolvedValueOnce({ success_count: 2, failed_count: 1, failed_keys: ['bad'] })
    const result = await updateIssueProperties('org/repo', '7', [])
    expect(result).toEqual({ successCount: 2, failedCount: 1, failedKeys: ['bad'] })
  })

  it('updateIssueProperties：failed_count 缺失时回退 failed_keys 长度（防"假成功"）', async () => {
    cnbFetchMock.mockResolvedValueOnce({ success_count: 1, failed_keys: ['a', 'b'] })
    const result = await updateIssueProperties('org/repo', '7', [])
    expect(result.failedCount).toBe(2)

    // 全部成功：failed_count=0 且无 failed_keys → 0
    cnbFetchMock.mockResolvedValueOnce({ success_count: 3, failed_count: 0, failed_keys: [] })
    const ok = await updateIssueProperties('org/repo', '7', [])
    expect(ok.failedCount).toBe(0)
    expect(ok.failedKeys).toEqual([])
  })

  it('listCommitAnnotationsBatch：空 hash 列表不发请求直接返回 []', async () => {
    const result = await listCommitAnnotationsBatch('org/repo', [])
    expect(result).toEqual([])
    expect(cnbFetchMock).not.toHaveBeenCalled()
  })

  it('listCommitAnnotationsBatch：缺失的 hash 补空条目，输出顺序与入参一致', async () => {
    cnbFetchMock.mockResolvedValueOnce([
      { commit_hash: 'bbb', annotations: [{ key: 'ci', value: 'pass' }] },
      { commit_hash: 'aaa', annotations: [{ key: 'owner', value: 'u1' }] },
    ])
    const result = await listCommitAnnotationsBatch('org/repo', ['aaa', 'bbb', 'ccc'])
    expect(result.map(item => item.commitHash)).toEqual(['aaa', 'bbb', 'ccc'])
    // meta 是归一化补的服务端透传位，这里只关心 key/value 形态
    expect(result[0].annotations).toEqual([expect.objectContaining({ key: 'owner', value: 'u1' })])
    expect(result[2].annotations).toEqual([])
  })

  it('listCommitAnnotationsBatch：非数组响应回退为逐 hash 空条目（不抛错）', async () => {
    cnbFetchMock.mockResolvedValueOnce(null)
    const result = await listCommitAnnotationsBatch('org/repo', ['a'])
    expect(result).toEqual([{ commitHash: 'a', annotations: [] }])
  })

  it('fetchRepoInheritMembers：{ user: {...} } 包裹与直排成员双兼容，total 缺失回退 users.length', async () => {
    cnbFetchMock.mockResolvedValueOnce([
      {
        inherit_path: 'org',
        total: 5,
        users: [{ user: { username: 'wrapped', access_level: 'Developer' } }, { username: 'direct', access_level: 'Guest' }],
      },
      { inherit_path: 'org/sub', users: [] },
    ])
    const groups = await fetchRepoInheritMembers('org/repo')
    expect(groups).toHaveLength(2)
    expect(groups[0].inheritPath).toBe('org')
    expect(groups[0].total).toBe(5)
    expect(groups[0].users.map(u => u.username)).toEqual(['wrapped', 'direct'])
    // total 缺失 → 回退为 users.length（空数组 → 0）
    expect(groups[1].total).toBe(0)
  })

  it('fetchRepoMemberAccessLevel：返回权限来源链（数组），空/非数组响应返回 []', async () => {
    cnbFetchMock.mockResolvedValueOnce([
      { access_level: 'Master' },
      { access_level: 'Developer（继承自组织）' },
      { access_level: '' },
    ])
    const levels = await fetchRepoMemberAccessLevel('org/repo', 'u1')
    expect(levels).toEqual(['Master', 'Developer（继承自组织）'])

    cnbFetchMock.mockResolvedValueOnce(null)
    expect(await fetchRepoMemberAccessLevel('org/repo', 'u1')).toEqual([])
  })

  it('fetchRepoMembersAccessLevel：单对象（无法识别）返回空 Map，UI 降级逐人加载', async () => {
    cnbFetchMock.mockResolvedValueOnce({ username: 'u1', access_level: 'Master' })
    const map = await fetchRepoMembersAccessLevel('org/repo', true)
    expect(map.size).toBe(0)
  })

  it('listIssueProperties：未知 type 归一为 string（保证表单有控件），空 key 条目丢弃', async () => {
    cnbFetchMock.mockResolvedValueOnce([
      { key: 'k1', name: '优先级', type: 'weird', value: 'x' },
      { key: '', type: 'date', value: '' },
    ])
    const props = await listIssueProperties('org/repo', '7')
    expect(props).toHaveLength(1)
    expect(props[0].type).toBe('string')
  })

  it('listRepoProperties / listRepoInvisibleProperties：仅路径后缀不同，返回可见性字段', async () => {
    cnbFetchMock.mockResolvedValueOnce([{ key: 'k', name: 'n', type: 'date', visible: true }])
    const visible = await listRepoProperties('org/repo')
    expect(cnbFetchMock.mock.calls[0][0]).toBe('/org/repo/-/property')
    expect(visible[0]).toEqual({ key: 'k', name: 'n', type: 'date', visible: true })

    cnbFetchMock.mockResolvedValueOnce([{ key: 'h', name: '隐藏', type: 'string', visible: false }])
    const hidden = await listRepoInvisibleProperties('org/repo')
    expect(cnbFetchMock.mock.calls[1][0]).toBe('/org/repo/-/property/invisible')
    expect(hidden[0].visible).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// buildReviewThreads（T16 验收点：三层回复 / 孤儿 / 环 / 顺序）
// ---------------------------------------------------------------------------

/** 构造一条行级评论（只填归并逻辑关心的字段） */
function comment(id: string, replyTo: string): ReviewComment {
  return {
    id,
    reviewId: 'rv1',
    body: `body of ${id}`,
    path: 'src/a.ts',
    subjectType: 'line',
    startLine: 1,
    endLine: 1,
    startSide: 'right',
    endSide: 'right',
    replyToCommentId: replyTo,
    reviewState: 'commented',
    author: 'u1',
    createdAt: '2025-01-01T00:00:00Z',
  }
}

describe('buildReviewThreads 归并边界', () => {
  it('顶层评论各自成线程，输出顺序与服务端一致', () => {
    const threads = buildReviewThreads([comment('a', ''), comment('b', '')])
    expect(threads).toHaveLength(2)
    expect(threads.map(t => t.root.id)).toEqual(['a', 'b'])
    expect(threads.every(t => t.replies.length === 0)).toBe(true)
  })

  it('两层回复：挂到对应 root 下；回复的回复（三层链）也归到同一 root', () => {
    const threads = buildReviewThreads([
      comment('a', ''),
      comment('a1', 'a'),
      comment('a2', 'a1'),
      comment('b', ''),
      comment('b1', 'b'),
    ])
    expect(threads).toHaveLength(2)
    expect(threads[0].root.id).toBe('a')
    expect(threads[0].replies.map(r => r.id)).toEqual(['a1', 'a2'])
    expect(threads[1].replies.map(r => r.id)).toEqual(['b1'])
  })

  it('乱序输入（回复先于顶层出现）仍正确归并', () => {
    const threads = buildReviewThreads([comment('a1', 'a'), comment('a', ''), comment('a2', 'a')])
    expect(threads).toHaveLength(1)
    expect(threads[0].root.id).toBe('a')
    expect(threads[0].replies.map(r => r.id)).toEqual(['a1', 'a2'])
  })

  it('孤儿回复（root 已被删除/分页截断）：降级为顶层条目，不凭空消失', () => {
    const threads = buildReviewThreads([comment('a1', 'deleted-root')])
    expect(threads).toHaveLength(1)
    expect(threads[0].root.id).toBe('a1')
    expect(threads[0].replies).toEqual([])
  })

  it('环状引用链（a→b→a）：10 层回溯上限兜底，不死循环、降级为顶层', () => {
    const threads = buildReviewThreads([comment('a', 'b'), comment('b', 'a')])
    // 链无法解析到顶层 → 两条都降级为顶层条目
    expect(threads).toHaveLength(2)
    expect(threads.map(t => t.root.id)).toEqual(['a', 'b'])
  })

  it('超长链（>10 层）：同样安全终止，降级顶层不挂错线程', () => {
    const list = [comment('c10', 'c9'), comment('c9', 'c8'), comment('c8', 'c7'), comment('c7', 'c6'),
      comment('c6', 'c5'), comment('c5', 'c4'), comment('c4', 'c3'), comment('c3', 'c2'),
      comment('c2', 'c1'), comment('c1', 'c0'), comment('c0', 'c-1')]
    const threads = buildReviewThreads(list)
    expect(threads.map(t => t.root.id)).toContain('c10')
    expect(threads.find(t => t.root.id === 'c10')?.replies).toEqual([])
  })

  it('空输入 → 空输出；无 id 的评论不参与索引但不崩溃', () => {
    expect(buildReviewThreads([])).toEqual([])
    const noId = { ...comment('x', ''), id: '' }
    expect(() => buildReviewThreads([noId, comment('a', '')])).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// useRepoRoute：评审下钻键（批次 2 新增，REQ-10）
// ---------------------------------------------------------------------------

describe('useRepoRoute 评审下钻（review / rcomment）', () => {
  it('review：字符串有值才归一；缺失/空串/非字符串 → 空串', () => {
    routeState.query = { review: 'rv1' }
    expect(useRepoRoute().review.value).toBe('rv1')

    routeState.query = {}
    expect(useRepoRoute().review.value).toBe('')

    routeState.query = { review: '' }
    expect(useRepoRoute().review.value).toBe('')

    routeState.query = { review: 5 as unknown as string }
    expect(useRepoRoute().review.value).toBe('')
  })

  it('rcomment 与 review 联动：review 缺失时 rcomment 丢弃（残链不展开评论）', () => {
    routeState.query = { review: 'rv1', rcomment: 'c1' }
    const route = useRepoRoute()
    expect(route.review.value).toBe('rv1')
    expect(route.rcomment.value).toBe('c1')

    // 只有 rcomment 没有 review → 丢弃
    routeState.query = { rcomment: 'c1' }
    expect(useRepoRoute().rcomment.value).toBe('')
  })

  it('openReview：push 且同时清 rcomment（换评审后旧评论定位失效）', () => {
    routeState.query = { review: 'rv1', rcomment: 'c1' }
    useRepoRoute().openReview('rv2')
    expect(routerReplace).not.toHaveBeenCalled()
    expect(routerPush).toHaveBeenCalledTimes(1)
    const arg = routerPush.mock.calls[0][0] as { query: Record<string, string> }
    expect(arg.query.review).toBe('rv2')
    expect(arg.query).not.toHaveProperty('rcomment')
  })

  it('closeReview：push 且同时清 review + rcomment', () => {
    routeState.query = { review: 'rv1', rcomment: 'c1', ptype: 'open' }
    useRepoRoute().closeReview()
    const arg = routerPush.mock.calls[0][0] as { query: Record<string, string> }
    expect(arg.query).not.toHaveProperty('review')
    expect(arg.query).not.toHaveProperty('rcomment')
    // 未覆盖的键保留（navigate 语义）
    expect(arg.query.ptype).toBe('open')
  })

  it('openReviewComment：push 且 review + rcomment 同时写入（rcomment 依赖 review）', () => {
    useRepoRoute().openReviewComment('rv1', 'c3')
    const arg = routerPush.mock.calls[0][0] as { query: Record<string, string> }
    expect(arg.query.review).toBe('rv1')
    expect(arg.query.rcomment).toBe('c3')
  })

  it('switchTab：显式清空 review + rcomment（跨页签残留会让 PR 页直接展开评审）', () => {
    routeState.query = { tab: 'pulls', number: '5', review: 'rv1', rcomment: 'c1', ptype: 'open' }
    useRepoRoute().switchTab('issues')
    expect(routerReplace).toHaveBeenCalledTimes(1)
    const arg = routerReplace.mock.calls[0][0] as { query: Record<string, string> }
    expect(arg.query).toEqual({ tab: 'issues', ptype: 'open' })
    expect(arg.query).not.toHaveProperty('review')
    expect(arg.query).not.toHaveProperty('rcomment')
    // ptype 是用户偏好，切页签不丢
  })

  it('switchTab：评审下钻键与既有 8 个下钻键一同清空（无遗漏）', () => {
    routeState.query = {
      number: '5', sn: '9', sha: 'abc', path: 'a.ts', release: 'r',
      pname: 'p', ptag: 't', compare: '1', review: 'rv1', rcomment: 'c1', page: '2',
    }
    useRepoRoute().switchTab('code')
    const arg = routerReplace.mock.calls[0][0] as { query: Record<string, string> }
    expect(arg.query).toEqual({})
  })
})
