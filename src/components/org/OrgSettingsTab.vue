<script setup lang="ts">
/**
 * 组织「设置」页签（设计文档 §3 页面结构 / §2.1 / §2.2 / §2.4）。
 *
 * 三段式布局，**每段独立降级**（与组织页其他区块一致的范式）：
 *
 * A. 组织信息（PUT /{group}，scope group-manage:rw）
 *    - 回填 7 个字段：`GET /{group}` 的返回 schema 是 dto.OrganizationAccess，
 *      其中确实含 description / site / email / domain / remark / wechat_mp /
 *      readme_repo_path（早期版本误信"接口不返回"，只回填前两个，用户既看不到
 *      现值也无法清空 —— 2026-11-11 QA 回归 P2-1）；
 *    - 脏检查：7 个字段统一「与基线比较，变化才提交」。`undefined` 表示"不动"，
 *      绝不进请求体（否则会把线上已有值清空）；清空输入框 = 主动清空，提交空串。
 *
 * B. 安全设置（GET / PUT /{slug}/-/settings）
 *    - 4 个布尔开关 + 2 个金额上限 + 邮箱白名单 + 33 个 organization.SettingValue
 *      策略开关（按 8 个语义分组，2 列网格）；
 *    - `can_show_*` 为上级限制位：false 时对应开关 disabled 并说明「上级组织已限制」；
 *      `root_*` 仅只读展示（根组织基线）；
 *    - 保存是**覆盖写**：把当前全部开关拼成 values 串一次性 PUT；未改动时按钮 disabled；
 *    - 403（缺 group-manage:r）只让本段降级为 StateAlert 错误态，A 段/C 段不受影响。
 *
 * C. 危险区
 *    - 转移组织：目标父组织 + ConfirmDialog（confirmColor=error + typeToConfirm 输入
 *      组织名）→ transferGroup → 刷新组织列表（路径已变）；
 *    - 更换 Logo / 删除组织：**刻意不实现调用**（设计文档 §1 D1/D2）：
 *      Logo 需向服务端动态下发的 upload_url PUT 二进制流，而本项目网络出口只有
 *      自建 Rust 命令（body 仅接受 String）；删除组织需要 x-cnb-identity-ticket
 *      （微信扫码二次验证），桌面端无法完成。两者只给说明 + Web 端外跳。
 *
 * 组件不 emit：全部状态内部闭环，父级（group.vue 页签容器）只传 slug/canManage。
 */
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  cnbGroupUrl,
  fetchCnbGroups,
  selectedGroup,
  type CnbApiError,
} from '../../composables/useCnbAuth'
import { fetchOrgOverview } from '../../composables/useCnbOrg'
import {
  buildGroupSettingBody,
  fetchOrgSettings,
  normalizeOrgSettings,
  saveOrgSettings,
  SETTING_VALUE_GROUPS,
  SETTING_VALUES,
  transferGroup,
  updateOrgProfile,
  type OrgProfilePatch,
  type OrgSettings,
} from '../../composables/useCnbOrgSettings'
import StateAlert from '../repo/StateAlert.vue'
import ConfirmDialog from '../common/ConfirmDialog.vue'

const props = defineProps<{
  /** 组织路径（'org' 或 'org/sub'） */
  slug: string
  /** 当前用户是否具备 group-manage:rw（由父级用 canManageRole 判定后传入） */
  canManage: boolean
}>()

const { t } = useI18n()
// useToast 为 Nuxt UI 全局自动导入（见 auto-imports.d.ts）
const toast = useToast()

/** 组织 Web 页地址（403/404 兜底外跳 + 危险区「前往 Web 端」） */
const webUrl = computed(() => cnbGroupUrl(props.slug))

/** 组织名（路径末段）：转移确认的 typeToConfirm 目标文本 */
const orgName = computed(() => props.slug.split('/').filter(Boolean).pop() || props.slug)

// ---------------------------------------------------------------------------
// A. 组织信息
// ---------------------------------------------------------------------------

