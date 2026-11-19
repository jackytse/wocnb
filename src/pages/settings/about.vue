<script setup lang="ts">
/**
 * 设置 · 关于：应用版本（Tauri getVersion）、更新通道、检查更新、
 * 应用内热更新（macOS 一键更新 + 重启）、许可证。
 *
 * 检查更新链路（useAppUpdate）：
 * - 手动：本页「立即检查」按钮 → checkForUpdate()，结果按状态机渲染在
 *   版本行下方（available 时给「一键更新」热更新入口 + 「前往下载」兜底）；
 * - 自动：启动后由 layouts/default.vue 延迟静默检查（24h 节流），发现
 *   新版本在首页弹 toast —— 两处共享 useAppUpdate 的模块级单例 state。
 *
 * 热更新链路（macOS）：发现新版本 → installUpdate()（updater 清单校验 +
 * 下载进度 + 验签安装）→ 用户点「重启完成更新」→ relaunchApp()。
 * Windows 端热更新不可用（清单缺平台条目 / 无安装器产物），UI 自动降级
 * 为「前往下载」手动路径。
 *
 * 更新通道（release / prerelease）也在本页设置：通道决定"哪些 Release
 * 参与比较"，落盘在 useAppUpdate（localStorage），切换后立即重置检查状态，
 * 用户点「立即检查」即可用新通道拿到结果；通道同时约束热更新（清单版本
 * 与通道检测出的版本不一致时拒绝安装，防止 rc 被塞给正式版通道用户）。
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useAppToast } from '../../composables/useAppToast'
import {
  APP_RELEASES_PAGE_URL,
  normalizeUpdateChannel,
  UPDATE_CHANNEL_OPTIONS,
  useAppUpdate,
  type UpdateChannel,
} from '../../composables/useAppUpdate'

const { t } = useI18n()

// toast：热更新完成/通道不匹配时给一次性反馈（行内状态展示持续态）
const toast = useAppToast()

// 更新检测单例 state（与启动 toast 链路共享同一份数据）
const {
  status,
  latestRelease,
  lastError,
  checkedAt,
  updateChannel,
  setUpdateChannel,
  checkForUpdate,
} = useAppUpdate()

/** 应用版本号（Tauri API，非 Tauri 环境显示 '-'） */
const version = ref('-')
onMounted(async () => {
  if ('__TAURI_INTERNALS__' in window) {
    try {
      const { getVersion } = await import('@tauri-apps/api/app')
      version.value = await getVersion()
    }
    catch {
      version.value = '-'
    }
  }
})

/** 最新 Release 的 tag（供"发现新版本 vX"展示；无 Release 时显示 '-'） */
const latestTag = computed(() => latestRelease.value?.tagName || '-')

/**
 * 更新通道下拉选项。
 *
 * 顺序与值都来自 UPDATE_CHANNEL_OPTIONS（单一事实源）：预发布在前，与
 * DEFAULT_UPDATE_CHANNEL 保持一致，避免下拉顺序暗示"默认项"却在别处不同。
 * label/description 走 i18n，切换语言即时生效。
 */
const channelItems = computed<{ label: string, value: UpdateChannel, description: string }[]>(() =>
  UPDATE_CHANNEL_OPTIONS.map(channel => ({
    label: t(`settings.about.channel_${channel}`),
    value: channel,
    description: t(`settings.about.channelDesc_${channel}`),
  })),
)

/**
 * 通道双向绑定。
 *
 * setter 统一走 normalizeUpdateChannel：USelect 在不同 items 形态下可能
 * 回传字符串或对象，脏值一律回落默认通道（不能把非法值写进落盘的 key，
 * 否则下次启动读到非法通道会静默变成"什么都不提示"）。
 */
const channelModel = computed<UpdateChannel>({
  get: () => updateChannel.value,
  set: (value: unknown) => {
    setUpdateChannel(normalizeUpdateChannel(
      typeof value === 'object' && value !== null && 'value' in value
        ? (value as { value: unknown }).value
        : value,
    ))
  },
})

