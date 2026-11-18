<script setup lang="ts">
/**
 * 侧边栏底部的通知入口（铃铛 + 未读徽标）。
 *
 * # 位置沿革（2026-11-18 用户要求）
 *
 * 原本在首页 navbar 右侧（只有首页可见）。但通知是**全局**能力 —— 构建结束、
 * 应用更新等事件与用户当前在哪个页面无关；只在首页露出会让在仓库/组织页
 * 的用户收不到视觉提示。现移到侧边栏左下角、用户名旁边，所有页面常驻可见。
 *
 * # 折叠态约定
 *
 * 侧边栏折叠时**不渲染**本按钮（用户明确要求）：折叠后 footer 只剩头像方
 * 按钮，两个图标会把整行挤满且与展开态头重脚轻。此状态下仍可按快捷键 N
 * 打开通知面板（快捷键全局定义在 useDashboard，与折叠无关）。
 *
 * # 未读数口径
 *
 * 构建通知（轮询产出）+ 应用通知（更新检测等）之和，与面板里两个分区的
 * 内容一一对应；0 时不渲染徽标（UChip 的 show），避免常驻一个"0"。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { unreadBuildCount } from '../composables/useCnbBuildWatch'
import { unreadAppNoticeCount } from '../composables/useAppNotices'
import { useDashboard } from '../composables/useDashboard'

// collapsed 为可选：不传 = 展开态（默认显示按钮）
defineProps<{ collapsed?: boolean }>()

const { t } = useI18n()
const { isNotificationsSlideoverOpen } = useDashboard()

/** 未读通知总数（构建 + 应用），驱动铃铛徽标 */
const badgeCount = computed(() => unreadBuildCount.value + unreadAppNoticeCount.value)

/**
 * 徽标文案：> 99 显示 "99+"。
 * 为什么不直接绑数字：三位数会把圆点撑成椭圆、盖住铃铛图标，
 * 而"超过 99 条"与"正好 99 条"对用户没有信息量差异。
 */
const badgeText = computed(() => (badgeCount.value > 99 ? '99+' : String(badgeCount.value)))
</script>

<template>
  <!-- 折叠时不渲染（见头注释「折叠态约定」） -->
  <UTooltip
    v-if="!collapsed"
    :text="t('home.notifications')"
    :shortcuts="['N']"
  >
    <UButton
      color="neutral"
      variant="ghost"
      square
      :aria-label="t('home.notifications')"
      @click="isNotificationsSlideoverOpen = true"
    >
      <UChip
        color="error"
        inset
        :show="badgeCount > 0"
        :text="badgeText"
      >
        <UIcon name="i-lucide-bell" class="size-5 shrink-0" />
      </UChip>
    </UButton>
  </UTooltip>
</template>
