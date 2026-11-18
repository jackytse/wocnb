/**
 * 三语 locale 键集合一致性校验（设计文档 §8.4 / 风险 R12）。
 *
 * 背景：新增页面只加 zh-CN 是高频翻车点 —— vue-i18n 缺键时静默回退英文，
 * 不会报错，问题往往在 UI 上线后才被发现。本用例递归比对三个语言包的
 * **键集合**（值不比对），任一语言缺键/多键即 fail，纳入 pnpm test 把关。
 */
import { describe, expect, it, vi } from 'vitest'
import { i18n } from '../../i18n'
import en from '../en'
import zhCN from '../zh-CN'
import zhTW from '../zh-TW'

/** 递归收集对象的全部叶键路径（如 'repo.settings.archive'） */
function collectKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  const keys: string[] = []
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      keys.push(...collectKeys(value as Record<string, unknown>, path))
    }
    else {
      keys.push(path)
    }
  }
  return keys
}

/** 数组化排序后逐元素比较（顺序无关的集合一致性） */
function sortedSet(keys: string[]): string[] {
  return [...keys].sort()
}

const enKeys = sortedSet(collectKeys(en as Record<string, unknown>))
const zhCNKeys = sortedSet(collectKeys(zhCN as Record<string, unknown>))
const zhTWKeys = sortedSet(collectKeys(zhTW as Record<string, unknown>))

describe('locale 键集合一致性（三语同步，R12）', () => {
  it('en 与 zh-CN 键集合完全一致', () => {
    expect(zhCNKeys).toEqual(enKeys)
  })

  it('en 与 zh-TW 键集合完全一致', () => {
    expect(zhTWKeys).toEqual(enKeys)
  })

  it('新增命名空间存在于三语包（本批次新增的键抽查）', () => {
    // 抽查本批次引入的代表性键，防止"测试通过但全是旧键"的假阳性
    const mustHave = [
      'repo.tabs.releases',
      'repo.tabs.packages',
      'repo.tabs.community',
      'repo.settings.archive',
      'repo.settings.visibilityLocked',
      'repo.releases.deleteConfirm',
      'repo.releases.assetUploadDeferred',
      'builds.trigger',
      'builds.stopConfirm',
      'builds.deleteLogsConfirm',
      'repos.create.title',
      'common.save',
      'common.copyPath',
    ]
    for (const key of mustHave) {
      expect(enKeys, `en 缺少 ${key}`).toContain(key)
      expect(zhCNKeys, `zh-CN 缺少 ${key}`).toContain(key)
      expect(zhTWKeys, `zh-TW 缺少 ${key}`).toContain(key)
    }
  })
})

/**
 * 源码引用的 key 必须存在 —— 拦截「页面写了 t('x.y')，语言包却漏加」的问题。
 *
 * 背景（2026-11-18 截图报障）：个人资料页的社交区块引用了
 * `profile.followers / following / starCountLabel / tabMyStars / tabPinnedWall /
 * starsEmpty / starsEmptyDesc` 七个 key，三语包都没加。vue-i18n 缺键时**不报错**，
 * 直接把 key 名当文案渲染，UI 上就出现 "profile.followers 0" 这种诡异文本。
 * 原有的「三语键集合一致」用例只比对三个包彼此是否同步，漏加是「三语一起漏」，
 * 所以它照样全绿 —— 必须再加一道「代码 → 语言包」的反向校验。
 *
 * 局限：只识别 `t('literal')` / `$t('literal')` / `i18n.global.t('literal')` 这类
 * **静态字符串**；模板字符串拼出来的动态 key（如 `t(\`repo.${x}\`)`）无法静态判定，
 * 跳过不误报。
 */
