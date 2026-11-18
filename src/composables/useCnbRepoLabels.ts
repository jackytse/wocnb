/**
 * 仓库标签（repo labels）数据层 —— REQ-03。
 *
 * 端点（scope：读 repo-notes:r / 写 repo-notes:rw）：
 * - GET    /{repo}/-/labels          → api.Label[]
 * - POST   /{repo}/-/labels          → 201 api.Label（**有 body**）
 * - PATCH  /{repo}/-/labels/{name}   → 200 api.Label（**有 body**）
 * - DELETE /{repo}/-/labels/{name}   → 204 空 body
 *
 * **通道选择依据（踩坑#3）**：POST/PATCH 返回实体必须走 cnbFetch；DELETE 空 body
 * 必须走 cnbFetchVoid。三者同为写操作但通道不同，逐条对照设计 §8.2 表。
 *
 * 路径陷阱：name 是路径段且中文标签名合法（如 "待评审"），必须 encodeURIComponent。
 * PATCH 的重命名字段是 new_name（不是 name），原 name 只走路径段，body 不含原值。
 */
import { cnbFetch, cnbFetchVoid } from './useCnbAuth'
import { encodeRepoPath } from './useCnbRepo'

/** 仓库标签条目（api.Label 归一化后，界面层不判空） */
export interface RepoLabel {
  /** 标签名（唯一标识，重命名后此字段变化） */
  name: string
  /** 展示色（十六进制，如 ff0000；可能为空） */
  color: string
  /** 描述（可能为空） */
  description: string
  /** 服务端 id（部分版本不返回，兜底空串） */
  id: string
}

/** api.Label 原始结构（snake_case，全可选防御） */
interface RawRepoLabel {
  id?: string
  name?: string
  color?: string
  description?: string
}

/**
 * api.Label → RepoLabel 归一化（导出供单测断言）。
 * 数组/对象响应异常时由调用方降级 []；字段级兜底统一在此处完成。
 */
export function normalizeRepoLabel(raw: RawRepoLabel): RepoLabel {
  return {
    id: raw?.id || '',
    name: raw?.name || '',
    color: raw?.color || '',
    description: raw?.description || '',
  }
}

/**
 * 仓库标签列表（GET /{repo}/-/labels）。
 * **通道选择依据**：200 api.Label[]（有 body）→ cnbFetch；
 * 响应非数组时降级空列表，不把异常抛给 UI。
 */
export async function listRepoLabels(repoPath: string): Promise<RepoLabel[]> {
  const raw = await cnbFetch<RawRepoLabel[]>(`/${encodeRepoPath(repoPath)}/-/labels`)
  if (!Array.isArray(raw)) {
    return []
  }
  return raw.map(normalizeRepoLabel).filter(label => !!label.name)
}

/**
 * 新建仓库标签（POST /{repo}/-/labels，body api.PostLabelForm）。
 * **通道选择依据**：201 api.Label（有 body）→ cnbFetch 并返回归一化实体，
 * 供 UI 直接插入列表（避免一次额外重拉）。
 */
export async function createRepoLabel(
  repoPath: string,
  input: { name: string, color?: string, description?: string },
): Promise<RepoLabel> {
  const raw = await cnbFetch<RawRepoLabel>(`/${encodeRepoPath(repoPath)}/-/labels`, {
    method: 'POST',
    body: JSON.stringify({
      name: input.name,
      ...(input.color ? { color: input.color } : {}),
      ...(input.description ? { description: input.description } : {}),
    }),
  })
  return normalizeRepoLabel(raw)
}

/**
 * 编辑仓库标签（PATCH /{repo}/-/labels/{name}，body api.PatchLabelForm）。
 * **通道选择依据**：200 api.Label（有 body）→ cnbFetch。
 * 重命名字段是 new_name；原 name 走路径段（含中文/空格需 encodeURIComponent）。
 *
 * **增量语义（BUG-01 修复）**：用 `!== undefined` 而非真值判断 —— 空串表示
 * "清空该字段"必须照常提交，undefined 表示"未修改"才省略；真值判断会把
 * 清空操作静默丢弃，导致用户保存后看到"成功"但数据没变。
 */
export async function updateRepoLabel(
  repoPath: string,
  name: string,
  patch: { newName?: string, color?: string, description?: string },
): Promise<RepoLabel> {
  const raw = await cnbFetch<RawRepoLabel>(
    `/${encodeRepoPath(repoPath)}/-/labels/${encodeURIComponent(name)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        ...(patch.newName !== undefined ? { new_name: patch.newName } : {}),
        ...(patch.color !== undefined ? { color: patch.color } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
      }),
    },
  )
  return normalizeRepoLabel(raw)
}

/**
 * 删除仓库标签（DELETE /{repo}/-/labels/{name}）。
 * **通道选择依据**：204 空 body → cnbFetchVoid。
 * 前置确认文案说明"将从所有 Issue 移除"（PRD repo.labels.deleteConfirm）。
 */
export async function deleteRepoLabel(repoPath: string, name: string): Promise<void> {
  await cnbFetchVoid(
    `/${encodeRepoPath(repoPath)}/-/labels/${encodeURIComponent(name)}`,
    { method: 'DELETE' },
  )
}
