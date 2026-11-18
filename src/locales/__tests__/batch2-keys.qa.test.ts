/**
 * 批次 2（REQ-07~11）新增文案的 QA 独立校验 —— 补充既有 locales.test.ts 的
 * "三语集合互比"盲区（三语**同时**缺同一键时互比无法拦截，批次 1 实测踩过：
 * BUG-02 三语齐缺 repo.tags.createSuccess）：
 *
 * 1. **键存在性（must-have 清单）**：把批次 2 组件里实际 `t()` 用到的键逐条列出
 *    （含动态拼接的 `org.protections.fields.*` / `pulls.reviewState.*` /
 *    `pulls.mergeableState.*` 全枚举），三语逐一存在且非空；
 * 2. **命名空间结构对齐**：repo.annotations / repo.properties / repo.members /
 *    repo.pulls.review / org.protections 五个命名空间在三种语言下键集合
 *    完全一致（防单语漏键）；
 * 3. **占位符一致**：{count} / {rule} / {key} 等命名参数三语必须同名
 *    （否则某语种渲染出裸 `{count}`）；
 * 4. **消息语法安全**：不得出现裸 `@`（vue-i18n linked message）或裸 `|`
 *    （复数分隔符）—— 批次 2 文案含 "Owner | Master" 类枚举展示风险点。
 */
import { describe, expect, it } from 'vitest'
import en from '../en'
import zhCN from '../zh-CN'
import zhTW from '../zh-TW'

type Dict = Record<string, unknown>

/** 递归展开为 { 'repo.annotations.title': '...' } */
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
const LOCALES = ['en', 'zh-CN', 'zh-TW'] as const

/** 取命名空间的全部叶子键（带完整路径前缀） */
function namespaceKeys(dict: Record<string, string>, namespace: string): string[] {
  return Object.keys(dict).filter(key => key.startsWith(`${namespace}.`)).sort()
}

// ---------------------------------------------------------------------------
// 批次 2 组件实际 t() 的键（AnnotationsPanel / IssuePropertiesPanel /
// PullReviewPanel / RepoMembersPanel / OrgProtectionsTab / members.vue 页 /
// RepoPullDetail 动态键逐枚举列出）
// ---------------------------------------------------------------------------

/** 动态键 `org.protections.fields.${key}` 的全枚举（BOOLEAN_FIELDS） */
const PROTECTION_FIELD_KEYS = [
  'allowPushes', 'allowCreation', 'allowDeletions', 'allowForcePushes',
  'allowMasterPushes', 'allowMasterCreation', 'allowMasterDeletions',
  'allowMasterForcePushes', 'allowMasterManualMerge', 'requiredPullRequestReviews',
  'requiredCodeownerApprove', 'requiredMasterApprove', 'requiredNpcApprove',
  'requiredLinearHistory', 'requiredMustAutoMerge', 'requiredMustPushViaPullRequest',
  'requiredStatusChecks', 'forbidApprovePullCreatedByOwnNpc',
]

/** 动态键 `pulls.reviewState.${state}` / `pulls.mergeableState.${state}` 全枚举
 * （与 cnb-swagger api.PullReviewer.review_state / api.Pull.mergeable_state
 *  的枚举值一一对应，缺任何一个 API 返回该状态时 vue-i18n 会渲染裸键名） */
const REVIEW_STATE_KEYS = ['pending', 'commented', 'approved', 'changes_requested', 'dismissed']
const MERGEABLE_STATE_KEYS = ['checking', 'mergeable', 'merging', 'merged', 'conflict', 'no-merge-base']

