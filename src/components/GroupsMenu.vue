<script setup lang="ts">
/**
 * 侧边栏顶部的组织（Group）菜单。
 *
 * 数据来源：CNB Open API `GET /user/groups`（用户所在顶层组织列表），
 * 登录后自动加载；未加载完成时显示占位。
 * 交互设计：
 * - 点击组织项：切换当前选中组织（后续组织维度的页面将以它为上下文）
 * - Create group：跳转 CNB 创建组织页（系统浏览器打开）
 * - Manage groups：跳转 CNB 组织管理页（系统浏览器打开）
 * 头像：按 CNB 官方前端使用的组织图标 URL 规则展示
 * （https://cnb.cool/{path}/-/logos/s，详见 useCnbAuth.ts 的 cnbGroupLogoUrl），
 * 图片加载失败时降级为组织名首字母占位。
 */
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import type { DropdownMenuItem } from '@nuxt/ui'
import { openUrl } from '@tauri-apps/plugin-opener'
import {
  fetchCnbGroups,
  selectedGroup,
  cnbUser,
  cnbGroupManageUrl,
  cnbGroupLogoUrl,
  type CnbGroup,
  CNB_GROUP_CREATE_URL,
} from '../composables/useCnbAuth'
// 图片内存缓存：组织图标转 data URL 后绘制，菜单重新挂载不再闪动
import { cachedImageSrc, ensureCnbImages } from '../composables/useCnbImages'

/**
 * 在系统浏览器中打开外部链接。
 *
 * 说明：此处不走 <a> 链接（to + target=_blank），而是通过菜单条目的
 * onSelect 回调主动打开 —— 背景：main.ts 的全局外链拦截器在捕获阶段
 * stopPropagation，<a> 点击事件传不到下拉菜单组件，导致菜单无法关闭；
 * 改用 onSelect 后 reka-ui 收到条目选中信号会自动收起菜单。
 * 兜底：非 Tauri 环境（浏览器直接 pnpm dev）用 window.open。
 */
async function openExternal(url: string) {
  if ('__TAURI_INTERNALS__' in window) {
    await openUrl(url)
  }
  else {
    window.open(url, '_blank')
  }
}

defineProps<{
  collapsed?: boolean
}>()

// 界面文案翻译（加载中/空态/失败重试/操作项均随语言切换）
const { t } = useI18n()

/** 用户所在的组织列表（登录后从 CNB 拉取） */
const groups = ref<CnbGroup[]>([])
/** 加载状态：首次加载未完成时按钮与菜单显示占位 */
const loading = ref(false)
/** 加载失败标记（如令牌权限不足、网络异常），菜单中提示重试入口 */
const loadError = ref(false)
// 当前选中组织使用共享状态 selectedGroup（来自 useCnbAuth）：
// 首页等组织维度的页面需要读取同一份选中状态，不再声明本地 ref

/** 拉取组织列表：仅在已登录（有令牌）时发起 */
async function loadGroups() {
  const { cnbToken } = await import('../composables/useCnbAuth')
  if (!cnbToken.value) {
    return
  }
  loading.value = true
  loadError.value = false
  try {
    groups.value = await fetchCnbGroups()
    // 默认选中第一个组织（保持上次选择：若仍存在则不重置）
    if (!selectedGroup.value || !groups.value.some(g => g.id === selectedGroup.value?.id)) {
      selectedGroup.value = groups.value[0] || null
    }
    // 预热组织图标到内存缓存（data URL）：图标就绪后，菜单每次打开
    // 重新挂载的 <img> 都同步绘制，彻底消除"打开菜单头像闪动"
    void ensureCnbImages(groups.value.map(g => cnbGroupLogoUrl(g.path)))
  }
  catch {
    loadError.value = true
  }
  finally {
    loading.value = false
  }
}

onMounted(() => {
  void loadGroups()
})

/** 按钮显示的名称：选中组织名 / 加载中 / 空态 */
const buttonLabel = computed(() => {
  if (loading.value && !selectedGroup.value) {
    return t('groups.loading')
  }
  return selectedGroup.value?.name || t('groups.noGroup')
})

/** 组织名首字母：无头像时的占位字符 */
function initialOf(name: string): string {
  return name.charAt(0).toUpperCase()
}

/**
 * 组织头像 avatar 配置。
 *
 * 图标来源：CNB 官方前端使用的组织图标 URL 规则（详见 useCnbAuth.ts 中
 * cnbGroupLogoUrl 的考证注释）——https://cnb.cool/{path}/-/logos/s，
 * 未自定义图标的组织会返回平台默认占位图，始终有图可显示。
 * 同时传入 text（首字母）作为图片加载失败（如离线、网络异常）时的兜底渲染。
 *
 * 闪动修复：src 优先取内存缓存中的 data URL（cachedImageSrc）——
 * 下拉菜单内容每次打开都重新挂载，data URL 无网络往返、同步绘制，
 * 不会像 no-cache 的远程 URL 那样在加载空窗期闪现占位符。
 */
