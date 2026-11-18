/**
 * T01 数据层单测：分支 / Git 标签 / 仓库标签。
 *
 * 本轮 N2 / 踩坑#3 的核心防线：**通道断言**——用 mock 锁定每个写函数到底调
 * cnbFetch（JSON，有 body）还是 cnbFetchVoid（空 body），尤其防止：
 * - createTag（201 有 body）被误写成 cnbFetchVoid（头号反例）；
 * - 分支写（空 body）被误写成 cnbFetch（会抛 Unexpected end of JSON input）。
 * 另锁定：路径编码（branch='feature/x' → %2F）、TagDetail.annotated 派生、
 * 异常响应降级 []（不抛给 UI）。
 *
 * 说明：useCnbGitRefs/useCnbRepoLabels 从 useCnbRepo 复用 encodeRepoPath，
 * 而 useCnbRepo 顶层 import 了 useCnbAuth 的多个导出；本 mock 需把它们一并
 * 提供桩，否则模块加载阶段会拿到 undefined（本文件不调用它们，仅占位）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const cnbFetchMock = vi.fn()
const cnbFetchVoidMock = vi.fn()

vi.mock('../useCnbAuth', () => ({
  cnbFetch: (...args: unknown[]) => cnbFetchMock(...args),
  cnbFetchVoid: (...args: unknown[]) => cnbFetchVoidMock(...args),
  cnbFetchText: (...args: unknown[]) => cnbFetchMock(...args),
  canManageRole: () => false,
  CnbApiError: class extends Error {},
}))

import {
  createBranch,
  createTag,
  deleteBranch,
  deleteTag,
  fetchBranchDetail,
  fetchTagDetail,
  lockBranch,
  normalizeBranchDetail,
  normalizeTag,
  unlockBranch,
} from '../useCnbGitRefs'
import {
  createRepoLabel,
  deleteRepoLabel,
  listRepoLabels,
  normalizeRepoLabel,
  updateRepoLabel,
} from '../useCnbRepoLabels'

beforeEach(() => {
  cnbFetchMock.mockReset()
  cnbFetchVoidMock.mockReset()
  // 写端点默认返回 undefined（Void 通道不读响应体）
  cnbFetchVoidMock.mockResolvedValue(undefined)
})

describe('分支写端点：空 body 一律走 cnbFetchVoid', () => {
  it('createBranch：POST /git/branches，startPoint 转 snake_case，走 Void', async () => {
    await createBranch('org/repo', { name: 'feature/x', startPoint: 'main' })
    expect(cnbFetchVoidMock).toHaveBeenCalledTimes(1)
    expect(cnbFetchMock).not.toHaveBeenCalled()
    const [path, options] = cnbFetchVoidMock.mock.calls[0]
    expect(path).toBe('/org/repo/-/git/branches')
    expect(options.method).toBe('POST')
    expect(JSON.parse(options.body)).toEqual({ name: 'feature/x', start_point: 'main' })
  })

  it('createBranch：未给 startPoint 时不发该字段', async () => {
    await createBranch('org/repo', { name: 'dev' })
    expect(JSON.parse(cnbFetchVoidMock.mock.calls[0][1].body)).toEqual({ name: 'dev' })
  })

  it('deleteBranch：分支名含 / 编码成 %2F（单段内嵌斜杠），走 Void', async () => {
    await deleteBranch('org/repo', 'feature/x')
    expect(cnbFetchVoidMock).toHaveBeenCalledTimes(1)
    const [path, options] = cnbFetchVoidMock.mock.calls[0]
    expect(path).toBe('/org/repo/-/git/branches/feature%2Fx')
    expect(path).not.toContain('/git/branches/feature/x')
    expect(options.method).toBe('DELETE')
  })

  it('lockBranch / unlockBranch：POST / DELETE branch-locks，均走 Void', async () => {
    await lockBranch('org/repo', 'main')
    await unlockBranch('org/repo', 'main')
    expect(cnbFetchVoidMock).toHaveBeenCalledTimes(2)
    expect(cnbFetchMock).not.toHaveBeenCalled()
    expect(cnbFetchVoidMock.mock.calls[0][0]).toBe('/org/repo/-/git/branch-locks/main')
    expect(cnbFetchVoidMock.mock.calls[0][1].method).toBe('POST')
    expect(cnbFetchVoidMock.mock.calls[1][0]).toBe('/org/repo/-/git/branch-locks/main')
    expect(cnbFetchVoidMock.mock.calls[1][1].method).toBe('DELETE')
  })

  it('仓库路径逐段编码（多级子组织），不整体压平', async () => {
    await deleteBranch('org/sub/repo', 'fix bug')
    const [path] = cnbFetchVoidMock.mock.calls[0]
    // '/' 保留为层级分隔符，空格编码为 %20
    expect(path).toBe('/org/sub/repo/-/git/branches/fix%20bug')
    expect(path).not.toContain('%2Frepo')
  })
})

describe('分支详情：有 body 走 cnbFetch + 归一化兜底', () => {
  it('fetchBranchDetail 走 cnbFetch，branch 编码', async () => {
    cnbFetchMock.mockResolvedValueOnce({ name: 'feature/x', commit: { sha: 'abc', message: 'feat: add\nbody' } })
    const detail = await fetchBranchDetail('org/repo', 'feature/x')
    expect(cnbFetchMock).toHaveBeenCalledTimes(1)
    expect(cnbFetchVoidMock).not.toHaveBeenCalled()
    expect(cnbFetchMock.mock.calls[0][0]).toBe('/org/repo/-/git/branches/feature%2Fx')
    expect(detail).toEqual({ name: 'feature/x', sha: 'abc', protected: false, locked: false, commitMessage: 'feat: add' })
  })

  it('normalizeBranchDetail 对空/异常响应兜底，不抛给 UI', () => {
    expect(normalizeBranchDetail({})).toEqual({ name: '', sha: '', protected: false, locked: false, commitMessage: '' })
    expect(normalizeBranchDetail({ protected: true, locked: true }).locked).toBe(true)
  })

  it('api.BranchDetail.commit 是嵌套 api.Commit：message 取 commit.commit.message', () => {
    // swagger 核对：BranchDetail.commit: api.Commit，其 message 在下一层 commit 对象
    const detail = normalizeBranchDetail({
      name: 'main',
      commit: { sha: 'abc', commit: { message: 'feat: nested\nbody' } },
    })
    expect(detail.sha).toBe('abc')
    expect(detail.commitMessage).toBe('feat: nested')
  })
})

describe('Git 标签：createTag 走 JSON（关键反例防护）', () => {
  it('createTag：201 api.Tag 有 body → cnbFetch，非 Void', async () => {
    cnbFetchMock.mockResolvedValueOnce({
      name: 'v1.0', target: 'deadbeef', target_type: 'tag', message: 'release',
      commit: { sha: 'cafebabe' }, verification: { verified: true },
    })
    const tag = await createTag('org/repo', { name: 'v1.0', target: 'main', message: 'release' })
    // 关键断言：绝不能走 Void
    expect(cnbFetchMock).toHaveBeenCalledTimes(1)
    expect(cnbFetchVoidMock).not.toHaveBeenCalled()
    const [path, options] = cnbFetchMock.mock.calls[0]
    expect(path).toBe('/org/repo/-/git/tags')
    expect(options.method).toBe('POST')
    expect(JSON.parse(options.body)).toEqual({ name: 'v1.0', target: 'main', message: 'release' })
    // 归一化：target 优先、annotated 由 target_type='tag' 派生、verification 对象形态
    expect(tag).toEqual({ name: 'v1.0', sha: 'deadbeef', targetType: 'tag', annotated: true, message: 'release', verified: true })
  })

  it('deleteTag：204 空 body → cnbFetchVoid，tag 编码', async () => {
    await deleteTag('org/repo', 'v1.0 beta')
    expect(cnbFetchVoidMock).toHaveBeenCalledTimes(1)
    expect(cnbFetchMock).not.toHaveBeenCalled()
    expect(cnbFetchVoidMock.mock.calls[0][0]).toBe('/org/repo/-/git/tags/v1.0%20beta')
    expect(cnbFetchVoidMock.mock.calls[0][1].method).toBe('DELETE')
  })

  it('fetchTagDetail：200 api.Tag → cnbFetch', async () => {
    cnbFetchMock.mockResolvedValueOnce({ name: 'light', target: 'sha1', target_type: 'commit' })
    const tag = await fetchTagDetail('org/repo', 'light')
    expect(cnbFetchMock).toHaveBeenCalledTimes(1)
    expect(cnbFetchVoidMock).not.toHaveBeenCalled()
    expect(cnbFetchMock.mock.calls[0][0]).toBe('/org/repo/-/git/tags/light')
    expect(tag.annotated).toBe(false) // target_type='commit' → 轻量
    expect(tag.verified).toBe(false)
    expect(tag.sha).toBe('sha1')
  })

  it('normalizeTag：verification 缺失/字符串/对象三形态兜底，sha 回退 commit.sha', () => {
    expect(normalizeTag({ name: 't', commit: { sha: 'fallback' } }).sha).toBe('fallback')
    expect(normalizeTag({ verification: 'gpg' }).verified).toBe(true)
    expect(normalizeTag({ verification: { verified: false } }).verified).toBe(false)
    expect(normalizeTag({}).sha).toBe('')
    expect(normalizeTag({}).annotated).toBe(false)
  })
})

describe('仓库标签：POST/PATCH 走 JSON，DELETE 走 Void，中文名编码', () => {
  it('listRepoLabels：非数组降级 []', async () => {
    cnbFetchMock.mockResolvedValueOnce({ unexpected: true })
    expect(await listRepoLabels('org/repo')).toEqual([])
    expect(cnbFetchMock.mock.calls[0][0]).toBe('/org/repo/-/labels')
  })

  it('createRepoLabel：201 有 body → cnbFetch', async () => {
    cnbFetchMock.mockResolvedValueOnce({ id: '1', name: 'bug', color: 'ff0000', description: '缺陷' })
    const label = await createRepoLabel('org/repo', { name: 'bug', color: 'ff0000', description: '缺陷' })
    expect(cnbFetchMock).toHaveBeenCalledTimes(1)
    expect(cnbFetchVoidMock).not.toHaveBeenCalled()
    expect(cnbFetchMock.mock.calls[0][0]).toBe('/org/repo/-/labels')
    expect(cnbFetchMock.mock.calls[0][1].method).toBe('POST')
    expect(JSON.parse(cnbFetchMock.mock.calls[0][1].body)).toEqual({ name: 'bug', color: 'ff0000', description: '缺陷' })
    expect(label).toEqual({ id: '1', name: 'bug', color: 'ff0000', description: '缺陷' })
  })

  it('updateRepoLabel：PATCH 有 body → cnbFetch，new_name 字段 + 中文名编码', async () => {
    cnbFetchMock.mockResolvedValueOnce({ name: '新名称', color: '00ff00' })
    await updateRepoLabel('org/repo', '待评审', { newName: '新名称', color: '00ff00' })
    expect(cnbFetchMock).toHaveBeenCalledTimes(1)
    expect(cnbFetchVoidMock).not.toHaveBeenCalled()
    const [path, options] = cnbFetchMock.mock.calls[0]
    expect(path).toBe('/org/repo/-/labels/%E5%BE%85%E8%AF%84%E5%AE%A1') // 待评审
    expect(options.method).toBe('PATCH')
    const body = JSON.parse(options.body)
    expect(body).toEqual({ new_name: '新名称', color: '00ff00' })
    expect(body.name).toBeUndefined() // 原 name 只走路径段
  })

  it('deleteRepoLabel：204 空 body → cnbFetchVoid，中文名编码', async () => {
    await deleteRepoLabel('org/repo', '待评审')
    expect(cnbFetchVoidMock).toHaveBeenCalledTimes(1)
    expect(cnbFetchMock).not.toHaveBeenCalled()
    expect(cnbFetchVoidMock.mock.calls[0][0]).toBe('/org/repo/-/labels/%E5%BE%85%E8%AF%84%E5%AE%A1')
    expect(cnbFetchVoidMock.mock.calls[0][1].method).toBe('DELETE')
  })

  it('normalizeRepoLabel 字段兜底', () => {
    expect(normalizeRepoLabel({})).toEqual({ id: '', name: '', color: '', description: '' })
  })
})