const BATCH2_KEYS = [
  // REQ-08 注解面板（AnnotationsPanel.vue）
  'repo.annotations.title',
  'repo.annotations.create',
  'repo.annotations.edit',
  'repo.annotations.toggle',
  'repo.annotations.empty',
  'repo.annotations.colKey',
  'repo.annotations.colValue',
  'repo.annotations.colActions',
  'repo.annotations.keyRequired',
  'repo.annotations.keyDuplicate',
  'repo.annotations.saved',
  'repo.annotations.saveFailed',
  'repo.annotations.deleted',
  'repo.annotations.deleteFailed',
  'repo.annotations.deleteTitle',
  'repo.annotations.deleteDesc',
  // REQ-09 属性面板（IssuePropertiesPanel.vue）
  'repo.properties.title',
  'repo.properties.privateBadge',
  'repo.properties.saved',
  'repo.properties.saveFailed',
  'repo.properties.partialFailed',
  'repo.properties.allFailed',
  // REQ-10 PR 评审面板（PullReviewPanel.vue）
  'repo.pulls.review.title',
  'repo.pulls.review.approve',
  'repo.pulls.review.requestChanges',
  'repo.pulls.review.comment',
  'repo.pulls.review.submitTitle',
  'repo.pulls.review.submit',
  'repo.pulls.review.submitted',
  'repo.pulls.review.submitFailed',
  'repo.pulls.review.approveHint',
  'repo.pulls.review.requestChangesHint',
  'repo.pulls.review.commentHint',
  'repo.pulls.review.bodyPlaceholder',
  'repo.pulls.review.empty',
  'repo.pulls.review.noComments',
  'repo.pulls.review.reply',
  'repo.pulls.review.replyPlaceholder',
  'repo.pulls.review.replied',
  'repo.pulls.review.replyFailed',
  'repo.pulls.review.reviewerPlaceholder',
  'repo.pulls.review.addReviewer',
  'repo.pulls.review.removeReviewer',
  'repo.pulls.review.added',
  'repo.pulls.review.addFailed',
  'repo.pulls.review.removed',
  'repo.pulls.review.removeFailed',
  // 评审状态本地化（QA 观察项：dismissed 缺键导致动态键回退英文）
  'repo.pulls.review.state.dismissed',
  // PR 标签编辑（QA 回归第 2 轮 · 遗留①修复新增）
  'repo.pulls.labelsEmpty',
  'repo.pulls.editLabels',
  'repo.pulls.selectLabels',
  'repo.pulls.labelsDictEmpty',
  'repo.pulls.labelsHint',
  // REQ-11 仓库成员面板（RepoMembersPanel.vue / members.vue 第 4 页签）
  'repo.members.tab',
  'repo.members.repoLabel',
  'repo.members.add',
  'repo.members.added',
  'repo.members.addFailed',
  'repo.members.empty',
  'repo.members.batchLoadPerms',
  'repo.members.batchFallback',
  'repo.members.permFailed',
  'repo.members.roleUpdated',
  'repo.members.roleUpdateFailed',
  'repo.members.removed',
  'repo.members.removeFailed',
  'repo.members.inheritTitle',
  'repo.members.inheritEmpty',
  'repo.members.effectiveTitle',
  // REQ-07 保护分支（OrgProtectionsTab.vue，组织/仓库两 scope 共用）
  'org.protections.title',
  'org.protections.empty',
  'org.protections.emptyDesc',
  'org.protections.create',
  'org.protections.edit',
  'org.protections.delete',
  'org.protections.rule',
  'org.protections.ruleHint',
  'org.protections.rulePlaceholder',
  'org.protections.ruleRequired',
  'org.protections.limitHint',
  // 仓库级口径文案（QA 回归第 2 轮 · 遗留③修复新增，isRepoScope 切换）
  'repo.protections.limitHint',
  'org.protections.reviewCountHint',
  'org.protections.reviewRatioHint',
  'org.protections.groupPush',
  'org.protections.groupMerge',
  'org.protections.colRule',
  'org.protections.colReviewCount',
  'org.protections.colReviewRatio',
  'org.protections.colCodeowner',
  'org.protections.colStatusChecks',
  'org.protections.colLinearHistory',
  'org.protections.colMustPullRequest',
  'org.protections.colActions',
  'org.protections.enabled',
  'org.protections.disabled',
  'org.protections.countLabel',
  'org.protections.created',
  'org.protections.updated',
  'org.protections.createFailed',
  'org.protections.updateFailed',
  'org.protections.rejected422',
  'org.protections.deleteTitle',
  'org.protections.deleteDesc',
  'org.protections.deleteTypeLabel',
  'org.protections.deleted',
  'org.protections.deleteFailed',
  'org.protections.rootOnlyTitle',
  'org.protections.rootOnlyDesc',
  'org.protections.goRootGroup',
  ...PROTECTION_FIELD_KEYS.map(key => `org.protections.fields.${key}`),
  // 动态键：PR 详情评审人状态徽标
  ...REVIEW_STATE_KEYS.map(key => `pulls.reviewState.${key}`),
  // 动态键：PR 可合并状态
  ...MERGEABLE_STATE_KEYS.map(key => `pulls.mergeableState.${key}`),
]