function groupAvatar(group: CnbGroup) {
  return {
    src: cachedImageSrc(cnbGroupLogoUrl(group.path)),
    alt: group.name,
    text: initialOf(group.name),
  }
}

const items = computed<DropdownMenuItem[][]>(() => {
  // 组织列表区块：加载失败显示重试；正常时列出全部组织供切换
  const groupSection: DropdownMenuItem[] = loadError.value
    ? [{
        label: t('groups.loadFailedRetry'),
        icon: 'i-lucide-refresh-cw',
        onSelect: () => {
          void loadGroups()
        },
      }]
    : groups.value.map(group => ({
        label: group.name,
        // 组织图标走 CNB 官方 logos 规则 URL（失败时降级为首字母占位）
        avatar: groupAvatar(group),
        type: 'checkbox' as const,
        checked: selectedGroup.value?.id === group.id,
        onSelect() {
          selectedGroup.value = group
        },
      }))
  if (!loading.value && !loadError.value && groups.value.length === 0) {
    groupSection.push({
      label: t('groups.empty'),
      icon: 'i-lucide-info',
      disabled: true,
    })
  }

  // 操作区块：两项都是「跳到 cnb.cool 官网」的外链（经全局外链拦截器在
  // 系统浏览器打开），必须带外链标识。
  //
  // 标识实现方式（重要，别删 target）：Nuxt UI 的 DropdownMenu 只在
  // `item.target === '_blank'` 时，自动在标签后渲染外链图标
  // （appConfig.ui.icons.external，即 ↗）。这两项走的是 onSelect 手动打开，
  // 本来没有 target 字段 —— 补上它只为触发内置外链图标，点击行为仍由
  // onSelect 负责（条目没有 to/href，不会真的按 target 跳转）。
  // 不用手写 icon 的原因：前置 icon 位要留给条目自身语义（新建/管理），
  // 外链标识放标签后侧才与其它菜单（侧边栏、命令面板）保持一致。
  //
  // manageUrl 说明：Manage groups 是用户维度页面（/u/{username}/groups），
  // 按当前登录用户名拼接；用户信息极端情况下尚未就绪时降级到 CNB 首页，
  // 保证菜单项始终可用。
  const manageUrl = cnbUser.value
    ? cnbGroupManageUrl(cnbUser.value.username)
    : 'https://cnb.cool'
  const actionSection: DropdownMenuItem[] = [{
    label: t('groups.create'),
    icon: 'i-lucide-circle-plus',
    target: '_blank',
    onSelect: () => {
      void openExternal(CNB_GROUP_CREATE_URL)
    },
  }, {
    label: t('groups.manage'),
    icon: 'i-lucide-cog',
    target: '_blank',
    onSelect: () => {
      void openExternal(manageUrl)
    },
  }]

  return [groupSection, actionSection]
})
</script>

<template>
  <!-- 容器：组织下拉按钮 + 右侧刷新按钮（刷新按钮仅在展开态显示，
       折叠态侧边栏宽度不足，展开后即可刷新） -->
  <div class="flex items-center gap-0.5 w-full">
    <UDropdownMenu
      :items="items"
      :content="{ align: 'center', collisionPadding: 12 }"
      :ui="{ content: collapsed ? 'w-48' : 'w-(--reka-dropdown-menu-trigger-width)' }"
    >
      <UButton
        v-bind="{
          // 选中组织的图标（CNB logos 规则 URL）；未选中时显示应用 W 标识占位
          avatar: selectedGroup ? groupAvatar(selectedGroup) : { text: 'W' },
          label: collapsed ? undefined : buttonLabel,
          trailingIcon: collapsed ? undefined : 'i-lucide-chevrons-up-down'
        }"
        color="neutral"
        variant="ghost"
        block
        :square="collapsed"
        class="min-w-0 flex-1 data-[state=open]:bg-elevated"
        :class="[!collapsed && 'py-2']"
        :ui="{
          trailingIcon: 'text-dimmed'
        }"
      />
    </UDropdownMenu>

    <!-- 刷新组织数据：重新拉取 GET /user/groups（loading 时图标旋转）。
         折叠态下不渲染（v-if），避免在窄侧边栏中挤占图标空间 -->
    <UTooltip
      v-if="!collapsed"
      :text="t('groups.refresh')"
      :shortcuts="[]"
    >
      <UButton
        icon="i-lucide-refresh-cw"
        color="neutral"
        variant="ghost"
        size="sm"
        :loading="loading"
        :aria-label="t('groups.refresh')"
        class="shrink-0"
        @click="loadGroups"
      />
    </UTooltip>
  </div>
</template>
