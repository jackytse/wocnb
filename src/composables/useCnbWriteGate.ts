/**
 * 写操作 scope 统一闸门（2026-11-19 全应用写权限统一方案）。
 *
 * 背景与判定模型 —— 一个写按钮能否显示，由两个独立维度共同决定：
 * 1. **角色维度**（资源级）：当前用户在该仓库/组织是否为 owner/master，
 *    已有的 canManage 角色预判链路覆盖；
 * 2. **令牌维度**（账号级）：OAuth/PAT 令牌是否携带所需 scope，与角色
 *    无关 —— cnb_cli 客户端签发的令牌固定缺 account-profile:rw 等账号域
 *    scope，角色再高也必然 403。
 *
 * scope 判定数据来自两个互补来源（都不发探测请求）：
 * - 正向缓存 cnbTokenScopes：OAuth token 端点响应（启动临期续期时自然
 *   捕获），说"令牌有什么权限"；
 * - 学习缓存 cnbDeniedScopes：任意接口真实 403 解析出的 missingScope
 *   （cnbRequest 统一挂点），说"令牌确定缺什么权限"。
 *
 * 三态判定语义（hasCnbScope）：
 * - true  → 确认拥有 → 按钮照常（角色预判通过即显示）；
 * - false → 确认缺失 → **写按钮必须隐藏**（无论角色多高，点了必 403）；
 * - null  → 未知（PAT 未学习 / OAuth 未采集且无 403 学习）→ 维持现状：
 *   角色预判放行 + 保存 403 兜底（StateAlert / 学习缓存补齐后自动隐藏）。
 *
 * 用法（写组件统一套路）：
 * ```
 * const scopeGate = useScopeGate(SCOPE.REPO_CNB_TRIGGER)
 * const canTrigger = computed(() => props.canManage && !scopeGate.denied.value)
 * ```
 */
import { computed, type ComputedRef } from 'vue'
import { hasCnbScope } from './useCnbCliAuth'

// ---------------------------------------------------------------------------
// scope 常量表（依据 CNB swagger 描述行的 Required permissions 原文，
// 逐端点核对，勿凭记忆填写；多 scope 端点以数组表达，服务端要求全部具备）
// ---------------------------------------------------------------------------

/** 账号资料编辑（POST /user） */
export const SCOPE_ACCOUNT_PROFILE = 'account-profile:rw'
/** 构建触发/停止/删日志（build/start|stop|logs） */
export const SCOPE_REPO_CNB_TRIGGER = 'repo-cnb-trigger:rw'
/** 仓库管理（PATCH /{repo}、归档、转移、分支保护、删除等） */
export const SCOPE_REPO_MANAGE = 'repo-manage:rw'
/** 归档/取消归档额外要求（settings/archive：repo-manage:rw,repo-code:rw） */
export const SCOPE_REPO_CODE = 'repo-code:rw'
/** Issue 写（创建/关闭重开/属性/指派/labels） */
export const SCOPE_REPO_ISSUE = 'repo-issue:rw'
/** 评论/评审写（issue 与 PR 的 comments、reviews、仓库 labels 管理） */
export const SCOPE_REPO_NOTES = 'repo-notes:rw'
/** PR 写（创建/合并/reviewers/PR labels） */
export const SCOPE_REPO_PR = 'repo-pr:rw'
/** Release/tag 写（releases CRUD、tags 创建删除、tag annotations） */
export const SCOPE_REPO_RELEASE = 'repo-release:rw'
/** 分支/blob 写（branches 创建删除、branch-locks、commit annotations） */
export const SCOPE_REPO_CODE_RW = 'repo-code:rw'
/** 制品删除（packages/{type}/{name} 与 tag 删除） */
export const SCOPE_REGISTRY_PACKAGE_DELETE = 'registry-package-delete:rw'
/** 组织管理（组织设置/成员/转移/分支保护/仓库墙/新建组织） */
export const SCOPE_GROUP_MANAGE = 'group-manage:rw'
/** 组织资源写（POST /{slug}/-/repos 新建仓库、missions） */
export const SCOPE_GROUP_RESOURCE = 'group-resource:rw'

/**
 * scope 写闸组合式函数。
 *
 * @param scope 单个 scope 或多 scope 数组（服务端要求全部具备，任一
 *              确认缺失即视为该写操作不可用）
 * @returns denied：是否确认缺失（true = 必须隐藏写入口）；未知时为
 *          false（不误伤 —— 角色预判 + 403 兜底 + 学习缓存补齐）
 */
export function useScopeGate(scope: string | string[]): { denied: ComputedRef<boolean> } {
  const scopes = Array.isArray(scope) ? scope : [scope]
  const denied = computed(() =>
    scopes.some(s => hasCnbScope(s) === false),
  )
  return { denied }
}
