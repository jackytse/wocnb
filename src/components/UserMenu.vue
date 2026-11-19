<script setup lang="ts">
/**
 * 侧边栏左下角的用户菜单组件。
 *
 * 数据来源：useCnbAuth 中的 cnbUser（PAT 登录成功后由 GET /user 返回并持久化）。
 * 显示规则：
 * - 头像：优先使用 CNB 返回的 avatar URL，为空时降级为用户名首字母
 * - 名称：昵称（nickname），折叠时只显示头像
 * 菜单能力：查看主页（cnb.cool 个人页）、退出登录（清空本地凭证并回登录页）。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import type { DropdownMenuItem } from '@nuxt/ui'
import { useColorMode } from '@vueuse/core'
import { openUrl } from '@tauri-apps/plugin-opener'
import { cnbUser, logout } from '../composables/useCnbAuth'
// OAuth 登录方式下的退出需要同步清理 CLI 侧令牌与登录方式标记（缺陷 D1：
// 残留 oauth 标记会让重启时的临期刷新分支把 CLI 旧 OAuth 令牌静默覆盖
// 用户重登的 PAT —— 两处退出逻辑必须与 settings/token.vue 完全对齐）
import { cnbAuthMethod, cnbTokenExpiresAt, logoutCliSide } from '../composables/useCnbCliAuth'
import { localePref, type LocalePref } from '../composables/useAppLocale'
// 图片内存缓存：用户头像转 data URL 后绘制，菜单重新挂载不再闪动
import { cachedImageSrc, ensureCnbImage } from '../composables/useCnbImages'
// 检查更新：菜单里提供全局可达的手动入口（与「设置 · 关于」共享同一单例）。
// 弹窗内一键更新 → 进度展示 → 完成自动重启，全部复用 useAppUpdate 的
// 安装状态机（installStatus / installProgress / relaunchApp）。
import { useAppUpdate, APP_RELEASES_PAGE_URL } from '../composables/useAppUpdate'
import { useAppToast } from '../composables/useAppToast'

defineProps<{
  collapsed?: boolean
}>()

const router = useRouter()
const colorMode = useColorMode()
const toast = useAppToast()

/**
 * 手动检查更新的进行中标记：
 * - true 时菜单条目图标切换为旋转态（Nuxt UI item.loading）并禁用重复点击；
 * - 检测结束（无论成败）归 false。
 */
const updateChecking = ref(false)

/**
 * 下拉菜单受控开关（v-model:open）。
 * 为什么需要受控：点击"检测更新"后要用 onSelect 的 preventDefault 阻止
 * reka-ui 自动收起菜单 —— 否则接口还没返回菜单就关了，旋转 loading 完全
 * 看不见，用户不知道有没有在检测。preventDefault 后没有任何默认行为能替
 * 我们关菜单，只能在 handleCheckUpdate 拿到结果后手动置 false 收起。
 * （注意：preventDefault 只加在检测更新这一项上；主题/语言的 checkbox
 * 条目不能加 —— 它会阻止勾选状态翻转，见语言子菜单处的注释。）
 */
const menuOpen = ref(false)

/**
 * 退出登录确认弹窗开关。
 * 为什么需要二次确认：退出会清空本机访问令牌与账号信息，误触代价是
 * "全部重新登录"；菜单条目紧挨常用操作且动作不可撤销，加一道确认弹窗。
 */
const logoutConfirmOpen = ref(false)

// 组件内翻译函数：t 在 computed 中调用，语言切换时依赖响应式 locale 自动重算
const { t } = useI18n()
// 检查更新动作（单例状态与关于页共享：检查结果、安装进度都落同一份 state，
// 这里更新到一半去关于页，关于页也能看到同一份进度）
const {
  checkForUpdate,
  installUpdate,
  installStatus,
  installProgress,
  installError,
  relaunchApp,
} = useAppUpdate()

/** 显示名：昵称优先，兜底用户名；极端情况（无用户数据）显示「未登录」（随语言切换） */
const displayName = computed(() => {
  const u = cnbUser.value
  return u?.nickname || u?.username || t('menu.notLoggedIn')
})