describe('批次 2 文案：三语齐备（must-have 键逐条校验）', () => {
  it.each(LOCALES)('%s 包含全部批次 2 键', (locale) => {
    const missing = BATCH2_KEYS.filter(key => !(key in messages[locale]))
    expect(missing, `${locale} 缺少键：${missing.join(', ')}`).toEqual([])
  })

  it('批次 2 文案非空（占位/空串会导致界面空白）', () => {
    for (const locale of LOCALES) {
      for (const key of BATCH2_KEYS) {
        expect(messages[locale][key]?.trim(), `${locale} 的 ${key} 为空`).toBeTruthy()
      }
    }
  })
})

describe('批次 2 文案：命名空间三语结构对齐（防单语漏键）', () => {
  const NAMESPACES = [
    'repo.annotations',
    'repo.properties',
    'repo.members',
    'repo.pulls.review',
    'org.protections',
  ]

  it.each(NAMESPACES)('%s 键集合在 en / zh-CN / zh-TW 完全一致', (namespace) => {
    const enKeys = namespaceKeys(messages.en, namespace)
    // 命名空间本身必须非空（防止整体挂错位置，如批次 2 里 repo.members 曾误挂顶层）
    expect(enKeys.length, `${namespace} 不应为空命名空间`).toBeGreaterThan(0)
    for (const locale of ['zh-CN', 'zh-TW'] as const) {
      const other = namespaceKeys(messages[locale], namespace)
      expect(other, `${locale} 的 ${namespace} 键集合与 en 不一致`).toEqual(enKeys)
    }
  })

  it('仓库成员页签与组织成员页各用独立命名空间（repo.members.* / members.*）', () => {
    // 组织成员页（members.vue 组织视图）用顶层 members.*，仓库成员面板用
    // repo.members.*：两个命名空间并存但互不依赖，任一方的键缺失都由
    // 上面的 must-have 清单拦截，这里锚定两套前缀都真实存在
    expect('members.batchLoadPerms' in messages.en).toBe(true)
    expect('repo.members.batchLoadPerms' in messages.en).toBe(true)
    expect('members.joined' in messages.en).toBe(true)
    expect('repo.members.inheritTitle' in messages.en).toBe(true)
  })
})

describe('批次 2 文案：占位符与消息语法', () => {
  it('同一键三语占位符名称完全一致（顺序无关）', () => {
    const mismatched: string[] = []
    for (const key of BATCH2_KEYS) {
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

  it('带占位符的键在中文里同样带占位符（partialFailed 的 {count} / deleteDesc 的 {key}）', () => {
    const withPlaceholder = BATCH2_KEYS.filter(key => placeholders(messages.en[key] ?? '').length > 0)
    expect(withPlaceholder.length).toBeGreaterThan(0)
    expect(withPlaceholder).toContain('repo.properties.partialFailed')
    expect(withPlaceholder).toContain('repo.annotations.deleteDesc')
    expect(withPlaceholder).toContain('org.protections.deleteDesc')
    for (const key of withPlaceholder) {
      expect(placeholders(messages['zh-CN'][key] ?? '')).toEqual(placeholders(messages.en[key]))
      expect(placeholders(messages['zh-TW'][key] ?? '')).toEqual(placeholders(messages.en[key]))
    }
  })

  it('无裸 @ / 裸 |（vue-i18n 会当作 linked message 与复数分隔）', () => {
    const unsafe: string[] = []
    for (const locale of LOCALES) {
      for (const key of BATCH2_KEYS) {
        const message = messages[locale][key] ?? ''
        // 允许官方转义写法 {'@'} / {'|'}
        const stripped = message.replace(/\{'@'\}/g, '').replace(/\{'\|'\}/g, '')
        if (stripped.includes('@')) {
          unsafe.push(`${locale}/${key}（裸 @）: ${message}`)
        }
        if (stripped.includes('|')) {
          unsafe.push(`${locale}/${key}（裸 |）: ${message}`)
        }
      }
    }
    expect(unsafe, unsafe.join(' | ')).toEqual([])
  })
})
