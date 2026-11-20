<script setup lang="ts">
/**
 * 用户资料卡弹窗（2026-11-20 用户需求：仓库内可查看贡献者个人信息）。
 *
 * 数据：GET /users/{username}（dto.UsersResult，见 fetchUserProfile）。
 * 展示：头像 / 昵称 / 用户名 / bio / 关注者·关注·公开仓库计数 /
 * 公司·位置·网站·加入时间；底部按钮在系统浏览器打开用户主页
 * （应用内无用户页路由 —— 红线：别造路由，一律外跳）。
 *
 * 复用场景：仓库社区页签贡献者头像墙、Star 用户列表（点击条目弹出）。
 * 失败态在弹窗内 StateAlert 降级（可重试），不外抛阻塞调用方页面。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { openUrl } from '@tauri-apps/plugin-opener'
import {
  cnbUserProfileUrl,
  fetchUserProfile,
  userProfileAvatar,
  type UserProfile,
} from '../composables/useCnbSocial'
import { formatDateTime } from '../utils'
import StateAlert from './repo/StateAlert.vue'

const props = defineProps<{
  /** 弹窗开关（v-model:open） */
  open: boolean
  /** 目标用户名（打开时按此拉取资料） */
  username: string
}>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
}>()

const { t } = useI18n()

const openModel = computed({
  get: () => props.open,
  set: (value: boolean) => emit('update:open', value),
})

const profile = ref<UserProfile | null>(null)
const loading = ref(false)
const error = ref<Error | null>(null)

/**
 * 拉取资料：仅弹窗打开且用户名非空时请求；
 * 打开期间 username 变化（用户连续点不同头像）同样重拉。
 */
async function load() {
  if (!props.open || !props.username) {
    return
  }
  loading.value = true
  error.value = null
  try {
    profile.value = await fetchUserProfile(props.username)
  }
  catch (err) {
    profile.value = null
    error.value = err as Error
  }
  finally {
    loading.value = false
  }
}

// open/username 任一变化即重拉（immediate 兜底首次挂载即开场景）
watch(
  () => `${props.open}|${props.username}`,
  () => void load(),
  { immediate: true },
)

/** 展示名：nickname 缺省回退 username（与全库列表口径一致） */
const displayName = computed(() =>
  profile.value?.nickname || profile.value?.username || props.username,
)

/** 头像地址（服务端 avatar 空 → CNB 规则 URL 兜底） */
const avatarSrc = computed(() =>
  profile.value ? userProfileAvatar(profile.value) : undefined,
)

/**
 * 个人网站可跳转地址：服务端可能返回不带协议的裸域名（如 example.com），
 * 补 https:// 前缀；已有协议则原样使用。
 */
const siteHref = computed(() => {
  const site = profile.value?.site || ''
  if (!site) {
    return ''
  }
  return /^https?:\/\//i.test(site) ? site : `https://${site}`
})

/**
 * 在系统浏览器打开用户主页。
 * 非 Tauri 环境（vitest / 浏览器调试）用 window.open 兜底，
 * 与 FollowListDrawer.openProfile / RepoEmptyRepo.openInBrowser 同构。
 */
function openInBrowser(): void {
  if (!profile.value) {
    return
  }
  const url = cnbUserProfileUrl(profile.value.username)
  if ('__TAURI_INTERNALS__' in window) {
    void openUrl(url)
  }
  else {
    window.open(url, '_blank')
  }
}

/** 打开个人网站（同样走系统浏览器；主窗口 opener 拦截规则已放行外链） */
function openSite(): void {
  if (!siteHref.value) {
    return
  }
  if ('__TAURI_INTERNALS__' in window) {
    void openUrl(siteHref.value)
  }
  else {
    window.open(siteHref.value, '_blank')
  }
}
</script>