describe('源码引用的 i18n key 均存在于三语包', () => {
  /**
   * 用 vite 的 glob 在构建期把 src 下所有 .vue/.ts 以「纯文本」导入。
   *
   * 为什么不用 node:fs：app 的 tsconfig 只引了 vite/client 类型、没装 @types/node，
   * 而这是浏览器侧代码，不该为一条测试给全局开 node 类型（那会让 app 代码误用
   * fs/process 也能通过类型检查）。?raw 导入既零依赖，也天然受 include 范围约束。
   */
  const sources = import.meta.glob('../../**/*.{vue,ts}', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>

  it('每个 t(\'x.y\') 引用的 key 都能在 en / zh-CN / zh-TW 找到', () => {
    const keyUse = /(?:^|[^\w$.])\$?t\(\s*['"]([\w.-]+)['"]/gm
    // key → 首次出现的文件（报错时直接给位置，省得再全局搜一遍）
    const used = new Map<string, string>()
    for (const [file, code] of Object.entries(sources)) {
      // 语言包本身与测试目录不放业务文案引用，跳过（否则注释里的示例会被误判）
      if (/\/locales\//.test(file) || /__tests__/.test(file) || /\.test\.ts$/.test(file)) {
        continue
      }
      for (const m of code.matchAll(keyUse)) {
        const key = m[1]
        // 只要带命名空间的键（`common.save` 这类）；单段字符串多为误匹配
        if (!key.includes('.')) continue
        if (!used.has(key)) used.set(key, file.replace('../../', ''))
      }
    }
    // 三语各自建集合，逐语报告缺失项（一次列全，避免改一个跑一次）
    const dictionaries: Array<[string, string[]]> = [
      ['en', enKeys],
      ['zh-CN', zhCNKeys],
      ['zh-TW', zhTWKeys],
    ]
    const problems: string[] = []
    for (const [locale, keys] of dictionaries) {
      const set = new Set(keys)
      for (const [key, file] of used) {
        if (!set.has(key)) problems.push(`${locale} 缺少 ${key}（引用于 ${file}）`)
      }
    }
    // 兜底：至少扫到一定数量，防止正则失效导致"零引用"假绿
    expect(used.size).toBeGreaterThan(100)
    expect(problems).toEqual([])
  })
})

/**
 * 消息「可编译」检查 —— 拦截只在运行时才炸的一类 bug。
 *
 * 背景（2026-11-11 组织设置实测踩到）：vue-i18n 的 message 语法把 `@` 当作
 * linked message 的起始符（`@:key` / `@.modifier:key`），把 `|` 当作复数分隔符，
 * 把 `{` `}` 当作插值。于是像 `name@example.com`（邮箱占位符）或
 * 「仅仓库成员可 @NPC」这类文案，**类型检查、键一致性、构建全都通过**，
 * 一渲染就在控制台抛 "Invalid linked format" 并把整句退化成 key 字面量。
 *
 * 本用例把三语所有消息逐个交给 vue-i18n 编译一遍，捕获编译期的
 * console.warn / console.error。写法约定：字面量的 `@` 用 `{'@'}` 插值转义。
 */
describe('locale 消息可编译（捕获运行时才炸的特殊字符）', () => {
  it('三语全部消息都能被 vue-i18n 编译，无 Invalid format 告警', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const locales = {
      'zh-CN': zhCN as Record<string, unknown>,
      'en': en as Record<string, unknown>,
      'zh-TW': zhTW as Record<string, unknown>,
    }
    // 直接复用应用全局实例：它的 messages 类型已由 i18n.ts 正确推导。
    // 不自建实例的原因：createI18n 的 messages 入参是递归约束类型，我们手里
    // 只有 Record<string, unknown>，硬塞需要 `as never`，那会让 TS 在深层
    // 泛型上炸出 TS2589（excessively deep），得不偿失。
    const composer = i18n.global
    const originalLocale = composer.locale.value
    const failures: string[] = []
    try {
      for (const [locale, messages] of Object.entries(locales)) {
        composer.locale.value = locale as typeof composer.locale.value
        for (const key of collectKeys(messages)) {
          warn.mockClear()
          error.mockClear()
          // vue-i18n 的编译错误有两种表现：默认 onError 打 warn，某些语法
          // （如 `a@b.com` 走到 readTokenInLinked）直接抛异常。两条都要接住，
          // 否则一个坏键就把整个用例变成"未捕获异常"，看不出是哪个键的问题。
          try {
            composer.t(key)
          }
          catch (err) {
            failures.push(`${locale} ${key}: ${(err as Error)?.message || String(err)}`)
            continue
          }
          if (warn.mock.calls.length > 0 || error.mock.calls.length > 0) {
            const detail = [...warn.mock.calls, ...error.mock.calls]
              .map(args => args.map(String).join(' '))
              .join(' | ')
            failures.push(`${locale} ${key}: ${detail}`)
          }
        }
      }
    }
    finally {
      // 无论断言结果如何都还原全局 locale，避免污染同进程内其它用例
      composer.locale.value = originalLocale
      warn.mockRestore()
      error.mockRestore()
    }
    // 失败时列出全部问题键（一条条修比逐个跑测试快得多）
    expect(failures).toEqual([])
  })
})
