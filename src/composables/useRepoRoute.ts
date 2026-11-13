/**
 * 仓库详情页 query 参数读写封装（唯一定义处，设计文档 §3）。
 *
 * 为什么收口：仓库详情用 catch-all 路由 + query 定位视图（catch-all 之后
 * 无法再挂静态子路由），replace/push 语义与非法值清洗必须单点生效，
 * 禁止页面内散写 router.push({ query })。
 *
 * 语义约定：
 * - 页签切换（tab/state/keyword/page）→ replace，不污染历史；
 * - 下钻（文件路径 / number / sn / sha / release / pname / ptag）→ push，返回键可用；
 * - state/keyword 变更重置 page=1；切换 ref 清空 path/sha；
 * - 切换页签时清空全部下钻键（§6 R3 回归修复：下钻键跨页签残留会让
 *   "从制品库切到 Releases 却直接打开某个 Release"这类错误发生）。
 */
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'

/**
 * 合法页签（非法值归一为 code）。
 * 8 页签：5 个既有页签 + Releases / 制品库 / 社区（设计文档 §2.3 D3）。
 */
export type RepoTab =
  | 'code'
  | 'commits'
  | 'issues'
  | 'pulls'
  | 'builds'
  | 'releases'
  | 'packages'
  | 'community'

const TABS: RepoTab[] = [
  'code',
  'commits',
  'issues',
  'pulls',
  'builds',
  'releases',
  'packages',
  'community',
]

/**
 * 制品类型枚举（dto.PackageType，swagger 核对 13 值）。
 *
 * 为什么定义在路由层而不是数据层：`ptype` 是 URL 契约的一部分
 * （?tab=packages&ptype=docker），非法值归一规则要求"单点实现，禁止
 * 页面内判断"（设计文档 §2.3），而归一必须知道合法值集合。
 * T08 制品库数据层（useCnbPackages）将从此处导入复用，不再重复定义。
 */
export type PackageType =
  | 'all'
  | 'docker'
  | 'helm'
  | 'oci'
  | 'npm'
  | 'maven'
  | 'ohpm'
  | 'pypi'
  | 'composer'
  | 'nuget'
  | 'conan'
  | 'cargo'
  | 'generic'