/** 用户名首字母：头像缺失时的占位渲染 */
const initial = computed(() => displayName.value.charAt(0).toUpperCase())

/** CNB 个人主页链接：固定走 /u/{username} 路由（CNB 个人空间统一入口） */
const profileUrl = computed(() =>
  cnbUser.value?.username ? `https://cnb.cool/u/${cnbUser.value.username}` : 'https://cnb.cool',
)

// 预热用户头像到内存缓存：登录态变化（登录成功/资料更新）即触发，
// 就绪后菜单触发按钮与菜单头部的 <img> 都改用 data URL 同步绘制，
// 消除"打开菜单时头像闪动"（原因与机制详见 useCnbImages.ts 头注释）
onMounted(() => {
  void ensureCnbImage(cnbUser.value?.avatar || '')
})

/**
 * 在系统浏览器中打开外部链接（菜单条目 onSelect 专用）。
 * 说明：不使用 <a> 链接（to + target=_blank），因为 main.ts 的全局外链
 * 拦截器在捕获阶段 stopPropagation，点击事件传不到下拉菜单组件导致菜单
 * 无法关闭；改用 onSelect 由 reka-ui 自动收起菜单。非 Tauri 环境兜底
 * window.open（浏览器直接 pnpm dev 调试时）。
 */
async function openExternal(url: string) {
  if ('__TAURI_INTERNALS__' in window) {
    await openUrl(url)
  }
  else {
    window.open(url, '_blank')
  }
}

/**
 * 手动检查更新（菜单入口）。
 *
 * 为什么放在用户菜单里：关于页的按钮要三级点击才够得着（设置 → 关于），
 * 而"我想看看有没有新版"是典型的随手动作，菜单里一项直达更符合预期。
 * 与关于页/启动检查共享 useAppUpdate 的单例状态：这里查到的结果，随后
 * 打开关于页能看到同一份状态（status / latestRelease 已回填）。
 *
 * 结果呈现（弹窗 + toast 分工）：
 * - 发现新版本 → 弹出更新提示窗（UModal）：窗内「立即更新」→ 下载进度条
 *   → 安装完成自动重启（见下方 updateModal / startInstall 注释）；
 * - 已是最新 / 检查失败 → 中性 / 错误 toast（3~6s 自动消失，不值得弹窗）。
 */
async function handleCheckUpdate() {
  // 进入旋转态：菜单条目图标切换为旋转 loading，并禁用重复点击
  updateChecking.value = true
  try {
    const result = await checkForUpdate()
    if (result.error) {
      toast.add({
        title: t('settings.about.checkFailed'),
        description: result.error,
        color: 'error',
        duration: 6000,
      })
      return
    }
    if (result.available) {
      // 有新版本：记录版本号供弹窗展示（当前版本 / 新版本），打开提示窗
      modalVersion.value = result.latestVersion
      modalCurrentVersion.value = result.currentVersion
      updateModalOpen.value = true
      return
    }
    toast.add({
      title: t('settings.about.upToDate'),
      color: 'neutral',
      duration: 3000,
    })
  }
  finally {
    // 无论成败：停止旋转并收起菜单。preventDefault 保住了菜单（接口
    // 检测期间保持展开、旋转可见），只能在这里手动关闭；try/finally
    // 保证请求异常时菜单也不会卡死在展开态
    updateChecking.value = false
    menuOpen.value = false
  }
}

// ---------------------------------------------------------------------------
// 更新提示窗（UModal）：检查出新版本后的弹窗交互
// ---------------------------------------------------------------------------