/** 组织信息表单（空串 = 未填写；除 description/site 外均无法回填） */
interface InfoForm {
  description: string
  site: string
  email: string
  domain: string
  remark: string
  wechatMp: string
  readmeRepoPath: string
}

const info = reactive<InfoForm>({
  description: '',
  site: '',
  email: '',
  domain: '',
  remark: '',
  wechatMp: '',
  readmeRepoPath: '',
})

/**
 * 概览接口回填的基线值（脏检查与「清空」语义都以此为准）。
 *
 * 7 个字段全都来自 `GET /{group}`（dto.OrganizationAccess 含 description /
 * site / email / domain / remark / wechat_mp / readme_repo_path）。
 * 早期实现误以为后 5 个字段接口不返回，只回填了 description/site，把它们
 * 做成"非空才提交"—— 用户既看不到现值，也无法主动清空（QA 回归 P2-1）。
 */
const infoBaseline = reactive<InfoForm>({
  description: '',
  site: '',
  email: '',
  domain: '',
  remark: '',
  wechatMp: '',
  readmeRepoPath: '',
})

/**
 * 同时刷新基线与表单（两处必须同步，否则脏检查会漂：基线是旧值、
 * 表单是新值，用户什么都没改也会显示"有未保存修改"）。
 */
function applyInfoValues(values: InfoForm) {
  Object.assign(infoBaseline, values)
  Object.assign(info, values)
}

const infoLoading = ref(false)
const infoError = ref<CnbApiError | Error | null>(null)
const infoSaving = ref(false)

/**
 * 组装增量补丁（只含用户改动过的键）。
 *
 * 7 个字段统一语义：**与基线比较，变化才提交**（清空输入框 = 主动清空，
 * 提交空串）。前提是这些字段都能回填 —— 用户看得见现值，"删掉"才是明确意图。
 * `undefined` 表示"不动"，永远不会出现在 patch 里（否则会把线上已有值清空）。
 */
function buildInfoPatch(): OrgProfilePatch {
  const patch: OrgProfilePatch = {}
  const fields: [keyof OrgProfilePatch, string][] = [
    ['description', info.description],
    ['site', info.site],
    ['email', info.email],
    ['domain', info.domain],
    ['remark', info.remark],
    ['wechatMp', info.wechatMp],
    ['readmeRepoPath', info.readmeRepoPath],
  ]
  for (const [key, raw] of fields) {
    const value = raw.trim()
    const baseline = String(infoBaseline[key] ?? '').trim()
    if (value !== baseline) {
      patch[key] = value
    }
  }
  return patch
}

/** 是否有待保存的修改（无改动时保存按钮 disabled，避免无意义的空提交） */
const infoDirty = computed(() => Object.keys(buildInfoPatch()).length > 0)

/** 读取组织概览并回填全部可编辑字段（dto.OrganizationAccess） */
async function loadInfo() {
  if (!props.slug) {
    return
  }
  infoLoading.value = true
  infoError.value = null
  try {
    const overview = await fetchOrgOverview(props.slug)
    applyInfoValues({
      description: overview.description,
      site: overview.site,
      email: overview.email,
      domain: overview.domain,
      remark: overview.remark,
      wechatMp: overview.wechatMp,
      readmeRepoPath: overview.readmeRepoPath,
    })
  }
  catch (err) {
    // 保留原始错误对象：StateAlert 按 kind 区分 403（缺 group-resource:r）
    // 与网络错误，403 态提供「管理令牌」外跳且绝不登出（红线 1）
    infoError.value = (err as CnbApiError) ?? new Error(String(err))
  }
  finally {
    infoLoading.value = false
  }
}

/** 保存组织信息：成功后把基线对齐到表单当前值（脏标记随之归零） */
async function saveInfo() {
  if (!props.canManage || !infoDirty.value || infoSaving.value) {
    return
  }
  const patch = buildInfoPatch()
  infoSaving.value = true
  try {
    await updateOrgProfile(props.slug, patch)
    // 基线同步到"表单当前值"而不是 patch：本次没改的字段也要保持回填，
    // 否则保存一次之后那些字段就从界面上消失（体验倒退）
    applyInfoValues({ ...info })
    toast.add({ title: t('org.orgSettings.infoSaved'), color: 'success', duration: 3000 })
  }
  catch (err) {
    // 403（缺 group-manage:rw）/ 400（如 site 缺协议前缀）都透出服务端信息
    toast.add({
      title: t('org.orgSettings.infoSaveFailed'),
      description: (err as Error)?.message || '',
      color: 'error',
      duration: 6000,
    })
  }
  finally {
    infoSaving.value = false
  }
}