/** 当前通道下的最新版本是否落后（available 状态） —— 供状态区展示 */
const updateAvailable = computed(() => status.value === 'available')

/**
 * 「上次检查」文案：从未检查 → 提示语；有记录 → 本地化时间。
 *
 * 为什么自己格式化而不是用 relative time：检查结果的时效性判断（"刚才查的
 * 还是昨天查的"）需要精确到分钟，本地化绝对时间最不容易误读。
 */
const lastCheckedText = computed(() => {
  if (!checkedAt.value) {
    return t('settings.about.neverChecked')
  }
  try {
    return t('settings.about.lastChecked', {
      time: new Date(checkedAt.value).toLocaleString(t('settings.about.localeTag')),
    })
  }
  catch {
    // 某些精简运行时缺 Intl：退回 RFC 字符串，信息不丢
    return t('settings.about.lastChecked', { time: new Date(checkedAt.value).toISOString() })
  }
})

/** 在系统浏览器打开链接（非 Tauri 环境兜底 window.open） */
function openExternal(url: string) {
  if ('__TAURI_INTERNALS__' in window) {
    void openUrl(url)
  }
  else {
    window.open(url, '_blank')
  }
}

/**
 * 手动检查更新：checkForUpdate 不抛异常，结果由状态机渲染（含错误）。
 * 检查中按钮自带 loading 且 disabled（同通道防抖；切通道后可立即重查）。
 */
function onManualCheck() {
  void checkForUpdate()
}

// —— 热更新（macOS）：安装状态 + 动作 ——

const {
  installStatus,
  installProgress,
  installError,
  installUpdate,
  relaunchApp,
} = useAppUpdate()

/** 上次安装是否因「清单版本与通道不一致」被拒（决定展示引导文案） */
const installMismatch = ref(false)

/**
 * 一键更新：调用 installUpdate（内部含通道校验 / 进度回填 / 失败兜底）。
 * 结果码细粒度回填 UI 状态，toast 只在两个"需要用户知道"的结果上弹：
 * ready → 提示去重启；mismatch → 提示走手动下载（文案同时渲染在行内）。
 */
async function onInstallUpdate() {
  installMismatch.value = false
  const outcome = await installUpdate()
  if (outcome === 'ready') {
    toast.add({ title: t('settings.about.installDoneToast'), color: 'success', duration: 3000 })
  }
  else if (outcome === 'mismatch') {
    installMismatch.value = true
    toast.add({ title: t('settings.about.installMismatchToast'), color: 'warning', duration: 4000 })
  }
  // no-update / failed / unsupported：行内状态已足够表达，不额外弹 toast
}
</script>

