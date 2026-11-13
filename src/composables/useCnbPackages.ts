/**
 * 制品库数据层（设计文档 §3.4，T08）—— 本轮归一化最复杂的模块。
 *
 * 覆盖端点（swagger 逐条核对）：
 * - GET /{slug}/-/packages?type=&page=&page_size=&name=&ordering=
 *   （scope registry-package:r；**type 必填**，枚举见 PackageType）
 * - GET /{slug}/-/packages/{type}/{name} → dto.PackageDetail（多态）
 * - GET /{slug}/-/packages/{type}/{name}/-/tags → dto.Tag（多态）
 * - GET …/-/tag/{tag}?sha256=&arch= → dto.TagDetail（多态；docker 的
 *   arch 参数是 docker 制品的必填项，如 linux/amd64/v3）
 * - GET …/-/tag/{tag}/provenance → dto.Provenance（多态）
 * - DELETE /{slug}/-/packages/{type}/{name}（scope registry-package-delete:rw）
 * - DELETE …/-/tag/{tag}（同 scope）
 *
 * 路径编码口径（重点）：swagger 把 {name} 声明为**单个 path 段**，而制品名
 * （尤其 docker，形如 my/app）本身含 '/' —— 必须整段 encodeURIComponent
 * 把 '/' 编成 %2F，才能不破坏路径结构。因此本模块对 name/tag 用整段编码，
 * 与 encodeSlug 的"逐段编码"是两种不同口径，禁止混用。
 *
 * 多态归一化要点（全在 pickByType + 各 normalize 函数锁定）：
 * - dto.PackageDetail / Tag / TagDetail / Provenance 都是 12 个类型键并存、
 *   只有一个非空的巨对象 → **一律 pickByType(raw, type)，禁止硬编码 raw.docker**；
 * - 列表条目用 `name`，详情用 `tag`（归一化 `tag ?? name`）；
 * - docker 的 dto.ContainerTag **没有 size/digest/status** → 从 images[]
 *   派生：size = Σ images[].size、digest = images[0]?.digest、arches = images[].arch。
 */
import { cnbFetch, CnbApiError } from './useCnbAuth'

/**
 * 制品类型枚举（dto.PackageType，swagger 13 值）—— 从路由层取的原因（§8.2
 * 边界划分手记，非抄错）：`ptype` 是 URL 契约的一部分，合法性校验必须由
 * URL 契约所有者（useRepoRoute）定义，数据层只消费同一个常量，避免两处
 * 各自维护一份类型清单后漂移。这是 type-level + 常量数组的单向依赖，
 * 路由层不反向依赖数据层。pickByType 等**制品域归一逻辑**仍留在本模块。
 */
import { PACKAGE_TYPES, type PackageType } from './useRepoRoute'
export type { PackageType }

/** 仓库/组织路径 -> API URL 路径段：逐段 encodeURIComponent（'/' 保留为分隔符） */
function encodeSlug(slug: string): string {
  return slug.split('/').map(encodeURIComponent).join('/')
}

// ---------------------------------------------------------------------------
// pickByType：多态取键纯函数（供单测，T08-1）
// ---------------------------------------------------------------------------

/**
 * 从多态响应中按类型取子对象/子数组。
 *
 * 规则：
 * 1. raw[type] 存在且非空（非 null/非空数组/非空对象）→ 直接返回；
 * 2. 否则回退**首个非空**的类型键（服务端可能在个别部署上把详情挂在
 *    相邻类型键下，如 oci 与 docker 结构高度相似）；
 * 3. 全空 → null。
 *
 * 注意：跳过 'package' 键 —— dto.Tag 等多态响应里的 `package` 是制品
 * 标识字符串，不是类型子对象，绝不能被回退逻辑选中。
 *
 * @param raw 参数放宽为 unknown：非对象输入（字符串/数字等脏数据）
 * 一律返回 null，调用方无需预判类型
 */