// ---------------------------------------------------------------------------
// B. 安全设置
// ---------------------------------------------------------------------------

/** 当前编辑中的设置（normalizeOrgSettings({}) 即全默认值，避免字面量重复） */
const settings = ref<OrgSettings>(normalizeOrgSettings({}))
/**
 * 基线快照（请求体序列化串）。
 * 用「请求体」而不是「归一化对象」做比较：覆盖写的语义由请求体决定，
 * values 已在 toggleValue 中按 SETTING_VALUES 规范顺序重排，
 * 因此同一勾选集合必然产出同一串，不会因点击顺序不同而误判为脏。
 */
const settingsBaseline = ref('')
const settingsLoading = ref(false)
const settingsError = ref<CnbApiError | Error | null>(null)
const settingsSaving = ref(false)

/** 有未保存的改动（无改动时保存按钮 disabled） */
const settingsDirty = computed(() =>
  JSON.stringify(buildGroupSettingBody(settings.value)) !== settingsBaseline.value,
)

/** 分组折叠状态（默认全部展开；仅影响展示，不影响提交内容） */
const collapsedGroups = ref<Record<string, boolean>>({})

/** 邮箱白名单的待添加草稿 */
const emailDraft = ref('')

/** 读取安全设置（403 时本段降级，不影响其他段） */
async function loadSettings() {
  if (!props.slug) {
    return
  }
  settingsLoading.value = true
  settingsError.value = null
  try {
    const loaded = await fetchOrgSettings(props.slug)
    settings.value = loaded
    settingsBaseline.value = JSON.stringify(buildGroupSettingBody(loaded))
    emailDraft.value = ''
  }
  catch (err) {
    settingsError.value = (err as CnbApiError) ?? new Error(String(err))
  }
  finally {
    settingsLoading.value = false
  }
}

/** 保存安全设置（覆盖写：一次性提交全部字段 + 全部勾选项） */
async function saveSettings() {
  if (!props.canManage || !settingsDirty.value || settingsSaving.value) {
    return
  }
  settingsSaving.value = true
  try {
    await saveOrgSettings(props.slug, settings.value)
    settingsBaseline.value = JSON.stringify(buildGroupSettingBody(settings.value))
    toast.add({ title: t('org.orgSettings.securitySaved'), color: 'success', duration: 3000 })
  }
  catch (err) {
    toast.add({
      title: t('org.orgSettings.securitySaveFailed'),
      description: (err as Error)?.message || '',
      color: 'error',
      duration: 6000,
    })
  }
  finally {
    settingsSaving.value = false
  }
}

/** 某个策略开关是否已勾选 */
function isValueOn(name: string): boolean {
  return settings.value.values.includes(name)
}

/**
 * 切换一个策略开关。
 *
 * 排序策略：**已识别的枚举按 SETTING_VALUES 规范顺序排前，未识别的原样保留在后**。
 * 为什么不直接 push/splice：values 是覆盖写，一旦我们只提交"自己认识的"
 * 枚举，服务端将来新增、本地 i18n 尚未覆盖的枚举会被静默清掉 ——
 * 保留未知项是防止这类"看不见的数据丢失"的唯一手段。
 */
function toggleValue(name: string) {
  const picked = new Set(settings.value.values)
  if (picked.has(name)) {
    picked.delete(name)
  }
  else {
    picked.add(name)
  }
  const known = SETTING_VALUES.filter(value => picked.has(value))
  const unknown = settings.value.values.filter(value => !SETTING_VALUES.includes(value))
  settings.value.values = [...known, ...unknown]
}

