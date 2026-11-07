/**
 * 仓库详情页 query 参数读写封装（唯一定义处，设计文档 §3）。
 *
 * 为什么收口：仓库详情用 catch-all 路由 + query 定位视图（catch-all 之后
 * 无法再挂静态子路由），replace/push 语义与非法值清洗必须单点生效，
 * 禁止页面内散写 router.push({ query })。
 *
 * 语义约定：
 * - 页签切换（tab/state/keyword/page）→ replace，不污染历史；
 * - 下钻（文件路径 / number / sn / sha）→ push，返回键可用；
 * - state/keyword 变更重置 page=1；切换 ref 清空 path/sha。
 */
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'

/** 合法页签（非法值归一为 code） */
export type RepoTab = 'code' | 'commits' | 'issues' | 'pulls' | 'builds'
const TABS: RepoTab[] = ['code', 'commits', 'issues', 'pulls', 'builds']

/** 正整数校验：number/sn 非法（0/负数/非数字）时页面直接渲染"未找到"态 */
export function parsePositiveInt(raw: unknown): number | null {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

/**
 * 仓库详情页 query 读写组合式函数。
 * 返回的各字段均为响应式 computed（随路由变化自动更新）；
 * 导航方法已按 §3 语义表实现 replace/push 与参数清洗。
 */
export function useRepoRoute() {
  const route = useRoute()
  const router = useRouter()

  // catch-all 参数是数组（多级子组织路径），join('/') 后才是仓库路径。
  // 类型断言：route-map.d.ts 的参数类型随页面文件生成，此处统一按
  // Record<string, string | string[]> 读取，避免生成时序导致类型收窄为 never
  const repoPath = computed(() => {
    const raw = (route.params as Record<string, string | string[]>).repoPath
    const segments = Array.isArray(raw) ? raw : raw ? [raw] : []
    return segments.map(decodeURIComponent).filter(Boolean).join('/')
  })

  /** 当前页签（非法值归一为 code） */
  const tab = computed<RepoTab>(() => {
    const value = String(route.query.tab || 'code')
    return (TABS as string[]).includes(value) ? value as RepoTab : 'code'
  })

  /** 当前 ref（分支名/标签名/SHA；缺省由页面用 git/head.name 兜底） */
  const refName = computed(() => {
    const raw = route.query.ref
    return typeof raw === 'string' && raw ? raw : ''
  })

  /** 当前文件/目录路径（缺省为根目录） */
  const filePath = computed(() => {
    const raw = route.query.path
    return typeof raw === 'string' && raw ? raw : ''
  })

  /** Issue/PR 编号（非正整数 → null，页面渲染"未找到"态不发请求） */
  const number = computed(() => parsePositiveInt(route.query.number))

  /** 构建序号（仅作展示用字符串，非法空值由页面兜底） */
  const sn = computed(() => {
    const raw = route.query.sn
    return typeof raw === 'string' && raw ? raw : ''
  })

  /** 提交详情 SHA（提交页签的详情展开） */
  const sha = computed(() => {
    const raw = route.query.sha
    return typeof raw === 'string' && raw ? raw : ''
  })

  /** 列表状态筛选（tab 语义不同：issues 为 open/closed，pulls 为 open/closed/all） */
  const state = computed(() => {
    const raw = route.query.state
    return typeof raw === 'string' && raw ? raw : ''
  })

  /** 页码（非法值归一为 1） */
  const page = computed(() => parsePositiveInt(route.query.page) ?? 1)

  /** Issue 搜索关键词（回车触发写入） */
  const keyword = computed(() => {
    const raw = route.query.keyword
    return typeof raw === 'string' && raw ? raw : ''
  })

  /** 合并 query 变更并导航（mode 决定 replace/push；resetPage 时清 page） */
  function navigate(partial: Record<string, string | number | null>, mode: 'replace' | 'push' = 'replace') {
    const query: Record<string, string> = {}
    // 保留既有 query 中未被本次变更覆盖的键（跳转时逐个显式清空的除外）
    for (const [key, value] of Object.entries(route.query)) {
      if (typeof value === 'string' && value && !(key in partial)) {
        query[key] = value
      }
    }
    for (const [key, value] of Object.entries(partial)) {
      if (value === null || value === '') {
        delete query[key]
      }
      else {
        query[key] = String(value)
      }
    }
    void router[mode]({ path: route.path, query })
  }

  /** 切换页签：replace（不污染历史） */
  function switchTab(value: RepoTab) {
    navigate({ tab: value === 'code' ? null : value }, 'replace')
  }

  /** 打开文件/目录（代码页签下钻）：push，面包屑回跳同为 push */
  function openPath(path: string) {
    navigate({ tab: 'code', path }, 'push')
  }

  /** 切换 ref（分支/标签）：replace 且清空 path/sha（内容源已变，旧定位失效） */
  function switchRef(value: string) {
    navigate({ ref: value, path: null, sha: null }, 'replace')
  }

  /** 打开 Issue 详情：push（保留列表筛选态于 query 中） */
  function openIssue(value: string | number) {
    navigate({ tab: 'issues', number: value }, 'push')
  }

  /** 打开 PR 详情：push */
  function openPull(value: string | number) {
    navigate({ tab: 'pulls', number: value }, 'push')
  }

  /** 打开构建详情：push */
  function openBuild(value: string) {
    navigate({ tab: 'builds', sn: value }, 'push')
  }

  /** 打开提交详情（提交页签展开）：push */
  function openCommit(value: string) {
    navigate({ tab: 'commits', sha: value }, 'push')
  }

  /** 回到列表视图（清 number/sn/sha/path 定位参数，保留筛选态）：push */
  function backToList() {
    navigate({ number: null, sn: null, sha: null, path: null }, 'push')
  }

  /** 更新列表筛选状态：replace 且重置 page=1 */
  function setState(value: string) {
    navigate({ state: value, page: null }, 'replace')
  }

  /** 更新搜索关键词：replace 且重置 page=1 */
  function setKeyword(value: string) {
    navigate({ keyword: value || null, page: null }, 'replace')
  }

  /** 翻页：replace */
  function setPage(value: number) {
    navigate({ page: value <= 1 ? null : value }, 'replace')
  }

  return {
    repoPath,
    tab,
    refName,
    filePath,
    number,
    sn,
    sha,
    state,
    page,
    keyword,
    switchTab,
    openPath,
    switchRef,
    openIssue,
    openPull,
    openBuild,
    openCommit,
    backToList,
    setState,
    setKeyword,
    setPage,
  }
}
