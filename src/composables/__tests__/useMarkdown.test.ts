/**
 * useMarkdown 链接改写单测（issue 附件白屏修复）。
 *
 * 背景：CNB issue 评论附件链接是根相对路径（/x.wav 形态），渲染后点击
 * 会绕过全局外链拦截器，Tauri Webview 整页导航到不存在的路径 → 白屏。
 * resolveLinkUrl 把相对 href 改写为 cnb.cool 绝对地址，点击统一走系统
 * 浏览器。本文件锁定改写规则的全部分支（纯函数，node 环境可测）。
 */
import { describe, expect, it } from 'vitest'
import { resolveLinkUrl, type MarkdownContext } from '../useMarkdown'

/** 仓库上下文基准（各用例按需覆写） */
const ctx: MarkdownContext = {
  repoPath: 'jackytse/wocnb',
  ref: 'main',
  dir: 'docs/guide',
}

describe('resolveLinkUrl（Markdown 相对链接改写）', () => {
  it('根相对路径（issue 附件 /-/files/...）→ 拼仓库前缀为绝对 URL', () => {
    expect(resolveLinkUrl('/-/files/issues/1/voice.wav', ctx))
      .toBe('https://cnb.cool/jackytse/wocnb/-/files/issues/1/voice.wav')
    expect(resolveLinkUrl('/-/imgs/2026/a.png', ctx))
      .toBe('https://cnb.cool/jackytse/wocnb/-/imgs/2026/a.png')
  })

  it('根相对路径且无仓库上下文 → 拼站点根兜底（不白屏优先于精确性）', () => {
    expect(resolveLinkUrl('/-/files/issues/1/voice.wav', null))
      .toBe('https://cnb.cool/-/files/issues/1/voice.wav')
  })

  it('ctx 只有 repoPath（Issue/PR/Release 场景，ref 缺省）→ 链接改写照常拼仓库前缀', () => {
    // 回归锁定：wav 链接漏组织/仓库名的缺陷根因 —— 调用方因凑不出 ref
    // 传了 ctx=null。ref 可选化后链接改写只依赖 repoPath
    const repoOnly: MarkdownContext = { repoPath: 'cnb/feedback' }
    expect(resolveLinkUrl('/-/files/issues/211/x/01.wav', repoOnly))
      .toBe('https://cnb.cool/cnb/feedback/-/files/issues/211/x/01.wav')
  })

  it('ctx 无 ref 时裸相对路径 → 无法拼合法 raw URL，保持原样（null）', () => {
    const repoOnly: MarkdownContext = { repoPath: 'cnb/feedback' }
    expect(resolveLinkUrl('record.wav', repoOnly)).toBeNull()
    expect(resolveLinkUrl('./record.wav', repoOnly)).toBeNull()
    expect(resolveLinkUrl('../record.wav', repoOnly)).toBeNull()
  })

  it('./ 与裸相对路径 → 仓库 raw 解析（与图片同款规则，含 dir 基准）', () => {
    expect(resolveLinkUrl('./record.wav', ctx))
      .toBe('https://cnb.cool/jackytse/wocnb/-/raw/main/docs/guide/record.wav')
    expect(resolveLinkUrl('record.wav', ctx))
      .toBe('https://cnb.cool/jackytse/wocnb/-/raw/main/docs/guide/record.wav')
  })

  it('../ 相对路径 → 逐级回退后按 raw 解析', () => {
    expect(resolveLinkUrl('../record.wav', ctx))
      .toBe('https://cnb.cool/jackytse/wocnb/-/raw/main/docs/record.wav')
  })

  it('裸相对路径且无仓库上下文 → 无法定位，保持原样（null）', () => {
    expect(resolveLinkUrl('record.wav', null)).toBeNull()
  })

  it('绝对 http(s) / 协议相对 / data: / 纯锚点 → 不改写（null）', () => {
    expect(resolveLinkUrl('https://cnb.cool/a/b/-/files/x.wav', ctx)).toBeNull()
    expect(resolveLinkUrl('http://example.com', ctx)).toBeNull()
    expect(resolveLinkUrl('//cdn.example.com/x', ctx)).toBeNull()
    expect(resolveLinkUrl('data:text/plain,x', ctx)).toBeNull()
    expect(resolveLinkUrl('#section-1', ctx)).toBeNull()
  })

  it('改写结果以 https://cnb.cool 开头 —— 保证命中全局外链拦截器', () => {
    // 该断言锁定"改写后必然走系统浏览器打开"这一修复目标
    const result = resolveLinkUrl('/-/files/issues/1/voice.wav', ctx)
    expect(result?.startsWith('https://cnb.cool/')).toBe(true)
  })
})