/** 策略开关的中文标签：i18n 键优先，未知枚举回退显示原文（服务端新增不白屏） */
function valueLabel(name: string): string {
  const path = `org.orgSettings.values.${name}`
  const translated = t(path)
  // vue-i18n 对缺失键返回键路径本身 —— 以此判断未知枚举
  return translated === path ? name : translated
}

/** 折叠/展开一个分组 */
function toggleGroup(id: string) {
  collapsedGroups.value[id] = !collapsedGroups.value[id]
}

/** 金额上限输入归一：非数字/负数一律按 0（0 = 不限，是合法业务值） */
function toPriceLimit(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0
}

/** 两个金额上限字段的输入回调（避免在模板里写类型断言） */
function onPriceLimitChange(key: 'npcPriceLimit' | 'visitorNpcPriceLimit', value: unknown) {
  settings.value[key] = toPriceLimit(value)
}

/** 添加邮箱白名单项（空/重复项直接忽略，回车亦可触发） */
function addEmail() {
  const candidate = emailDraft.value.trim()
  if (!candidate) {
    return
  }
  if (!settings.value.emailVerification.includes(candidate)) {
    settings.value.emailVerification = [...settings.value.emailVerification, candidate]
  }
  emailDraft.value = ''
}

/** 移除邮箱白名单项 */
function removeEmail(email: string) {
  settings.value.emailVerification = settings.value.emailVerification.filter(item => item !== email)
}

// ---------------------------------------------------------------------------
// C. 危险区（转移组织）
// ---------------------------------------------------------------------------

/** 目标父组织路径 */
const transferTarget = ref('')
/** 确认弹窗开关 */
const transferOpen = ref(false)
/** 转移请求进行中（确认按钮 loading，防重复提交） */
const transferLoading = ref(false)

/** 打开确认弹窗（先做必填校验，避免弹窗打开后才发现没填目标） */
function requestTransfer() {
  if (!transferTarget.value.trim()) {
    toast.add({ title: t('org.orgSettings.transferEmpty'), color: 'warning', duration: 3000 })
    return
  }
  transferOpen.value = true
}

/**
 * 转移后刷新组织列表。
 *
 * 说明：侧边栏 GroupsMenu 自己持有一份 groups 列表（组件内 ref），本组件
 * 无法直接驱动它重载（该文件不在本任务改动范围内）。此处的做法是：
 * 拉一次最新列表，按「目标父组织路径 + 组织名」定位转移后的新条目并写入
 * 共享状态 selectedGroup —— 侧边栏按钮、首页等读取 selectedGroup 的地方会
 * 立即反映新路径，避免用户停留在失效的旧 slug 上。
 * 刷新失败不影响转移结果提示（转移本身已成功）。
 */
async function refreshGroupsAfterTransfer(target: string) {
  try {
    const groups = await fetchCnbGroups()
    // 服务端转移语义：新路径 = 目标父组织路径 + '/' + 组织名
    const expectedPath = `${target}/${orgName.value}`
    const matched = groups.find(group => group.path === expectedPath)
      ?? groups.find(group => group.name === orgName.value)
    if (matched) {
      selectedGroup.value = matched
    }
  }
  catch {
    // 列表刷新失败：静默忽略（用户的转移已成功，重新进入页面即可看到新路径）
  }
}

/** 执行转移（ConfirmDialog 二次确认后触发） */
async function doTransfer() {
  if (transferLoading.value) {
    return
  }
  const target = transferTarget.value.trim()
  if (!target) {
    return
  }
  transferLoading.value = true
  try {
    await transferGroup(props.slug, target)
    transferOpen.value = false
    transferTarget.value = ''
    toast.add({ title: t('org.orgSettings.transferSuccess'), color: 'success', duration: 3000 })
    await refreshGroupsAfterTransfer(target)
  }
  catch (err) {
    // 失败保留弹窗：用户可修改目标后重试，或取消
    toast.add({
      title: t('org.orgSettings.transferFailed'),
      description: (err as Error)?.message || '',
      color: 'error',
      duration: 6000,
    })
  }
  finally {
    transferLoading.value = false
  }
}