/** 更新提示窗开关（检查发现新版本时自动打开；用户可稍后关闭） */
const updateModalOpen = ref(false)
/** 弹窗展示的新版本号（检查结果回填，去掉 tag 前导 v） */
const modalVersion = ref('')
/** 弹窗展示的当前版本号 */
const modalCurrentVersion = ref('')
/**
 * 是否由本弹窗触发的安装（用于「安装完成自动重启」的 watch）。
 *
 * ⚠️ 为什么需要这个标记：installStatus 是与「设置 · 关于」共享的模块级
 * 单例。关于页的既有语义是"安装完成后由用户点「重启完成更新」"；如果
 * 这里的 watch 无条件监听 ready 就 relaunch，用户在关于页更新到 ready
 * 的瞬间会被本组件强行重启。标记只在弹窗内点「立即更新」时置 true，
 * 安装收尾即复位，保证自动重启只作用于本弹窗的流程。
 */
const autoRelaunch = ref(false)
/**
 * 弹窗内安装的兜底提示（mismatch / no-update / failed 等无法继续安装时
 * 显示的原因文案；空串 = 正常展示进度）。failed 的原始错误单独存
 * installError（useAppUpdate 单例），与文案一起展示。
 */
const modalInstallNotice = ref('')

/**
 * 弹窗内「立即更新」：下载并安装更新，完成自动重启。
 *
 * 流程与降级：
 * - installUpdate() 内部完成 updater check → 通道校验 → 下载（进度实时
 *   回填 installProgress）→ 安装（installing）→ ready；
 * - ready → watch(installStatus) 自动 relaunchApp（见下方 watch 注释）；
 * - failed / mismatch / no-update / unsupported → modalInstallNotice 落
 *   对应文案，弹窗降级为「前往下载」引导（Windows 只出 portable exe，
 *   清单缺平台条目，天然走这条降级路径）。
 */
async function startInstallFromModal() {
  modalInstallNotice.value = ''
  autoRelaunch.value = true
  const outcome = await installUpdate()
  // 任一非 ready 结局都取消自动重启，并给出可理解的原因文案
  if (outcome !== 'ready') {
    autoRelaunch.value = false
    modalInstallNotice.value = outcome === 'mismatch'
      ? t('settings.about.installMismatchToast')
      : outcome === 'no-update'
        ? t('settings.about.upToDate')
        : t('settings.about.installFailed')
  }
}

/**
 * 安装完成（ready）→ 自动重启。
 * 仅当本次安装由本弹窗触发（autoRelaunch）才执行，防止与关于页共享的
 * 安装状态在这里产生误触发的重启（见 autoRelaunch 注释）。
 */
watch(installStatus, (s) => {
  if (s === 'ready' && autoRelaunch.value) {
    autoRelaunch.value = false
    void relaunchApp()
  }
})

/** 弹窗「前往下载」：系统浏览器打开 Releases 页（Windows 降级路径出口） */
function goDownloadPage() {
  void openExternal(APP_RELEASES_PAGE_URL)
}

/** 退出登录：清空本地令牌与用户信息，回登录页并给出操作反馈（文案随语言切换） */
async function confirmLogout() {
  // OAuth 登录方式：同步清理 CLI 侧令牌（cnb logout --host），保证应用与
  // CLI 两端一致；失败不阻塞本地登出（与 settings/token.vue 同策略）
  if (cnbAuthMethod.value === 'oauth') {
    await logoutCliSide().catch(() => {})
  }
  logout()
  // 清理登录方式与过期时间标记：防止残留 oauth 标记误触发重启续期分支
  cnbAuthMethod.value = ''
  cnbTokenExpiresAt.value = 0
  toast.add({
    title: t('menu.loggedOut'),
    description: t('menu.loggedOutDesc'),
    color: 'neutral',
    duration: 3000,
  })
  await router.replace('/login')
}

/**
 * 语言切换子菜单的选项定义。
 *
 * 文案规则：语言名称始终以「母语自称」展示（English / 简体中文 / 繁體中文），
 * 不随当前语言翻译 —— 便于用户在任意语言下都能认出目标语言；
 * 仅「系统语言」这一项使用当前语言翻译。
 * 选中状态绑定 localePref（含 system），选择后由 main.ts 的 watch 热切换。
 */
const languageOptions: { value: LocalePref; label: string }[] = [
  { value: 'system', label: t('menu.systemLanguage') },
  { value: 'en', label: 'English' },
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
]