<template>
  <UPageCard
    :title="t('settings.about.title')"
    variant="naked"
  />

  <!-- 版本 + 更新通道 + 检查更新 + 许可证 -->
  <UPageCard variant="subtle">
    <div class="flex items-center justify-between py-1">
      <span class="text-sm text-muted">{{ t('settings.about.version') }}</span>
      <span class="font-mono text-sm text-highlighted">{{ version }}</span>
    </div>
    <USeparator />

    <!-- 更新通道：release（仅正式版，默认）/ prerelease（含预发布） -->
    <div class="flex items-center gap-4 py-1 flex-wrap">
      <div class="min-w-0 flex-1">
        <p class="text-sm text-muted">
          {{ t('settings.about.updateChannel') }}
        </p>
        <p class="text-xs text-dimmed mt-0.5">
          {{ t(`settings.about.channelDesc_${updateChannel}`) }}
        </p>
      </div>
      <USelect
        v-model="channelModel"
        :items="channelItems"
        class="w-44"
      />
    </div>
    <USeparator />

    <!-- 手动检查更新：按钮为主操作，左侧显示上次检查时间 -->
    <div class="py-1">
      <div class="flex items-center justify-between gap-3 flex-wrap">
        <div class="min-w-0">
          <p class="text-sm text-muted">
            {{ t('settings.about.checkUpdate') }}
          </p>
          <p class="text-xs text-dimmed mt-0.5">
            {{ lastCheckedText }}
          </p>
        </div>
        <UButton
          size="sm"
          color="primary"
          variant="soft"
          icon="i-lucide-refresh-cw"
          :loading="status === 'checking'"
          :label="t('settings.about.checkNow')"
          :disabled="status === 'checking'"
          @click="onManualCheck"
        />
      </div>
      <!-- 状态提示：四态各有独立文案（发现新版本最高优先级展示） -->
      <div v-if="updateAvailable" class="mt-2 flex flex-col gap-2">
        <p class="text-sm text-primary">
          {{ t('settings.about.newVersionFound', { version: latestTag }) }}
        </p>
        <!-- 热更新区（macOS）：一键下载安装 → 重启生效。
             Windows 端 installUpdate 会因清单缺平台条目走 failed，
             与其他失败一样展示原文 + 保留手动下载按钮兜底 -->
        <div class="flex items-center gap-3 flex-wrap">
          <!-- ready：安装完成，唯一动作是重启生效 -->
          <UButton
            v-if="installStatus === 'ready'"
            size="sm"
            color="primary"
            icon="i-lucide-rotate-ccw"
            :label="t('settings.about.restartToUpdate')"
            @click="relaunchApp"
          />
          <!-- 下载/安装中：禁用 + 进度文案 -->
          <UButton
            v-else-if="installStatus === 'downloading' || installStatus === 'installing'"
            size="sm"
            color="primary"
            variant="soft"
            icon="i-lucide-cloud-download"
            :label="installStatus === 'downloading'
              ? t('settings.about.downloading', { percent: installProgress })
              : t('settings.about.installing')"
            :disabled="true"
          />
          <!-- 初始：主操作「一键更新」 -->
          <UButton
            v-else
            size="sm"
            color="primary"
            icon="i-lucide-cloud-download"
            :label="t('settings.about.installNow')"
            @click="onInstallUpdate"
          />
          <!-- 手动下载兜底：热更新不可用（Windows / 失败 / 通道不匹配）时是唯一路径 -->
          <UButton
            size="xs"
            color="neutral"
            variant="soft"
            icon="i-lucide-download"
            trailing-icon="i-lucide-arrow-up-right"
            :label="t('settings.about.goDownload')"
            @click="openExternal(APP_RELEASES_PAGE_URL)"
          />
        </div>
        <!-- 失败原文（验签失败 / 网络异常 / Windows 缺平台条目都可读） -->
        <p v-if="installStatus === 'failed' && installError" class="text-xs text-error break-all">
          {{ t('settings.about.installFailed') }}{{ installError ? `: ${installError}` : '' }}
        </p>
        <!-- 通道不匹配：清单版本与所选通道不一致，明确告知走手动下载 -->
        <p v-if="installMismatch" class="text-xs text-warning">
          {{ t('settings.about.installMismatch') }}
        </p>
      </div>
      <p v-else-if="status === 'upToDate'" class="mt-2 text-xs text-dimmed flex items-center gap-1">
        <!-- 已是最新：前置对勾图标（与菜单入口检查更新的 toast 图标一致） -->
        <UIcon name="i-lucide-check" class="size-3.5 shrink-0" />
        {{ t('settings.about.upToDate') }}
      </p>
      <p v-else-if="status === 'checking'" class="mt-2 text-xs text-dimmed">
        {{ t('settings.about.checking') }}
      </p>
      <!-- 错误态：带服务端原文（403 缺 scope 时用户能直接看到缺哪个权限） -->
      <p v-else-if="status === 'error'" class="mt-2 text-xs text-error break-all">
        {{ t('settings.about.checkFailed') }}{{ lastError ? `: ${lastError}` : '' }}
      </p>
      <p v-else class="mt-2 text-xs text-dimmed">
        {{ t('settings.about.autoCheckHint') }}
      </p>
    </div>
    <USeparator />
    <div class="flex items-center justify-between py-1">
      <span class="text-sm text-muted">{{ t('settings.about.license') }}</span>
      <span class="text-sm text-highlighted">{{ t('settings.about.licenseValue') }}</span>
    </div>
  </UPageCard>
</template>
