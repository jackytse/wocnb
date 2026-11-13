/**
 * 探索页数据层（设计文档 §3.8，T15）—— 公共仓库搜索 + 仓库排行榜。
 *
 * 覆盖端点（swagger 逐条核对）：
 * - GET /search/public-repos?key=&topN=（scope repo-basic-info:r）
 *   ⚠️ 搜索参数名是 **key**（不是 q）；topN 默认 10、最大 100；
 *   **无分页参数**（API 不支持，前端禁用分页 UI）；
 *   order_by 仅在 key 为空时生效（搜索态不传）；
 * - GET /ranks/repo/{daily|weekly|annual}?language=&topN=
 *   → dto.GetRankResult { rank_list, updated_at }
 * - GET /ranks/repo/language-list?rankType=（**rankType 必填**）
 *   → dto.RankLanguageList { language: string[] }
 *
 * 归一化范式与全库一致。榜单项展示 increase_star / increase_fork 增量。
 */
import { cnbFetch } from './useCnbAuth'

// ---------------------------------------------------------------------------
// 公共仓库搜索（GET /search/public-repos）
// ---------------------------------------------------------------------------

/** dto.Repos4UserBase 原始结构（仅声明搜索结果用到的字段） */
interface RawSearchRepo {
  path?: string
  name?: string
  description?: string
  star_count?: number
  fork_count?: number
  language?: string
  updated_at?: string
}

/** 搜索结果条目（结果项展示：仓库名/描述/star·fork 数，点击进仓库页） */
export interface SearchRepoItem {
  path: string
  name: string
  description: string
  starCount: number
  forkCount: number
  language: string
  updatedAt: string
}

/**
 * 公共仓库搜索（GET /search/public-repos）。
 *
 * 口径（§7.2 T15 验收 2）：
 * - 空关键词不请求（调用方守卫，本函数仍防御性返回 []）；
 * - topN 可选 10/30/50/100（swagger：默认 10，最大 100）；
 * - **无分页**：端点没有 page 参数，一次拉全 topN；
 * - key 含中文/特殊字符经 URLSearchParams 自动编码。
 */
export async function searchPublicRepos(
  key: string,
  opts: { topN?: 10 | 30 | 50 | 100 } = {},
): Promise<SearchRepoItem[]> {
  const keyword = key.trim()
  if (!keyword) {
    return []
  }
  const query = new URLSearchParams({
    key: keyword,
    topN: String(opts.topN ?? 30),
  })
  const raw = await cnbFetch<RawSearchRepo[]>(`/search/public-repos?${query}`)
  if (!Array.isArray(raw)) {
    return []
  }
  return raw
    .map(item => ({
      path: item.path || '',
      name: item.name || (item.path || '').split('/').pop() || '',
      description: item.description || '',
      starCount: item.star_count ?? 0,
      forkCount: item.fork_count ?? 0,
      language: item.language || '',
      updatedAt: item.updated_at || '',
    }))
    .filter(item => item.path)
}

// ---------------------------------------------------------------------------
// 仓库排行榜（GET /ranks/repo/{daily|weekly|annual}）
// ---------------------------------------------------------------------------

/** 榜单周期枚举（日/周/年三 Tab） */
export type RankType = 'daily' | 'weekly' | 'annual'

/** dto.RankDetailWithIncr 原始结构（仅声明榜单项用到的字段） */
interface RawRankItem {
  path?: string
  name?: string
  description?: string
  star_count?: number
  fork_count?: number
  language?: string
  /** 统计周期内的增量 */
  increase_star?: number
  increase_fork?: number
  updated_at?: string
  web_url?: string
}

/** dto.GetRankResult 原始结构 */
interface RawRankResult {
  rank_list?: RawRankItem[]
  updated_at?: string
}

/** 榜单项（展示 increase_star/increase_fork 增量与 updated_at —— 验收 4） */
export interface RankItem {
  path: string
  name: string
  description: string
  starCount: number
  forkCount: number
  language: string
  increaseStar: number
  increaseFork: number
  updatedAt: string
}

/** 榜单结果（含服务端统计时间） */
export interface RankResult {
  items: RankItem[]
  updatedAt: string
}

/**
 * 仓库排行（GET /ranks/repo/{type}，scope repo-basic-info:r）。
 * @param type 日/周/年榜（daily|weekly|annual）
 * @param opts.language 语言筛选（语言下拉切换后由调用方重拉）
 * @param opts.topN 榜单条数（默认 30）
 */
export async function fetchRepoRank(
  type: RankType,
  opts: { language?: string, topN?: number } = {},
): Promise<RankResult> {
  const query = new URLSearchParams({ topN: String(opts.topN ?? 30) })
  if (opts.language) {
    query.set('language', opts.language)
  }
  const raw = await cnbFetch<RawRankResult>(`/ranks/repo/${type}?${query}`)
  const list = Array.isArray(raw.rank_list) ? raw.rank_list : []
  return {
    items: list
      .map(item => ({
        path: item.path || '',
        name: item.name || (item.path || '').split('/').pop() || '',
        description: item.description || '',
        starCount: item.star_count ?? 0,
        forkCount: item.fork_count ?? 0,
        language: item.language || '',
        increaseStar: item.increase_star ?? 0,
        increaseFork: item.increase_fork ?? 0,
        updatedAt: item.updated_at || '',
      }))
      .filter(item => item.path),
    updatedAt: raw.updated_at || '',
  }
}

// ---------------------------------------------------------------------------
// 语言清单（GET /ranks/repo/language-list?rankType=，rankType 必填）
// ---------------------------------------------------------------------------

/** dto.RankLanguageList 原始结构 */
interface RawLanguageList {
  language?: string[]
  rank_type?: string
}

/**
 * 榜单语言清单（语言下拉数据源）。
 * ⚠️ rankType 必填（swagger）—— 必须传当前榜单周期，语言下拉切换周期时
 * 需要重拉本清单（不同周期的可选语言集可能不同）。
 */
export async function fetchRankLanguageList(type: RankType): Promise<string[]> {
  const raw = await cnbFetch<RawLanguageList>(`/ranks/repo/language-list?rankType=${type}`)
  const list = Array.isArray(raw.language) ? raw.language : []
  return list.filter(Boolean)
}
