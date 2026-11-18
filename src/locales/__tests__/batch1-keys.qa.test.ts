/**
 * 批次 1（REQ-01~06）新增文案的 QA 独立校验 —— 补充既有 locales.test.ts
 * 只比对"键集合"的空白：
 *
 * 1. **键存在性**：把新组件里实际 `t()` 用到的键逐条列出（不是按命名空间整体
 *    放过），任何一处改名/漏建都会定位到具体键；
 * 2. **占位符一致**：同一键在三语的 `{branch}` / `{name}` / `{max}` / `{count}`
 *    等命名参数必须完全相同（否则某语种渲染出裸 `{max}`）；
 * 3. **消息语法安全**：批 1 文案里不得出现裸 `@`（vue-i18n 当 linked message）
 *    或裸 `|`（当复数分隔符）—— 这两类问题构建期不报错，只在渲染时炸。
 *
 * ⚠️ 当前状态（QA 第 1 轮）：本文件前 4 个用例**故意保持失败** —— 它们指向真实缺陷
 * BUG-02：`repo.tags.createSuccess` 在 en / zh-CN / zh-TW **三语全部缺失**，而
 * RepoReleases.vue 新建 Git 标签成功后用它做 toast 标题，用户会看到裸键名。
 * 既有的 locales.test.ts 只比对"三语键集合相等"，三语同时缺失时无法拦截。
 * 工程师补齐该键后这些用例自动转绿，无需改动本文件。
 */
import { describe, expect, it } from 'vitest'
import en from '../en'
import zhCN from '../zh-CN'
import zhTW from '../zh-TW'

type Dict = Record<string, unknown>

/** 递归展开为 { 'repo.tags.deleteConfirm': '...' } */
function flatten(obj: Dict, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(out, flatten(value as Dict, path))
    }
    else {
      out[path] = String(value)
    }
  }
  return out
}