// ---------------------------------------------------------------------------
// 生命周期：切换组织（含子组织下钻）→ 全部重置并重拉
// ---------------------------------------------------------------------------

watch(() => props.slug, (slug) => {
  // 基线与表单一起清（applyInfoValues 同时写两处）：
  // 否则切换组织后，旧组织的值会被当成"用户已填"提交到新组织
  applyInfoValues({
    description: '',
    site: '',
    email: '',
    domain: '',
    remark: '',
    wechatMp: '',
    readmeRepoPath: '',
  })
  infoError.value = null
  settings.value = normalizeOrgSettings({})
  settingsBaseline.value = ''
  settingsError.value = null
  emailDraft.value = ''
  transferTarget.value = ''
  transferOpen.value = false
  if (!slug) {
    return
  }
  void loadInfo()
  void loadSettings()
}, { immediate: true })
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- ==================== A. 组织信息 ==================== -->
    <UCard variant="subtle" :ui="{ body: 'flex flex-col gap-4' }">
      <template #header>
        <div class="flex items-center gap-2">
          <UIcon name="i-lucide-info" class="size-4 text-muted" />
          <span class="font-semibold text-highlighted">{{ t('org.orgSettings.infoTitle') }}</span>
        </div>
      </template>

      <!-- 无管理权限：整段只读（红线 2：写入口事前说明，不做事后报错） -->
      <UAlert
        v-if="!canManage"
        icon="i-lucide-shield-alert"
        color="warning"
        variant="soft"
        :title="t('org.orgSettings.noPermission')"
        :description="t('org.orgSettings.noPermissionDesc')"
      />

      <StateAlert
        v-if="infoError"
        state="error"
        :error="infoError"
        :retry="loadInfo"
        :site-url="webUrl"
      />

      <div v-else-if="infoLoading" class="flex flex-col gap-3">
        <USkeleton v-for="i in 3" :key="i" class="h-10 w-full rounded-md" />
      </div>

      <template v-else>
        <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
          <UFormField :label="t('org.orgSettings.description')" class="md:col-span-2">
            <UTextarea
              v-model="info.description"
              :rows="3"
              :disabled="!canManage"
              :placeholder="t('org.orgSettings.descriptionPlaceholder')"
              class="w-full"
            />
          </UFormField>

          <UFormField :label="t('org.orgSettings.site')">
            <UInput
              v-model="info.site"
              :disabled="!canManage"
              :placeholder="t('org.orgSettings.sitePlaceholder')"
              class="w-full"
            />
          </UFormField>

          <UFormField :label="t('org.orgSettings.email')">
            <UInput
              v-model="info.email"
              :disabled="!canManage"
              :placeholder="t('org.orgSettings.emailPlaceholder')"
              class="w-full"
            />
          </UFormField>

          <UFormField :label="t('org.orgSettings.domain')">
            <UInput
              v-model="info.domain"
              :disabled="!canManage"
              :placeholder="t('org.orgSettings.domainPlaceholder')"
              class="w-full"
            />
          </UFormField>

          <UFormField :label="t('org.orgSettings.remark')">
            <UInput
              v-model="info.remark"
              :disabled="!canManage"
              :placeholder="t('org.orgSettings.remarkPlaceholder')"
              class="w-full"
            />
          </UFormField>

          <UFormField :label="t('org.orgSettings.wechatMp')">
            <UInput
              v-model="info.wechatMp"
              :disabled="!canManage"
              :placeholder="t('org.orgSettings.wechatMpPlaceholder')"
              class="w-full"
            />
          </UFormField>

          <UFormField :label="t('org.orgSettings.readmeRepoPath')">
            <UInput
              v-model="info.readmeRepoPath"
              :disabled="!canManage"
              :placeholder="t('org.orgSettings.readmeRepoPathPlaceholder')"
              class="w-full"
            />
          </UFormField>
        </div>

        <!-- 增量提交说明：只有改动过的字段会被提交；清空并保存 = 清除该项 -->
        <p class="text-xs text-dimmed">
          {{ t('org.orgSettings.infoDesc') }}
        </p>

        <div class="flex items-center gap-3">
          <UButton
            icon="i-lucide-save"
            :loading="infoSaving"
            :disabled="!canManage || !infoDirty"
            @click="saveInfo"
          >
            {{ t('common.save') }}
          </UButton>
          <span v-if="canManage && infoDirty" class="text-xs text-muted">
            {{ t('org.orgSettings.unsavedChanges') }}
          </span>
        </div>
      </template>
    </UCard>

    <!-- ==================== B. 安全设置 ==================== -->
    <UCard variant="subtle" :ui="{ body: 'flex flex-col gap-4' }">
      <template #header>
        <div class="flex items-center gap-2">
          <UIcon name="i-lucide-shield-check" class="size-4 text-muted" />
          <span class="font-semibold text-highlighted">{{ t('org.orgSettings.securityTitle') }}</span>
        </div>
      </template>

      <UAlert
        v-if="!canManage"
        icon="i-lucide-shield-alert"
        color="warning"
        variant="soft"
        :title="t('org.orgSettings.noPermission')"
        :description="t('org.orgSettings.noPermissionDesc')"
      />

      <!-- 403（缺 group-manage:r）/ 网络错误：仅本段降级 -->
      <StateAlert
        v-if="settingsError"
        state="error"
        :error="settingsError"
        :retry="loadSettings"
        :site-url="webUrl"
      />

      <div v-else-if="settingsLoading" class="flex flex-col gap-3">
        <USkeleton v-for="i in 5" :key="i" class="h-10 w-full rounded-md" />
      </div>

      <template v-else>
        <!-- ① 基础开关：上级限制位为 false 时 disabled + 说明 -->
        <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
          <USwitch
            v-model="settings.hideMembers"
            :disabled="!canManage || !settings.canShowMembers"
            :label="t('org.orgSettings.hideMembers')"
            :description="settings.canShowMembers
              ? t('org.orgSettings.hideMembersHint')
              : t('org.orgSettings.restrictedByParent')"
          />
          <USwitch
            v-model="settings.hideSubGroups"
            :disabled="!canManage || !settings.canShowSubGroups"
            :label="t('org.orgSettings.hideSubGroups')"
            :description="settings.canShowSubGroups
              ? t('org.orgSettings.hideSubGroupsHint')
              : t('org.orgSettings.restrictedByParent')"
          />
          <USwitch
            v-model="settings.showPrivateRepoWatermark"
            :disabled="!canManage || !settings.canShowWatermark"
            :label="t('org.orgSettings.showPrivateRepoWatermark')"
            :description="settings.canShowWatermark
              ? t('org.orgSettings.showPrivateRepoWatermarkHint')
              : t('org.orgSettings.restrictedByParent')"
          />
          <USwitch
            v-model="settings.groupProtection"
            :disabled="!canManage"
            :label="t('org.orgSettings.groupProtection')"
            :description="t('org.orgSettings.groupProtectionHint')"
          />
        </div>

        <!-- ② NPC 价格上限（毫元/百万 token，0 = 不限） -->
        <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
          <UFormField :label="t('org.orgSettings.npcPriceLimit')" :hint="t('org.orgSettings.priceLimitUnit')">
            <UInput
              :model-value="String(settings.npcPriceLimit)"
              type="number"
              min="0"
              :disabled="!canManage"
              class="w-full"
              @update:model-value="onPriceLimitChange('npcPriceLimit', $event)"
            />
            <template #help>
              <span class="text-xs text-dimmed">{{ t('org.orgSettings.npcPriceLimitHint') }}</span>
            </template>
          </UFormField>
          <UFormField
            :label="t('org.orgSettings.visitorNpcPriceLimit')"
            :hint="t('org.orgSettings.priceLimitUnit')"
          >
            <UInput
              :model-value="String(settings.visitorNpcPriceLimit)"
              type="number"
              min="0"
              :disabled="!canManage"
              class="w-full"
              @update:model-value="onPriceLimitChange('visitorNpcPriceLimit', $event)"
            />
            <template #help>
              <span class="text-xs text-dimmed">{{ t('org.orgSettings.visitorNpcPriceLimitHint') }}</span>
            </template>
          </UFormField>
        </div>

        <!-- ③ 邮箱验证白名单（字符串数组：可增删的标签输入） -->
        <div class="flex flex-col gap-2">
          <div class="flex flex-col gap-0.5">
            <span class="text-sm font-medium text-highlighted">{{ t('org.orgSettings.emailVerification') }}</span>
            <span class="text-xs text-muted">{{ t('org.orgSettings.emailVerificationHint') }}</span>
          </div>
          <div class="flex items-center gap-2">
            <UInput
              v-model="emailDraft"
              :disabled="!canManage"
              :placeholder="t('org.orgSettings.emailVerificationPlaceholder')"
              class="w-full max-w-80"
              @keydown.enter.prevent="addEmail"
            />
            <UButton
              color="neutral"
              variant="soft"
              icon="i-lucide-plus"
              :disabled="!canManage"
              @click="addEmail"
            >
              {{ t('org.orgSettings.emailVerificationAdd') }}
            </UButton>
          </div>
          <div v-if="settings.emailVerification.length > 0" class="flex flex-wrap gap-1.5">
            <span
              v-for="email in settings.emailVerification"
              :key="email"
              class="inline-flex items-center gap-1 rounded-md bg-elevated px-2 py-0.5 text-xs"
            >
              {{ email }}
              <UButton
                size="xs"
                color="neutral"
                variant="link"
                icon="i-lucide-x"
                :disabled="!canManage"
                :aria-label="t('org.orgSettings.emailVerificationRemove')"
                @click="removeEmail(email)"
              />
            </span>
          </div>
          <p v-else class="text-xs text-dimmed">
            {{ t('org.orgSettings.emailVerificationEmpty') }}
          </p>
        </div>

        <!-- ④ 根组织基线（只读：root_* 字段仅供参照，不可在子组织修改） -->
        <div class="flex flex-col gap-1 border-t border-default pt-4">
          <span class="text-sm font-medium text-highlighted">{{ t('org.orgSettings.rootBaselineTitle') }}</span>
          <div class="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-muted">
            <span>
              {{ t('org.orgSettings.groupProtection') }}：
              <span class="text-highlighted">
                {{ settings.rootGroupProtection ? t('org.orgSettings.on') : t('org.orgSettings.off') }}
              </span>
            </span>
            <span>
              {{ t('org.orgSettings.npcPriceLimit') }}：
              <span class="text-highlighted tabular-nums">{{ settings.rootNpcPriceLimit }}</span>
            </span>
          </div>
        </div>

        <!-- ⑤ 33 个 organization.SettingValue 策略开关（8 个分组，2 列网格） -->
        <div class="flex flex-col gap-3 border-t border-default pt-4">
          <div class="flex flex-col gap-0.5">
            <span class="text-sm font-medium text-highlighted">{{ t('org.orgSettings.policyTitle') }}</span>
            <span class="text-xs text-muted">{{ t('org.orgSettings.policyHint') }}</span>
          </div>

          <div v-for="group in SETTING_VALUE_GROUPS" :key="group.id" class="flex flex-col gap-1.5">
            <!-- 分组标题可点击折叠（纯本地展示状态，不影响提交） -->
            <UButton
              color="neutral"
              variant="ghost"
              size="sm"
              class="w-full justify-start"
              @click="toggleGroup(group.id)"
            >
              <span class="inline-flex items-center gap-1.5 text-xs font-semibold text-toned">
                <UIcon
                  :name="collapsedGroups[group.id] ? 'i-lucide-chevron-right' : 'i-lucide-chevron-down'"
                  class="size-3.5"
                />
                {{ t(`org.orgSettings.valueGroups.${group.id}`) }}
                <UBadge
                  color="neutral"
                  variant="subtle"
                  size="sm"
                  :label="String(group.values.filter(item => isValueOn(item)).length)"
                />
              </span>
            </UButton>
            <div
              v-show="!collapsedGroups[group.id]"
              class="grid grid-cols-1 gap-x-4 gap-y-1.5 ps-6 md:grid-cols-2"
            >
              <USwitch
                v-for="name in group.values"
                :key="name"
                size="sm"
                :model-value="isValueOn(name)"
                :label="valueLabel(name)"
                :disabled="!canManage"
                @update:model-value="toggleValue(name)"
              />
            </div>
          </div>
        </div>

        <div class="flex items-center gap-3 border-t border-default pt-4">
          <UButton
            icon="i-lucide-save"
            :loading="settingsSaving"
            :disabled="!canManage || !settingsDirty"
            @click="saveSettings"
          >
            {{ t('common.save') }}
          </UButton>
          <span v-if="canManage && settingsDirty" class="text-xs text-muted">
            {{ t('org.orgSettings.unsavedChanges') }}
          </span>
        </div>
      </template>
    </UCard>

    <!-- ==================== C. 危险区 ==================== -->
    <UCard variant="subtle" :ui="{ body: 'flex flex-col gap-4' }">
      <template #header>
        <div class="flex items-center gap-2">
          <UIcon name="i-lucide-triangle-alert" class="size-4 text-error" />
          <span class="font-semibold text-highlighted">{{ t('org.orgSettings.dangerTitle') }}</span>
        </div>
      </template>

      <p class="text-xs text-muted">
        {{ t('org.orgSettings.dangerDesc') }}
      </p>

      <!-- 转移组织：高危写操作 → ConfirmDialog + typeToConfirm（输入组织名） -->
      <div class="flex flex-col gap-2">
        <span class="text-sm font-medium text-highlighted">{{ t('org.orgSettings.transferTitle') }}</span>
        <p class="text-xs text-muted">
          {{ t('org.orgSettings.transferDesc') }}
        </p>
        <div v-if="canManage" class="flex flex-wrap items-end gap-2">
          <UInput
            v-model="transferTarget"
            :placeholder="t('org.orgSettings.transferPlaceholder')"
            class="w-full max-w-80"
          />
          <UButton
            color="error"
            variant="soft"
            icon="i-lucide-move-right"
            @click="requestTransfer"
          >
            {{ t('org.orgSettings.transferAction') }}
          </UButton>
        </div>
        <p v-else class="text-xs text-warning">
          {{ t('org.orgSettings.noPermission') }}
        </p>
      </div>

      <!-- 更换 Logo / 删除组织：桌面端无法完成，只给说明 + Web 端外跳 -->
      <div class="flex flex-col gap-2 border-t border-default pt-4">
        <span class="text-sm font-medium text-highlighted">{{ t('org.orgSettings.logoTitle') }}</span>
        <p class="text-xs text-muted">
          {{ t('org.orgSettings.logoDesc') }}
        </p>
        <div>
          <UButton
            :to="webUrl"
            target="_blank"
            color="neutral"
            variant="soft"
            icon="i-lucide-external-link"
          >
            {{ t('org.orgSettings.openWeb') }}
          </UButton>
        </div>
      </div>

      <div class="flex flex-col gap-2 border-t border-default pt-4">
        <span class="text-sm font-medium text-error">{{ t('org.orgSettings.deleteTitle') }}</span>
        <p class="text-xs text-muted">
          {{ t('org.orgSettings.deleteDesc') }}
        </p>
        <div>
          <UButton
            :to="webUrl"
            target="_blank"
            color="error"
            variant="soft"
            icon="i-lucide-external-link"
          >
            {{ t('org.orgSettings.openWeb') }}
          </UButton>
        </div>
      </div>
    </UCard>

    <!-- 转移确认：破坏性操作必须二次确认；高风险要求输入组织名 -->
    <ConfirmDialog
      v-model:open="transferOpen"
      :title="t('org.orgSettings.transferConfirmTitle')"
      :desc="t('org.orgSettings.transferConfirmDesc', { path: slug, target: transferTarget.trim() })"
      :confirm-label="t('org.orgSettings.transferAction')"
      confirm-color="error"
      :loading="transferLoading"
      :type-to-confirm="orgName"
      :type-to-confirm-label="t('org.orgSettings.transferTypeLabel', { name: orgName })"
      @confirm="doTransfer"
    />
  </div>
</template>