export function pickByType<T>(raw: unknown, type: string): T | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null
  }
  const record = raw as Record<string, unknown>
  // 类型键全集：PACKAGE_TYPES 去掉 'all'（'all' 不是真实类型键）
  const typeKeys = PACKAGE_TYPES.filter(t => t !== 'all')

  /** 判定"非空"：null/undefined/空数组/空对象/空串都不算 */
  const isPresent = (value: unknown): boolean => {
    if (value === null || value === undefined || value === '') {
      return false
    }
    if (Array.isArray(value)) {
      return value.length > 0
    }
    if (typeof value === 'object') {
      return Object.keys(value as Record<string, unknown>).length > 0
    }
    return true
  }

  // 规则 1：优先取请求的类型键（type 可能不在枚举内，如服务端新增类型）
  const exact = record[type]
  if (isPresent(exact) && type !== 'package') {
    return exact as T
  }
  // 规则 2：按类型键顺序回退首个非空键（跳过 'package' 标识键）
  for (const key of typeKeys) {
    if (key === type) {
      continue
    }
    const value = record[key]
    if (isPresent(value)) {
      return value as T
    }
  }
  // 规则 3：全空
  return null
}

// ---------------------------------------------------------------------------
// 原始结构（snake_case，仅声明归一化用到的字段）
// ---------------------------------------------------------------------------

/** dto.Package 原始结构 */
interface RawPackage {
  name?: string
  package?: string
  description?: string
  count?: number
  labels?: string[]
  guarded?: boolean
  is_dir?: boolean
  pull_count?: number
  recent_pull_count?: number
  last_artifact_name?: string
  last_pusher?: { name?: string, nickname?: string, push_at?: string }
  /** 可能是字符串枚举或对象（服务端版本差异），归一化时兼容 */
  package_type?: unknown
}

/** dto.Tag 多态响应中的标签条目（CommonRegistryTag / ContainerTag / ChartTag / OCITag 并集） */
interface RawTagItem {
  name?: string
  tag?: string
  desc?: string
  digest?: string
  size?: number
  pull_count?: number
  recent_pull_count?: number
  guarded?: boolean
  /** docker 专属：镜像列表（size/digest/arch 由此派生） */
  images?: { size?: number, digest?: string, arch?: string, os?: string }[]
  has_provenance?: boolean
  status?: string
  last_pusher?: { name?: string, nickname?: string, push_at?: string }
}

/** dto.TagDetail 多态响应条目（CommonRegistryTagDetail / ContainerTagDetail 并集） */
interface RawTagDetail extends RawTagItem {
  address?: string
  package?: string
  git_address?: string
  /** docker 详情：主镜像（arch/size/digest 由此取） */
  image?: { size?: number, digest?: string, arch?: string }
  /** 返回结果是否与请求的 arch 匹配（docker，请求带 arch 时返回） */
  matches_requested_arch?: boolean
}

/** dto.Provenance 多态响应条目（CommonRegistryProvenance / ContainerProvenance 等公共子集） */
interface RawProvenance {
  digest?: string
  git_address?: string
  git_commit?: string
  registry_address?: string
  sn?: string
  tag?: string
  package?: string
}

// ---------------------------------------------------------------------------
// 归一化导出类型
// ---------------------------------------------------------------------------

/** 制品列表项（dto.Package 归一化后） */
export interface PackageItem {
  name: string
  type: string
  description: string
  labels: string[]
  versionCount: number
  pullCount: number
  recentPullCount: number
  lastPusherName: string
  lastPushedAt: string
  guarded: boolean
  isDir: boolean
}

/**
 * 中栏 tag 列表项（各类型 tag 统一后的形态）。
 * arches：docker 从 images[].arch 派生（右栏详情请求的必填参数候选值）；
 * 其他类型为空数组。
 */
export interface PackageTagItem {
  name: string
  digest: string
  size: number
  pullCount: number
  recentPullCount: number
  hasProvenance: boolean
  guarded: boolean
  status: string
  lastPusherName: string
  lastPushedAt: string
  arches: string[]
}

/** 右栏 tag 详情（公共字段 + 类型专属原始明细原样保留） */
export interface PackageTagDetail extends PackageTagItem {
  address: string
  packageName: string
  gitAddress: string
  /** 与请求 arch 是否匹配（仅 docker 且带 arch 请求时服务端返回） */
  matchesRequestedArch: boolean | null
  /** 类型专属原始明细（docker 的 image/layers、npm 的 files/dependencies 等） */
  raw: unknown
}

