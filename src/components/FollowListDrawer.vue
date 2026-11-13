<script setup lang="ts">
/**
 * 粉丝 / 关注列表抽屉（T14 验收 1）。
 *
 * 数据：GET /users/{username}/followers | /following（scope account-engage:r）。
 * 列表项点击 → **外跳** https://cnb.cool/{username}（应用内无用户页路由，
 * 红线：别造路由）。403（缺 account-engage:r）→ StateAlert forbidden
 * 呈现于抽屉内（绝不阻塞 profile 页主体）。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { openUrl } from '@tauri-apps/plugin-opener'
import {
  cnbUserProfileUrl,
  fetchUserFollowers,
  fetchUserFollowing,
  type FollowUserItem,
} from '../composables/useCnbSocial'
import { cnbAvatarUrl } from '../composables/useCnbAuth'
import StateAlert from './repo/StateAlert.vue'

const props = defineProps<{
  /** 抽屉开关（v-model:open） */
  open: boolean
  /** 'followers'：粉丝；'following'：关注 */
  mode: 'followers' | 'following'
  /** 目标用户名（当前登录用户） */
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

const users = ref<FollowUserItem[]>([])
const loading = ref(false)
const error = ref<Error | null>(null)

async function load() {
  if (!props.username || !props.open) {
    return
  }
  loading.value = true
  error.value = null
  try {
    users.value = props.mode === 'followers'
      ? await fetchUserFollowers(props.username)
      : await fetchUserFollowing(props.username)
  }
  catch (err) {
    users.value = []
    error.value = err as Error
  }
  finally {
    loading.value = false
  }
}

// 打开时拉取（mode 变化且抽屉已开时同样重拉）
watch(() => `${props.open}|${props.mode}|${props.username}`, () => void load(), { immediate: true })

/** 列表项展示名（nickname 缺省回退 username） */
function displayName(user: FollowUserItem): string {
  return user.nickname || user.username
}

/** 头像（服务端无 avatar 字段 → CNB 规则 URL 兜底） */
function avatarOf(user: FollowUserItem): string {
  return cnbAvatarUrl(user.username)
}

/** 列表项点击：系统浏览器打开用户主页（应用内无用户页） */
function openProfile(username: string) {
  const url = cnbUserProfileUrl(username)
  if ('__TAURI_INTERNALS__' in window) {
    void openUrl(url)
  }
  else {
    window.open(url, '_blank')
  }
}
</script>

<template>
  <USlideover
    v-model:open="openModel"
    :title="mode === 'followers' ? t('profile.followers') : t('profile.following')"
    :ui="{ content: 'max-w-sm' }"
  >
    <template #body>
      <StateAlert
        v-if="loading"
        state="loading"
        loading-variant="list"
      />
      <StateAlert
        v-else-if="error"
        state="error"
        :error="error"
        :retry="load"
      />
      <StateAlert
        v-else-if="users.length === 0"
        state="empty"
        :empty-text="mode === 'followers' ? t('profile.followersEmpty') : t('profile.followingEmpty')"
      />
      <ul
        v-else
        class="flex flex-col divide-y divide-default"
      >
        <li
          v-for="user in users"
          :key="user.username"
        >
          <button
            type="button"
            class="flex items-center gap-3 py-2.5 w-full text-left hover:bg-elevated/50 cursor-pointer rounded-md px-2 -mx-2"
            @click="openProfile(user.username)"
          >
            <UAvatar
              :src="avatarOf(user)"
              :alt="displayName(user)"
              size="sm"
            />
            <div class="min-w-0 flex flex-col">
              <span class="text-sm truncate">{{ displayName(user) }}</span>
              <span class="text-xs text-dimmed truncate">{{ user.username }}</span>
            </div>
            <UIcon
              name="i-lucide-external-link"
              class="size-3.5 text-dimmed ms-auto shrink-0"
            />
          </button>
        </li>
      </ul>
    </template>
  </USlideover>
</template>