/** 提取消息里的命名占位符（排序后比较，忽略书写顺序） */
function placeholders(message: string): string[] {
  return [...message.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()
}

const messages = {
  en: flatten(en as Dict),
  'zh-CN': flatten(zhCN as Dict),
  'zh-TW': flatten(zhTW as Dict),
}

/**
 * 批次 1 新组件实际使用的键（与 RepoBranchSelect / CreateBranchModal /
 * RepoReleases / RepoLabelManager / IssueMetaEditor / CreatePullModal /
 * RepoPullList / RepoPullDetail / AiUsagePanel / RepoBuildDetail 中 t() 调用一一对应）。
 */
const BATCH1_KEYS = [
  // REQ-01 分支
  'repo.branches.create',
  'repo.branches.name',
  'repo.branches.namePlaceholder',
  'repo.branches.nameRequired',
  'repo.branches.nameInvalid',
  'repo.branches.nameDuplicate',
  'repo.branches.startPoint',
  'repo.branches.startPointPlaceholder',
  'repo.branches.createSuccess',
  'repo.branches.createFailed',
  'repo.branches.delete',
  'repo.branches.deleteConfirm',
  'repo.branches.deleteSuccess',
  'repo.branches.deleteFailed',
  'repo.branches.lock',
  'repo.branches.unlock',
  'repo.branches.lockSuccess',
  'repo.branches.unlockSuccess',
  'repo.branches.lockFailed',
  'repo.branches.unlockFailed',
  'repo.branches.currentNoDelete',
  // REQ-02 Git 标签
  'repo.tags.title',
  'repo.tags.create',
  'repo.tags.name',
  'repo.tags.nameRequired',
  'repo.tags.nameInvalid',
  'repo.tags.nameDuplicate',
  'repo.tags.target',
  'repo.tags.message',
  'repo.tags.typeAnnotated',
  'repo.tags.typeLightweight',
  'repo.tags.sha',
  'repo.tags.verified',
  'repo.tags.empty',
  'repo.tags.delete',
  'repo.tags.deleteConfirm',
  'repo.tags.createSuccess',
  'repo.tags.deleteSuccess',
  // REQ-03 仓库标签
  'repo.labels.manage',
  'repo.labels.create',
  'repo.labels.edit',
  'repo.labels.delete',
  'repo.labels.name',
  'repo.labels.nameRequired',
  'repo.labels.color',
  'repo.labels.description',
  'repo.labels.empty',
  'repo.labels.deleteConfirm',
  'repo.labels.createSuccess',
  'repo.labels.updateSuccess',
  'repo.labels.deleteSuccess',
  // REQ-04 Issue 处理人 / 标签
  'repo.issues.editMeta',
  'repo.issues.selectLabels',
  'repo.issues.selectAssignees',
  'repo.issues.labelHint',
  'repo.issues.assigneeHint',
  'repo.issues.assigneeLimit',
  'repo.issues.assigneeNotAllowed',
  'repo.issues.checkFailed',
  'repo.issues.saveSuccess',
  'repo.issues.saveFailed',
  // REQ-05 PR
  'repo.pulls.create',
  'repo.pulls.edit',
  'repo.pulls.titleLabel',
  'repo.pulls.titleRequired',
  'repo.pulls.titleTooLong',
  'repo.pulls.head',
  'repo.pulls.base',
  'repo.pulls.body',
  'repo.pulls.branchesRequired',
  'repo.pulls.sameBranch',
  'repo.pulls.assignees',
  'repo.pulls.assigneesEmpty',
  'repo.pulls.editAssignees',
  'repo.pulls.selectAssignees',
  'repo.pulls.assigneeHint',
  'repo.pulls.assigneeLimit',
  'repo.pulls.assigneeNotAllowed',
  'repo.pulls.checkFailed',
  'repo.pulls.ciStatus',
  'repo.pulls.ciEmpty',
  'repo.pulls.createSuccess',
  'repo.pulls.editSuccess',
  'repo.pulls.saveSuccess',
  // REQ-06 AI 用量
  'repo.build.aiUsage.title',
  'repo.build.aiUsage.empty',
  'repo.build.aiUsage.totalPages',
  'repo.build.aiUsage.success',
  'repo.build.aiUsage.failed',
  'repo.build.aiUsage.tokens',
  'repo.build.aiUsage.durationNone',
  'repo.build.aiUsage.pipeline',
  'repo.build.aiUsage.detail',
]

describe('批次 1 文案：三语齐备', () => {
  it.each(['en', 'zh-CN', 'zh-TW'] as const)('%s 包含全部批次 1 键', (locale) => {
    const missing = BATCH1_KEYS.filter(key => !(key in messages[locale]))
    expect(missing, `${locale} 缺少键：${missing.join(', ')}`).toEqual([])
  })

  it('批次 1 文案非空（占位/空串会导致界面空白）', () => {
    for (const locale of ['en', 'zh-CN', 'zh-TW'] as const) {
      for (const key of BATCH1_KEYS) {
        expect(messages[locale][key]?.trim(), `${locale} 的 ${key} 为空`).toBeTruthy()
      }
    }
  })
})

describe('批次 1 文案：占位符与消息语法', () => {
  it('同一键三语占位符名称完全一致（顺序无关）', () => {
    const mismatched: string[] = []
    for (const key of BATCH1_KEYS) {
      const base = placeholders(messages.en[key] ?? '')
      for (const locale of ['zh-CN', 'zh-TW'] as const) {
        const other = placeholders(messages[locale][key] ?? '')
        if (other.join(',') !== base.join(',')) {
          mismatched.push(`${key}: en={${base.join(',')}} ${locale}={${other.join(',')}}`)
        }
      }
    }
    expect(mismatched, mismatched.join(' | ')).toEqual([])
  })

  it('带占位符的键在中文里同样带占位符（防止只改了中文指向）', () => {
    const withPlaceholder = BATCH1_KEYS.filter(key => placeholders(messages.en[key] ?? '').length > 0)
    expect(withPlaceholder.length).toBeGreaterThan(0)
    for (const key of withPlaceholder) {
      expect(placeholders(messages['zh-CN'][key] ?? '')).toEqual(placeholders(messages.en[key]))
    }
  })

  it('无裸 @ / 裸 |（vue-i18n 会当作 linked message 与复数分隔）', () => {
    const unsafe: string[] = []
    for (const locale of ['en', 'zh-CN', 'zh-TW'] as const) {
      for (const key of BATCH1_KEYS) {
        const message = messages[locale][key] ?? ''
        // 允许官方转义写法 {'@'} / {'|'}
        const stripped = message.replace(/\{'@'\}/g, '').replace(/\{'\|'\}/g, '')
        if (stripped.includes('@')) {
          unsafe.push(`${locale}/${key}: ${message}`)
        }
        if (stripped.includes('|')) {
          unsafe.push(`${locale}/${key}（裸 |）: ${message}`)
        }
      }
    }
    expect(unsafe, unsafe.join(' | ')).toEqual([])
  })
})