/** 溯源（dto.*Provenance 统一后的公共子集 + 原始 JSON） */
export interface ProvenanceInfo {
  digest: string
  gitAddress: string
  gitCommit: string
  registryAddress: string
  sn: string
  tag: string
  raw: unknown
}

// ---------------------------------------------------------------------------
// 归一化函数
// ---------------------------------------------------------------------------

/** package_type 字段兼容归一：字符串原样；对象取其 type/名称键；其余空串 */
function normalizePackageType(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if (typeof obj.type === 'string') {
      return obj.type
    }
    if (typeof obj.name === 'string') {
      return obj.name
    }
  }
  return ''
}

/** dto.Package → PackageItem（数组恒 []、数字 ?? 0、字符串 || ''） */
function normalizePackage(raw: RawPackage): PackageItem {
  return {
    name: raw.name || raw.package || '',
    type: normalizePackageType(raw.package_type),
    description: raw.description || '',
    labels: Array.isArray(raw.labels) ? raw.labels : [],
    versionCount: raw.count ?? 0,
    pullCount: raw.pull_count ?? 0,
    recentPullCount: raw.recent_pull_count ?? 0,
    lastPusherName: raw.last_pusher?.nickname || raw.last_pusher?.name || '',
    lastPushedAt: raw.last_pusher?.push_at || '',
    guarded: !!raw.guarded,
    isDir: !!raw.is_dir,
  }
}

/**
 * tag 条目归一（列表与详情共用，因为两者字段形态一致）。
 * docker 派生：size = Σ images[].size、digest = images[0]?.digest、
 * arches = images[].arch（过滤空值）。
 */
function normalizeTagItem(raw: RawTagItem): PackageTagItem {
  const images = Array.isArray(raw.images) ? raw.images : []
  const isDocker = images.length > 0
  return {
    // 列表用 name，详情用 tag —— 统一 tag ?? name 兜底
    name: raw.tag || raw.name || '',
    digest: isDocker ? (images[0]?.digest || '') : (raw.digest || ''),
    size: isDocker ? images.reduce((sum, img) => sum + (img.size ?? 0), 0) : (raw.size ?? 0),
    pullCount: raw.pull_count ?? 0,
    recentPullCount: raw.recent_pull_count ?? 0,
    hasProvenance: !!raw.has_provenance,
    guarded: !!raw.guarded,
    status: isDocker ? '' : (raw.status || ''),
    lastPusherName: raw.last_pusher?.nickname || raw.last_pusher?.name || '',
    lastPushedAt: raw.last_pusher?.push_at || '',
    arches: isDocker
      ? [...new Set(images.map(img => img.arch || '').filter(Boolean))]
      : [],
  }
}

/** tag 详情归一：额外展开 address/package/git_address 与 docker 主镜像 arch */
function normalizeTagDetail(raw: RawTagDetail): PackageTagDetail {
  const item = normalizeTagItem(raw)
  const detail: PackageTagDetail = {
    ...item,
    address: raw.address || '',
    packageName: raw.package || '',
    gitAddress: raw.git_address || '',
    // matches_requested_arch 仅 docker 带 arch 请求时返回；缺失为 null（未请求/非 docker）
    matchesRequestedArch: typeof raw.matches_requested_arch === 'boolean' ? raw.matches_requested_arch : null,
    raw,
  }
  // docker 详情没有 images 数组只有主 image：arch/digest/size 从主镜像补
  const primary = raw.image
  if (primary && detail.arches.length === 0 && primary.arch) {
    detail.arches = [primary.arch]
  }
  if (primary && !item.digest && primary.digest) {
    detail.digest = primary.digest
  }
  if (primary && item.size === 0 && primary.size) {
    detail.size = primary.size
  }
  return detail
}

/** 溯源归一（公共子集 + 原始对象；导出供单测） */
export function normalizeProvenance(raw: RawProvenance): ProvenanceInfo {
  return {
    digest: raw.digest || '',
    gitAddress: raw.git_address || '',
    gitCommit: raw.git_commit || '',
    registryAddress: raw.registry_address || '',
    sn: raw.sn || '',
    tag: raw.tag || '',
    raw,
  }
}