/** 制品类型全集（顺序即 UI 下拉展示顺序；all 恒在最前） */
export const PACKAGE_TYPES: PackageType[] = [
  'all',
  'docker',
  'helm',
  'oci',
  'npm',
  'maven',
  'ohpm',
  'pypi',
  'composer',
  'nuget',
  'conan',
  'cargo',
  'generic',
]

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

  /**
   * Release 详情定位（Releases 页签下钻）。
   * 归一规则（设计文档 §2.3）：空串/缺失 → ''，渲染列表；
   * 有值则渲染详情，详情 404 由页面渲染 notFound 态（不自动回列表）。
   */
  const release = computed(() => {
    const raw = route.query.release
    return typeof raw === 'string' && raw ? raw : ''
  })

  /**
   * 制品类型筛选（制品库页签）。
   * 归一规则：缺失/不在 PackageType 枚举 → 'all'（左栏请求 type=all）。
   * 为什么保留 'all' 而非清空：type=all 是"看全部制品"的用户偏好，
   * 与下钻定位键（pname/ptag）语义不同。
   */
  const ptype = computed<PackageType>(() => {
    const raw = route.query.ptype
    return typeof raw === 'string' && (PACKAGE_TYPES as string[]).includes(raw)
      ? raw as PackageType
      : 'all'
  })

  /** 选中的制品名（空 → 只渲染左栏） */
  const pname = computed(() => {
    const raw = route.query.pname
    return typeof raw === 'string' && raw ? raw : ''
  })

  /**
   * 选中的制品 tag（三栏下钻）。
   * 归一规则：ptag 有值但 pname 缺失时丢弃 ptag —— 三栏视图需要
   * "类型 + 制品 + tag"完整链式上下文，残缺链会导致右栏请求必然失败。
   */
  const ptag = computed(() => {
    const raw = route.query.ptag
    if (!(typeof raw === 'string' && raw) || !pname.value) {
      return ''
    }
    return raw
  })

  /**
   * 提交比较视图开关（提交页签下钻，T11）。
   * 归一规则：'1' → true，其余/缺失 → false（列表视图）。
   */
  const compare = computed(() => route.query.compare === '1')

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

  /**
   * 切换页签：replace（不污染历史）。
   *
   * §6 R3 回归修复：navigate() 会保留未被覆盖的 query 键，若不显式清空，
   * 下钻键（sn/release/pname/ptag…）会跨页签残留，出现"从构建详情切到
   * Releases 却直接打开某个 Release"的错误。因此切换页签时**显式清空
   * 全部下钻键**；ptype 保留（用户筛选偏好，切走再切回不丢失）。
   */
  function switchTab(value: RepoTab) {
    navigate({
      tab: value === 'code' ? null : value,
      // —— 下钻定位键：全部清空（8 个 + compare）——
      number: null,
      sn: null,
      sha: null,
      path: null,
      release: null,
      pname: null,
      ptag: null,
      compare: null,
      // 翻页状态属于列表视图，切页签后旧页码无意义
      page: null,
      // ptype 保留：用户偏好而非定位状态
    }, 'replace')
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

  /** 打开提交比较视图（提交页签下钻，T11）：push，返回键可用 */
  function openCompare() {
    navigate({ tab: 'commits', compare: '1', sha: null }, 'push')
  }

  /** 关闭提交比较视图（回到提交列表）：push */
  function closeCompare() {
    navigate({ compare: null }, 'push')
  }

  /**
   * 打开 Release 详情（Releases 页签下钻）：push，返回键可用。
   * value 为服务端 Release id（字符串，非 git tag）。
   */
  function openRelease(value: string) {
    navigate({ tab: 'releases', release: value }, 'push')
  }

  /**
   * 打开制品（制品库中栏 tag 列表）：push。
   * type 为具体制品类型（不会是 'all' —— all 时无法定位单个制品）。
   */
  function openPackage(name: string, type: PackageType) {
    navigate({ tab: 'packages', ptype: type, pname: name, ptag: null }, 'push')
  }

  /**
   * 打开制品 tag 详情（制品库右栏）：push。
   * ptype/pname/ptag 三键同时写入，保证 URL 可完整恢复三栏视图。
   */
  function openPackageTag(name: string, type: PackageType, tag: string) {
    navigate({ tab: 'packages', ptype: type, pname: name, ptag: tag }, 'push')
  }

  /**
   * 关闭制品 tag 详情（右栏 → 中栏）：push，仅清 ptag。
   * 与 openPackageTag 对称的下钻退出键，保证浏览器返回键与界面按钮语义一致。
   */
  function closePackageTag() {
    navigate({ ptag: null }, 'push')
  }

  /**
   * 关闭制品详情（中/右栏 → 左栏列表）：push，清 pname + ptag。
   * ptype 保留（用户筛选偏好，与 switchTab 同口径）。
   */
  function closePackage() {
    navigate({ pname: null, ptag: null }, 'push')
  }

  /**
   * 更新制品类型筛选：replace 且清空 pname/ptag（旧制品与旧 tag 不属于
   * 新类型，残缺链会让中/右栏请求必然失败）。'all' 为缺省值，写 null。
   */
  function setPtype(value: PackageType) {
    navigate({
      ptype: value === 'all' ? null : value,
      pname: null,
      ptag: null,
    }, 'replace')
  }

  /** 回到列表视图（清定位参数，保留筛选态）：push */
  function backToList() {
    navigate({ number: null, sn: null, sha: null, path: null, release: null }, 'push')
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
    release,
    ptype,
    pname,
    ptag,
    compare,
    switchTab,
    openPath,
    switchRef,
    openIssue,
    openPull,
    openBuild,
    openCommit,
    openCompare,
    closeCompare,
    openRelease,
    openPackage,
    openPackageTag,
    closePackageTag,
    closePackage,
    setPtype,
    backToList,
    setState,
    setKeyword,
    setPage,
  }
}