<template>
  <UModal
    v-model:open="openModel"
    :title="t('repo.userProfile.title')"
    :ui="{ content: 'max-w-sm' }"
  >
    <template #body>
      <StateAlert
        v-if="loading"
        state="loading"
        loading-variant="detail"
      />
      <StateAlert
        v-else-if="error"
        state="error"
        :error="error"
        :retry="load"
      />

      <!-- 资料主体：头像 + 身份行 + bio + 计数 + 元信息 -->
      <div
        v-else-if="profile"
        class="flex flex-col gap-4"
      >
        <!-- 头像 + 昵称 + 用户名 + 徽标 -->
        <div class="flex items-center gap-3">
          <UAvatar
            :src="avatarSrc"
            :alt="displayName"
            size="lg"
          />
          <div class="min-w-0 flex flex-col gap-0.5">
            <div class="flex items-center gap-1.5 min-w-0">
              <span class="text-base font-semibold truncate">{{ displayName }}</span>
              <!-- 认证徽标：verified 仅展示，不做任何写操作 -->
              <UIcon
                v-if="profile.verified"
                name="i-lucide-badge-check"
                class="size-4 text-primary shrink-0"
              />
            </div>
            <span class="text-xs text-dimmed truncate">{{ profile.username }}</span>
            <!-- 关注关系：is_following 来自访问者视角，未登录恒 false 不展示 -->
            <UBadge
              v-if="profile.isFollowing"
              size="sm"
              color="primary"
              variant="subtle"
              class="w-fit"
            >
              {{ t('repo.userProfile.followingBadge') }}
            </UBadge>
          </div>
        </div>

        <!-- bio：空不占位 -->
        <p
          v-if="profile.bio"
          class="text-sm text-default whitespace-pre-wrap break-words"
        >
          {{ profile.bio }}
        </p>

        <!-- 计数行：关注者 / 关注 / 公开仓库 -->
        <div class="flex items-center gap-5 text-sm">
          <span class="flex items-center gap-1.5">
            <UIcon
              name="i-lucide-users"
              class="size-3.5 text-dimmed"
            />
            <b class="font-semibold">{{ profile.followerCount }}</b>
            <span class="text-dimmed text-xs">{{ t('repo.userProfile.followers') }}</span>
          </span>
          <span class="flex items-center gap-1.5">
            <b class="font-semibold">{{ profile.followCount }}</b>
            <span class="text-dimmed text-xs">{{ t('repo.userProfile.following') }}</span>
          </span>
          <span class="flex items-center gap-1.5">
            <UIcon
              name="i-lucide-folder-git-2"
              class="size-3.5 text-dimmed"
            />
            <b class="font-semibold">{{ profile.publicRepoCount }}</b>
            <span class="text-dimmed text-xs">{{ t('repo.userProfile.publicRepos') }}</span>
          </span>
        </div>

        <!-- 元信息：公司 / 位置 / 网站 / 加入时间（逐项空值隐藏） -->
        <ul class="flex flex-col gap-1.5 text-xs text-dimmed">
          <li
            v-if="profile.company"
            class="flex items-center gap-2"
          >
            <UIcon
              name="i-lucide-building-2"
              class="size-3.5 shrink-0"
            />
            <span class="truncate">{{ profile.company }}</span>
          </li>
          <li
            v-if="profile.location"
            class="flex items-center gap-2"
          >
            <UIcon
              name="i-lucide-map-pin"
              class="size-3.5 shrink-0"
            />
            <span class="truncate">{{ profile.location }}</span>
          </li>
          <li
            v-if="siteHref"
            class="flex items-center gap-2"
          >
            <UIcon
              name="i-lucide-link"
              class="size-3.5 shrink-0"
            />
            <button
              type="button"
              class="text-primary hover:underline truncate cursor-pointer"
              @click="openSite"
            >
              {{ profile.site }}
            </button>
          </li>
          <li
            v-if="profile.createdAt"
            class="flex items-center gap-2"
          >
            <UIcon
              name="i-lucide-calendar"
              class="size-3.5 shrink-0"
            />
            <span class="truncate">{{ t('repo.userProfile.joinedAt', { time: formatDateTime(profile.createdAt) }) }}</span>
          </li>
        </ul>
      </div>
    </template>

    <!-- 底部动作：浏览器打开主页（资料未就绪时禁用防误触） -->
    <template #footer>
      <UButton
        block
        size="sm"
        color="neutral"
        variant="outline"
        icon="i-lucide-external-link"
        :disabled="!profile"
        :label="t('common.openInBrowser')"
        @click="openInBrowser"
      />
    </template>
  </UModal>
</template>