// ---------------------------------------------------------------------------
// 读操作
// ---------------------------------------------------------------------------

/**
 * 制品列表（GET /{slug}/-/packages，scope registry-package:r）。
 *
 * type 必填（swagger），默认 'all'。**降级 fanout（§1.4 / R13）**：部分
 * 部署不支持 type=all（400），此时按 PACKAGE_TYPES（去掉 all）逐类型请求
 * 并合并去重 —— 并发限制 3，防止 12 连发撞限流。
 */
export async function fetchPackages(
  slug: string,
  opts: { type?: PackageType, name?: string, page?: number, pageSize?: number, ordering?: string } = {},
): Promise<PackageItem[]> {
  const type = opts.type || 'all'
  try {
    return await fetchPackagesOnce(slug, { type, name: opts.name, page: opts.page, pageSize: opts.pageSize, ordering: opts.ordering })
  }
  catch (err) {
    // 仅 type=all 的 400 触发 fanout（单类型的 400 说明参数/权限有问题，重试无意义）
    if (type !== 'all' || !(err instanceof CnbApiError) || err.status !== 400) {
      throw err
    }
    return fetchPackagesFanout(slug, { name: opts.name, page: opts.page, pageSize: opts.pageSize })
  }
}

/** 单次请求（fanout 的基础调用） */
async function fetchPackagesOnce(
  slug: string,
  opts: { type: PackageType, name?: string, page?: number, pageSize?: number, ordering?: string },
): Promise<PackageItem[]> {
  const query = new URLSearchParams({
    type: opts.type,
    page: String(opts.page ?? 1),
    page_size: String(opts.pageSize ?? 30),
  })
  if (opts.name) {
    query.set('name', opts.name)
  }
  if (opts.ordering) {
    query.set('ordering', opts.ordering)
  }
  const raw = await cnbFetch<RawPackage[]>(`/${encodeSlug(slug)}/-/packages?${query}`)
  if (!Array.isArray(raw)) {
    return []
  }
  return raw.map(normalizePackage)
}

/**
 * fanout 降级：逐类型请求并合并（按 path 去重）。并发限制 3 —— 分批
 * 每批 3 个请求，批次间串行，避免 12 类型同时请求撞网关限流。
 */
async function fetchPackagesFanout(
  slug: string,
  opts: { name?: string, page?: number, pageSize?: number },
): Promise<PackageItem[]> {
  const types = PACKAGE_TYPES.filter(t => t !== 'all')
  const merged: PackageItem[] = []
  const seen = new Set<string>()
  const CONCURRENCY = 3
  for (let i = 0; i < types.length; i += CONCURRENCY) {
    const batch = types.slice(i, i + CONCURRENCY)
    // 单类型失败（该部署没有此类型的数据）静默跳过，不拖垮整体
    const results = await Promise.allSettled(
      batch.map(t => fetchPackagesOnce(slug, { type: t, ...opts })),
    )
    for (const result of results) {
      if (result.status !== 'fulfilled') {
        continue
      }
      for (const item of result.value) {
        const key = `${item.type}|${item.name}`
        if (item.name && !seen.has(key)) {
          seen.add(key)
          merged.push(item)
        }
      }
    }
  }
  return merged
}

/**
 * 制品详情（GET /{slug}/-/packages/{type}/{name}，多态）。
 * type 为具体类型（'all' 时无法定位单个制品，调用方禁止传 all）。
 */
export async function fetchPackageDetail(
  slug: string,
  type: PackageType,
  name: string,
): Promise<PackageItem> {
  const raw = await cnbFetch<Record<string, unknown>>(
    `/${encodeSlug(slug)}/-/packages/${encodeURIComponent(type)}/${encodeURIComponent(name)}`,
  )
  const picked = pickByType<RawPackage & { tags?: RawTagItem[] }>(raw, type)
  if (!picked) {
    // 多态结构异常（无任何非空类型键）：返回骨架，UI 显示空态而非白屏
    return normalizePackage({})
  }
  return normalizePackage(picked)
}

/**
 * tag 列表（GET …/-/tags?page=&page_size=&tag_name=，多态）。
 * @param opts.tagName 服务端 tag 名过滤
 */