/**
 * 构造语言子菜单条目：checkbox 样式 + onSelect 写入偏好。
 * 注意：onSelect 不调用 preventDefault —— reka-ui 中 preventDefault 会阻止
 * 菜单收起；选中语言后希望整个菜单自动关闭，故让默认关闭行为生效。
 * （checked 受 localePref 控制，关闭时内部状态翻转不影响下次打开的显示）
 */
const languageItems = computed<DropdownMenuItem[]>(() =>
  languageOptions.map(opt => ({
    label: opt.value === 'system' ? t('menu.systemLanguage') : opt.label,
    type: 'checkbox' as const,
    checked: localePref.value === opt.value,
    onSelect() {
      localePref.value = opt.value
    },
  })),
)

const items = computed<DropdownMenuItem[][]>(() => ([[{
  // 菜单头部标签：头像 + 显示名（与按钮展示一致；src 优先取内存缓存 data URL 防闪动）
  type: 'label',
  label: displayName.value,
  ...(cnbUser.value?.avatar
    ? { avatar: { src: cachedImageSrc(cnbUser.value.avatar), alt: displayName.value } }
    : {}),
}], [{
  label: t('menu.myProfile'),
  icon: 'i-lucide-user',
  // 该条目是外链（系统浏览器打开 cnb.cool 个人主页），必须带外链标识。
  //
  // target 仅为「外链标识」而存在：Nuxt UI 的 DropdownMenu 判断
  // `item.target === '_blank'` 时会在标签后自动渲染 ↗ 图标，让用户明确
  // 知道这一项会跳出应用。点击行为仍由 onSelect 负责（条目无 to/href，
  // 不会真按 target 跳转）—— 之所以不用 to+target 交给框架跳转，是因为
  // main.ts 的全局外链拦截器在捕获阶段 stopPropagation，会让下拉菜单
  // 收不起来（见 openExternal 注释）。
  target: '_blank',
  onSelect: () => {
    void openExternal(profileUrl.value)
  }
}, {
  // 个人资料页：应用内查看/修改 CNB 个人信息（GET/POST /user）
  label: t('menu.profile'),
  icon: 'i-lucide-user-pen',
  to: '/profile'
}, {
  label: t('menu.settings'),
  icon: 'i-lucide-settings',
  to: '/settings'
}, {
  // 手动检查更新：随手可用的入口（详细状态与更新通道在「设置 · 关于」）。
  // 交互：点击后菜单保持展开、条目转 loading（接口检测期间可见），
  // 拿到结果才收起菜单 —— preventDefault 阻止 reka-ui 在 select 后
  // 自动收起（无 preventDefault 时菜单瞬间关闭，旋转态完全不可见）。
  // 检查结果 —— 有新版本弹更新提示窗（窗内一键更新 → 进度 → 自动重启），
  // 已最新/失败走 toast；菜单收起统一在 handleCheckUpdate 的 finally。
  label: t('settings.about.checkUpdate'),
  icon: 'i-lucide-refresh-cw',
  loading: updateChecking.value,
  disabled: updateChecking.value,
  onSelect: (e) => {
    // preventDefault：阻止 reka-ui 在 select 后自动收起菜单。
    // 本条目不是 checkbox，preventDefault 不会带来勾选副作用；
    // 主题/语言的 checkbox 条目严禁这么做（会阻止勾选翻转）
    e.preventDefault()
    void handleCheckUpdate()
  }
}], [{
  label: t('menu.theme'),
  icon: 'i-lucide-palette',
  children: [{
    // 跟随系统 = useColorMode 的 'auto'（VueUse 存储的合法值只有
    // auto/light/dark；'system' 写进去是非法值，不会命中任何模式）。
    // index.html 内联脚本首屏判定读的也是 'auto'，两处口径一致。
    // ⚠️ 勾选状态必须读 store（用户存储的偏好）而不是 colorMode.value：
    //    .value 是「解析后的实际模式」，跟随系统时会被解析成 light/dark，
    //    导致选中「跟随系统」后勾选框落在 light 上（解析值永远 ≠ 'auto'）。
    // ⚠️ onSelect 不调用 preventDefault —— reka-ui 里 preventDefault 会
    //    阻止 checkbox 内部选中状态翻转，表现为"点了没反应/不可选中"
    //    （与下方语言子菜单同一范式：checked 受 store 受控，
    //    让 reka 的默认勾选与菜单收起行为生效）
    label: t('menu.system'),
    icon: 'i-lucide-monitor',
    type: 'checkbox' as const,
    checked: colorMode.store.value === 'auto',
    onSelect() {
      colorMode.store.value = 'auto'
    }
  }, {
    label: t('menu.light'),
    icon: 'i-lucide-sun',
    type: 'checkbox' as const,
    checked: colorMode.store.value === 'light',
    onSelect() {
      colorMode.store.value = 'light'
    }
  }, {
    label: t('menu.dark'),
    icon: 'i-lucide-moon',
    type: 'checkbox' as const,
    checked: colorMode.store.value === 'dark',
    onSelect() {
      colorMode.store.value = 'dark'
    }
  }]
}], [{
  // 语言切换：system / English / 简体中文 / 繁體中文，写入偏好后全局热切换
  label: t('menu.language'),
  icon: 'i-lucide-languages',
  children: languageItems.value,
}], [{
  // 退出登录：先弹二次确认窗（清空凭证不可撤销，防误触），确认才执行
  label: t('menu.logout'),
  icon: 'i-lucide-log-out',
  onSelect: () => {
    logoutConfirmOpen.value = true
  }
}]]))
</script>

