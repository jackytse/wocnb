/**
 * fork 仓库「同步更新」能力（与上游仓库保持一致）。
 *
 * ## 背景
 * CNB OpenAPI 没有原生的 fork 同步端点（网页端「同步更新」走内部接口，
 * 未公开），且 fork 与上游仓库的 git 对象库互不可达（在 fork 内引用上游
 * SHA 会 404），无法用分支创建/修改 API 拼接出同步能力。
 *
 * ## 实现方式（官方 OpenAPI 组合，2026-11-20 端到端实测通过）
 * `POST /{repo}/-/build/start`（StartBuild）支持 `config` 参数 —— 动态
 * 注入一段流水线 YAML，由 CNB 云原生构建环境执行「fetch upstream + merge
 * + push」。构建环境 checkout 的 fork 工作区已内置 `upstream` remote（指
 * 向 fork 来源仓库），CNB_TOKEN 具备本仓库推送权限，无需额外凭据。
 *
 * ## 同步检测
 * 对比 fork 与上游同名分支的 commit SHA：相同 → 已同步；不同 → 视为
 * 「上游有更新」可同步（无法精确区分 ahead/behind —— 对象库隔离，compare
 * API 也不支持跨仓库；merge 语义保证 fork 独有提交不会被丢弃）。
 */
import { cnbFetch } from './useCnbAuth'
import { encodeRepoPath } from './useCnbRepo'

/** 同步状态：
 * - same：fork 分支与上游同名分支指向同一提交，无需同步
 * - outdated：SHA 不同，上游可能有更新（也可能 fork 有独有提交，统一提示可同步）
 * - upstream-missing：上游没有同名分支（如上游删了分支），无法同步
 * - unknown：探测失败（网络/权限），不显示同步入口
 */
export type ForkSyncState = 'same' | 'outdated' | 'upstream-missing' | 'unknown'

/** 触发同步构建的返回（POST /-/build/start → dto.BuildResult 子集） */
export interface ForkSyncBuild {
  /** 构建序列号（用于跳转应用内构建详情页） */
  sn: string
  /** 网页端构建日志地址（兜底外跳） */
  buildLogUrl: string
}

interface RawBranchInfo {
  name?: string
  commit?: { sha?: string } | null
}

/**
 * 读取某仓库指定分支的最新 commit SHA（三态返回，内部函数不抛错）。
 * 端点：GET /{repo}/-/git/branches/{branch}。
 * - SHA 字符串：分支存在；
 * - 'missing'：分支不存在（404，上游删分支的合法场景）；
 * - null：其他错误（网络 / 403 等，探测失败）。
 */
async function fetchBranchSha(
  repoPath: string,
  branch: string,
): Promise<string | 'missing' | null> {
  try {
    const raw = await cnbFetch<RawBranchInfo>(
      `/${encodeRepoPath(repoPath)}/-/git/branches/${encodeURIComponent(branch)}`,
    )
    return raw.commit?.sha || null
  }
  catch (err) {
    // CnbApiError.status === 404：分支确实不存在（上游删分支的合法场景）；
    // 其余错误（网络 / 403 等）归 null，由调用方判 unknown 静默
    const status = (err as { status?: number }).status
    return status === 404 ? 'missing' : null
  }
}

/**
 * 检测 fork 分支相对上游同名分支的同步状态。
 *
 * @param forkPath fork 仓库完整路径（如 jackytse/hello-cnb）
 * @param upstreamPath 上游仓库完整路径（来自 repoDetail.forkedFromPath）
 * @param branch 要同步的分支名（一般是当前 head / 默认分支）
 * @returns ForkSyncState，见类型注释
 */
export async function fetchForkSyncState(
  forkPath: string,
  upstreamPath: string,
  branch: string,
): Promise<ForkSyncState> {
  // 两个分支 SHA 无依赖，并行请求缩短检测耗时
  const [forkSha, upstreamSha] = await Promise.all([
    fetchBranchSha(forkPath, branch),
    fetchBranchSha(upstreamPath, branch),
  ])
  // fork 侧探测失败或不存在：不该发生（分支名来自 fork 自己的 head），
  // 异常场景统一 unknown（不显示入口，不打扰用户）
  if (!forkSha || forkSha === 'missing') {
    return 'unknown'
  }
  // 上游探测失败（网络 / 权限）→ unknown 静默
  if (upstreamSha === null) {
    return 'unknown'
  }
  // 上游没有同名分支：上游删了分支或改名，无法同步
  if (upstreamSha === 'missing') {
    return 'upstream-missing'
  }
  return forkSha === upstreamSha ? 'same' : 'outdated'
}

/**
 * 生成同步流水线 YAML（注入 StartBuild 的 config 参数）。
 *
 * 注意点（实测踩坑）：
 * - 构建环境已内置 upstream remote，但保险起见 set-url 兜底（remote 已
 *   存在时 add 会报错中断 —— 第一次实测即栽在这里）；
 * - merge --no-edit：fast-forward 时 Git 直接前进，分叉时产生合并提交，
 *   冲突时构建失败（返回码非 0），用户可在网页端处理；
 * - push origin HEAD:{branch}：merge 后 HEAD 即同步结果，统一推到同名分支。
 */
function buildSyncPipelineConfig(upstreamPath: string, branch: string): string {
  const upstreamUrl = `https://cnb.cool/${upstreamPath}.git`
  return [
    '$:',
    '  api_trigger:',
    '    - stages:',
    '        - name: sync-upstream',
    '          script: |',
    '            set -e',
    '            git config user.name "wocnb-sync"',
    '            git config user.email "sync@wocnb.local"',
    `            git remote set-url upstream ${upstreamUrl} 2>/dev/null || git remote add upstream ${upstreamUrl}`,
    `            git fetch upstream ${branch}`,
    `            git merge --no-edit upstream/${branch}`,
    `            git push origin HEAD:${branch}`,
  ].join('\n')
}

/**
 * 触发 fork 同步构建。
 *
 * 端点：POST /{repo}/-/build/start（StartBuild，scope: repo-cnb-trigger:rw）。
 * 动态注入 config 而不落盘到仓库文件 —— 不污染用户仓库内容，同步完成后
 * 构建记录仅保留在构建历史里。
 *
 * @returns 构建序列号与网页端日志地址（供跳转查看进度）
 */
export async function startForkSync(
  forkPath: string,
  upstreamPath: string,
  branch: string,
): Promise<ForkSyncBuild> {
  const raw = await cnbFetch<{ sn?: string, buildLogUrl?: string }>(
    `/${encodeRepoPath(forkPath)}/-/build/start`,
    {
      method: 'POST',
      body: JSON.stringify({
        branch,
        event: 'api_trigger',
        config: buildSyncPipelineConfig(upstreamPath, branch),
      }),
    },
  )
  if (!raw.sn) {
    // 服务端契约破坏（正常返回必有 sn）：按错误处理，避免调用方拿到空号
    throw new Error('同步构建响应缺少构建号')
  }
  return {
    sn: raw.sn,
    buildLogUrl: raw.buildLogUrl || '',
  }
}