export async function fetchPackageTags(
  slug: string,
  type: PackageType,
  name: string,
  opts: { page?: number, pageSize?: number, tagName?: string } = {},
): Promise<PackageTagItem[]> {
  const query = new URLSearchParams({
    page: String(opts.page ?? 1),
    page_size: String(opts.pageSize ?? 50),
  })
  if (opts.tagName) {
    query.set('tag_name', opts.tagName)
  }
  const raw = await cnbFetch<Record<string, unknown>>(
    `/${encodeSlug(slug)}/-/packages/${encodeURIComponent(type)}/${encodeURIComponent(name)}/-/tags?${query}`,
  )
  const picked = pickByType<RawTagItem[]>(raw, type)
  if (!Array.isArray(picked)) {
    return []
  }
  return picked.map(normalizeTagItem).filter(t => t.name)
}

/**
 * tag 详情（GET …/-/tag/{tag}?sha256=&arch=，多态）。
 *
 * ⚠️ docker 制品**必须带 arch**（如 linux/amd64/v3，从列表项 arches 选），
 * 缺失会被服务端 400 —— UI 层应在调用前守卫（无 arch 时显示"该架构信息
 * 不可用"而不是发请求）。
 */
export async function fetchPackageTag(
  slug: string,
  type: PackageType,
  name: string,
  tag: string,
  opts: { arch?: string, sha256?: string } = {},
): Promise<PackageTagDetail> {
  const query = new URLSearchParams()
  if (opts.arch) {
    query.set('arch', opts.arch)
  }
  if (opts.sha256) {
    query.set('sha256', opts.sha256)
  }
  const qs = query.toString()
  const raw = await cnbFetch<Record<string, unknown>>(
    `/${encodeSlug(slug)}/-/packages/${encodeURIComponent(type)}/${encodeURIComponent(name)}/-/tag/${encodeURIComponent(tag)}${qs ? `?${qs}` : ''}`,
  )
  const picked = pickByType<RawTagDetail>(raw, type)
  if (!picked) {
    // 多态结构异常：返回骨架，UI 呈空态
    return normalizeTagDetail({})
  }
  return normalizeTagDetail(picked)
}

/**
 * 溯源（GET …/-/tag/{tag}/provenance，多态）。
 * 404（无溯源信息）由调用方降级为"暂无溯源"区块，不阻断右栏。
 */
export async function fetchPackageProvenance(
  slug: string,
  type: PackageType,
  name: string,
  tag: string,
): Promise<ProvenanceInfo> {
  const raw = await cnbFetch<Record<string, unknown>>(
    `/${encodeSlug(slug)}/-/packages/${encodeURIComponent(type)}/${encodeURIComponent(name)}/-/tag/${encodeURIComponent(tag)}/provenance`,
  )
  const picked = pickByType<RawProvenance>(raw, type)
  if (!picked) {
    return { digest: '', gitAddress: '', gitCommit: '', registryAddress: '', sn: '', tag: '', raw: null }
  }
  return normalizeProvenance(picked)
}

// ---------------------------------------------------------------------------
// 写操作（scope registry-package-delete:rw，UI 按 canManage 预判隐藏入口）
// ---------------------------------------------------------------------------

/**
 * 删除制品（DELETE /{slug}/-/packages/{type}/{name}）。
 * 破坏性操作 —— UI 必须经 ConfirmDialog 输入制品名确认。
 */
export async function deletePackage(slug: string, type: PackageType, name: string): Promise<void> {
  await cnbFetch(
    `/${encodeSlug(slug)}/-/packages/${encodeURIComponent(type)}/${encodeURIComponent(name)}`,
    { method: 'DELETE' },
  )
}

/**
 * 删除制品标签（DELETE …/-/tag/{tag}）。
 * 破坏性操作 —— UI 必须经 ConfirmDialog 输入 tag 名确认。
 */
export async function deletePackageTag(
  slug: string,
  type: PackageType,
  name: string,
  tag: string,
): Promise<void> {
  await cnbFetch(
    `/${encodeSlug(slug)}/-/packages/${encodeURIComponent(type)}/${encodeURIComponent(name)}/-/tag/${encodeURIComponent(tag)}`,
    { method: 'DELETE' },
  )
}
