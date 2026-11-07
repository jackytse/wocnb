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
import { computed, onMounted } from 'vue'
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

defineProps<{
  collapsed?: boolean
}>()

const router = useRouter()
const colorMode = useColorMode()
const toast = useToast()
// 组件内翻译函数：t 在 computed 中调用，语言切换时依赖响应式 locale 自动重算
const { t } = useI18n()

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

/** 退出登录：清空本地令牌与用户信息，回登录页并给出操作反馈（文案随语言切换） */
async function handleLogout() {
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
}], [{
  label: t('menu.theme'),
  icon: 'i-lucide-palette',
  children: [{
    label: t('menu.light'),
    icon: 'i-lucide-sun',
    type: 'checkbox',
    checked: colorMode.value === 'light',
    onSelect(e: Event) {
      e.preventDefault()

      colorMode.value = 'light'
    }
  }, {
    label: t('menu.dark'),
    icon: 'i-lucide-moon',
    type: 'checkbox',
    checked: colorMode.value === 'dark',
    onUpdateChecked(checked: boolean) {
      if (checked) {
        colorMode.value = 'dark'
      }
    },
    onSelect(e: Event) {
      e.preventDefault()
    }
  }]
}], [{
  // 语言切换：system / English / 简体中文 / 繁體中文，写入偏好后全局热切换
  label: t('menu.language'),
  icon: 'i-lucide-languages',
  children: languageItems.value,
}], [{
  // 退出登录：清空本地凭证后跳转登录页
  label: t('menu.logout'),
  icon: 'i-lucide-log-out',
  onSelect: () => {
    void handleLogout()
  }
}]]))
</script>

<template>
  <UDropdownMenu
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
</template>