<template>
  <UDropdownMenu
    v-model:open="menuOpen"
    :items="items"
    :content="{ align: 'center', collisionPadding: 12 }"
    :ui="{ content: collapsed ? 'w-48' : 'w-(--reka-dropdown-menu-trigger-width)' }"
  >
    <UButton
      color="neutral"
      variant="ghost"
      block
      :square="collapsed"
      class="data-[state=open]:bg-elevated"
      :ui="{
        trailingIcon: 'text-dimmed'
      }"
      v-bind="{
        // 有真实头像用头像（优先内存缓存 data URL，防菜单打开时闪动），
        // 否则用首字母占位（保持侧边栏视觉稳定）
        ...(cnbUser?.avatar
          ? { avatar: { src: cachedImageSrc(cnbUser.avatar), alt: displayName } }
          : { avatar: { text: initial } }),
        label: collapsed ? undefined : displayName,
        trailingIcon: collapsed ? undefined : 'i-lucide-chevrons-up-down'
      }"
    />

    <template #chip-leading="{ item }">
      <div class="inline-flex items-center justify-center shrink-0 size-5">
        <span
          class="rounded-full ring ring-bg bg-(--chip-light) dark:bg-(--chip-dark) size-2"
          :style="{
            '--chip-light': `var(--color-${(item as any).chip}-500)`,
            '--chip-dark': `var(--color-${(item as any).chip}-400)`
          }"
        />
      </div>
    </template>
  </UDropdownMenu>

  <!--
    更新提示窗：手动检查发现新版本后弹出。
    三个阶段：
    - idle：展示版本信息 + 「立即更新」/「稍后」；
    - downloading/installing：进度条实时走 installProgress（0~100），
      此阶段禁用遮罩关闭（dismissible=false）防止误触中断下载；
    - ready：提示自动重启（watch 里 relaunchApp，进程随即退出）。
    降级：mismatch / no-update / failed（Windows 缺热更条目等）→ 展示
    原因 + 「前往下载」按钮（系统浏览器打开 Releases 页）。
  -->
  <UModal
    v-model:open="updateModalOpen"
    :dismissible="installStatus !== 'downloading' && installStatus !== 'installing'"
    :ui="{ content: 'max-w-sm' }"
  >
    <template #content>
      <div class="p-6">
        <!-- 标题行：发现新版本 + 关闭按钮（下载/安装中隐藏，防误触中断） -->
        <div class="flex items-start justify-between gap-3">
          <h2 class="text-base font-semibold text-highlighted leading-6">
            {{ t('settings.about.newVersionFound', { version: modalVersion }) }}
          </h2>
          <UButton
            v-if="installStatus !== 'downloading' && installStatus !== 'installing'"
            color="neutral"
            variant="ghost"
            icon="i-lucide-x"
            size="xs"
            :aria-label="t('common.cancel')"
            @click="updateModalOpen = false"
          />
        </div>

        <!-- 版本说明：当前 → 新版本 -->
        <p class="mt-2 text-sm text-muted">
          {{ t('settings.about.modalDesc', { current: modalCurrentVersion || '—', version: modalVersion }) }}
        </p>

        <!-- 阶段一：下载/安装中（进度条） -->
        <div v-if="installStatus === 'downloading' || installStatus === 'installing'" class="mt-5">
          <div class="flex items-center justify-between text-sm text-muted mb-2">
            <span>{{ installStatus === 'downloading'
              ? t('settings.about.downloading', { percent: installProgress })
              : t('settings.about.installing') }}</span>
            <span v-if="installStatus === 'downloading'" class="tabular-nums">{{ installProgress }}%</span>
          </div>
          <UProgress :model-value="installStatus === 'installing' ? 100 : installProgress" size="sm" />
        </div>

        <!-- 阶段二：安装完成 → 自动重启提示（relaunch 在 watch 里触发） -->
        <div v-else-if="installStatus === 'ready'" class="mt-5 flex items-center gap-2 text-sm text-primary">
          <UIcon name="i-lucide-check-circle-2" class="size-4 shrink-0" />
          <span>{{ t('settings.about.installDoneRestart') }}</span>
        </div>

        <!-- 降级：无法应用内更新（Windows 缺条目 / 通道不一致 / 失败）→ 引导手动下载 -->
        <div v-else-if="modalInstallNotice" class="mt-5">
          <p class="text-sm text-error">
            {{ modalInstallNotice }}
          </p>
          <p v-if="installError" class="mt-1 text-xs text-muted break-all">
            {{ installError }}
          </p>
          <UButton
            class="mt-3"
            size="sm"
            color="neutral"
            variant="outline"
            icon="i-lucide-external-link"
            :label="t('settings.about.goDownload')"
            @click="goDownloadPage"
          />
        </div>

        <!-- 操作区：仅在初始态显示（进行中/完成/降级态各有自己的出口） -->
        <div v-if="installStatus === 'idle' && !modalInstallNotice" class="mt-6 flex justify-end gap-2">
          <UButton
            size="sm"
            color="neutral"
            variant="ghost"
            :label="t('common.cancel')"
            @click="updateModalOpen = false"
          />
          <UButton
            size="sm"
            color="primary"
            icon="i-lucide-download"
            :label="t('settings.about.installNow')"
            @click="startInstallFromModal"
          />
        </div>
      </div>
    </template>
  </UModal>

  <!--
    退出登录二次确认弹窗：
    退出动作会清空本机令牌与账号信息且不可撤销，菜单条目一次点击就执行
    代价太高 —— 用 UModal 拦一道：「取消」仅关闭弹窗，「退出登录」先关
    弹窗再执行 confirmLogout（原 handleLogout 逻辑原样保留）。
  -->
  <UModal v-model:open="logoutConfirmOpen" :ui="{ content: 'max-w-sm' }">
    <template #content>
      <div class="p-6">
        <h2 class="text-base font-semibold text-highlighted leading-6">
          {{ t('menu.logoutConfirmTitle') }}
        </h2>
        <p class="mt-2 text-sm text-muted">
          {{ t('menu.logoutConfirmDesc') }}
        </p>
        <div class="mt-6 flex justify-end gap-2">
          <UButton
            size="sm"
            color="neutral"
            variant="ghost"
            :label="t('common.cancel')"
            @click="logoutConfirmOpen = false"
          />
          <UButton
            size="sm"
            color="error"
            icon="i-lucide-log-out"
            :label="t('menu.logout')"
            @click="logoutConfirmOpen = false; void confirmLogout()"
          />
        </div>
      </div>
    </template>
  </UModal>
</template>
