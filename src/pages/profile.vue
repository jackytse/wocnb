<script setup lang="ts">
/**
 * 个人资料页 —— 查看与修改当前 CNB 用户的个人信息。
 *
 * 数据来源：
 * - 读取：CNB Open API GET /user（dto.UsersResult，含昵称/简介/公司等完整资料）
 * - 保存：CNB Open API POST /user（dto.UpdateUserInfoPayload），
 *   令牌需包含 account-profile:rw 权限
 *
 * 可编辑字段：个人简介、公司、所在地、地址、个人主页、微信公众号。
 * 只读字段：用户名（CNB 资源路径唯一标识）、昵称（实测 CNB 拒绝通过
 * POST /user 修改昵称，携带 nickname 一律返回 403 "Nickname cannot be
 * changed."，需在官网操作）、邮箱、头像（后三者在 CNB 网站的账号设置中维护）。
 *
 * 保存成功后 useCnbAuth 内部会同步本地登录态（头像等），
 * 侧边栏用户菜单等界面随之立即更新。
 */
import * as z from 'zod'
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import {
  fetchCnbUserProfile,
  updateCnbProfile,
  cnbUser,
  type CnbProfilePayload,
} from '../composables/useCnbAuth'
import {
  fetchMyStarredRepos,
  type StarredRepoItem,
} from '../composables/useCnbSocial'
import PinnedRepoWall from '../components/org/PinnedRepoWall.vue'
import FollowListDrawer from '../components/FollowListDrawer.vue'
import StateAlert from '../components/repo/StateAlert.vue'

const { t } = useI18n()
const toast = useToast()
const router = useRouter()

/**
 * 表单校验规则构造器：各字段均可选。
 * site 特殊校验：CNB 服务器要求个人主页必须携带协议前缀
 * （http:// 或 https://），否则返回 400 "The parameter site is invalid."；
 * 前端预校验可在提交前给出明确提示，避免无谓的请求往返。
 */
const buildSchema = () => z.object({
  bio: z.string().optional(),
  company: z.string().optional(),
  location: z.string().optional(),
  address: z.string().optional(),
  site: z.string().refine(
    value => value === '' || /^https?:\/\//.test(value),
    t('profile.siteInvalid'),
  ),
  wechatMp: z.string().optional(),
  // 社交计数（T14）：只读派生值 —— schema 仅承载类型与回显，
  // onSubmit 显式构造提交负载，三者不会随表单提交（-1 = 服务端缺失 → 「—」）
  followerCount: z.number().optional(),
  followingCount: z.number().optional(),
  starsCount: z.number().optional(),
})
type ProfileSchema = z.output<ReturnType<typeof buildSchema>>

/** schema 用 computed 包裹：错误提示文案 t() 依赖语言，切换语言时重建，校验提示随语言显示 */
const profileSchema = computed(buildSchema)

/** 表单状态（可编辑字段；昵称不在其中——API 不支持修改，见组件头注释） */
const profile = reactive<ProfileSchema>({
  bio: '',
  company: '',
  location: '',
  address: '',
  site: '',
  wechatMp: '',
  followerCount: undefined,
  followingCount: undefined,
  starsCount: undefined,
})

/** 首次加载状态：加载中显示骨架屏 */
const loading = ref(false)
/** 加载失败标记（显示重试入口） */
const loadError = ref(false)
/** 保存中状态：按钮 loading + 防重复提交 */
const saving = ref(false)

// ---------------------------------------------------------------------------
// 社交增强（T14）：粉丝/关注计数 + 我的 Star 页签 + 只读仓库墙
// 均为独立区块（403 只影响自身，绝不阻塞上方资料编辑表单）
// ---------------------------------------------------------------------------

/** 计数展示：-1（服务端缺失 / 缺 account-engage:r）→「—」，0 合法 */
function displayCount(value: number): string {
  return value < 0 ? '—' : String(value)
}

const followerDisplay = computed(() => displayCount(profile.followerCount ?? -1))
const followingDisplay = computed(() => displayCount(profile.followingCount ?? -1))
const starsDisplay = computed(() => displayCount(profile.starsCount ?? -1))

/** 抽屉状态（粉丝 / 关注共用一个 USlideover，mode 切换） */
const drawerOpen = ref(false)
const drawerMode = ref<'followers' | 'following'>('followers')

function openFollowDrawer(mode: 'followers' | 'following') {
  drawerMode.value = mode
  drawerOpen.value = true
}

/** 「我的 Star / 仓库墙」页签（页签渲染于社交区块内，不影响资料表单） */
const socialTab = ref<'stars' | 'wall'>('stars')
const socialTabItems = computed(() => [
  { label: t('profile.tabMyStars'), value: 'stars', icon: 'i-lucide-star' },
  { label: t('profile.tabPinnedWall'), value: 'wall', icon: 'i-lucide-pin' },
])

/** 我的 Star 仓库（GET /user/stared-repos；红线：无任何"点 Star"入口） */
const starredRepos = ref<StarredRepoItem[]>([])
const starredLoading = ref(false)
const starredError = ref<Error | null>(null)

async function loadStarred() {
  starredLoading.value = true
  starredError.value = null
  try {
    starredRepos.value = await fetchMyStarredRepos()
  }
  catch (err) {
    starredRepos.value = []
    starredError.value = err as Error
  }
  finally {
    starredLoading.value = false
  }
}

/** Star 仓库点击进应用内详情 */
function openStarredRepo(path: string) {
  void router.push(`/repos/${path}?tab=code`)
}

// 首次切到 Star 页签或资料加载完成后拉取（独立区块，失败不影响表单）
watch(socialTab, (value) => {
  if (value === 'stars' && starredRepos.value.length === 0 && !starredError.value) {
    void loadStarred()
  }
}, { immediate: true })

/** 拉取当前资料并填充表单 */
async function loadProfile() {
  loading.value = true
  loadError.value = false
  try {
    const data: CnbProfilePayload = await fetchCnbUserProfile()
    Object.assign(profile, data)
  }
  catch {
    loadError.value = true
  }
  finally {
    loading.value = false
  }
}

onMounted(() => {
  void loadProfile()
})

/** 保存资料：POST /user 成功后给出成功反馈（本地登录态由 useCnbAuth 同步） */
async function onSubmit() {
  if (saving.value) {
    return
  }
  saving.value = true
  try {
    // 注意：nickname 不提交 —— CNB 拒绝通过 API 修改昵称（见组件头注释）
    await updateCnbProfile({
      nickname: cnbUser.value?.nickname || '',
      bio: profile.bio || '',
      company: profile.company || '',
      location: profile.location || '',
      address: profile.address || '',
      site: profile.site || '',
      wechatMp: profile.wechatMp || '',
    })
    toast.add({
      title: t('profile.saveSuccess'),
      description: t('profile.saveSuccessDesc'),
      icon: 'i-lucide-check',
      color: 'success',
    })
  }
  catch (err) {
    toast.add({
      title: t('profile.saveFailed'),
      description: err instanceof Error ? err.message : t('profile.saveFailedDesc'),
      icon: 'i-lucide-circle-alert',
      color: 'error',
    })
  }
  finally {
    saving.value = false
  }
}
</script>

<template>
  <UDashboardPanel id="profile">
    <template #header>
      <UDashboardNavbar :title="t('profile.title')">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <!-- 加载中：骨架屏占位，避免表单先空后填的跳动 -->
      <div v-if="loading" class="flex flex-col gap-4 max-w-2xl">
        <USkeleton v-for="i in 5" :key="i" class="h-16 w-full rounded-lg" />
      </div>

      <!-- 加载失败：提示 + 重试 -->
      <UAlert
        v-else-if="loadError"
        icon="i-lucide-cloud-alert"
        color="error"
        variant="soft"
        :title="t('profile.loadFailedTitle')"
        :description="t('profile.loadFailedDesc')"
        class="max-w-2xl"
      >
        <template #actions>
          <UButton
            size="sm"
            color="error"
            variant="soft"
            icon="i-lucide-refresh-cw"
            @click="loadProfile"
          >
            {{ t('common.retry') }}
          </UButton>
        </template>
      </UAlert>

      <!-- 资料表单：布局与设置页风格一致（label 左、控件右） -->
      <UForm
        v-else
        id="profile-form"
        :schema="profileSchema"
        :state="profile"
        class="max-w-2xl"
        @submit="onSubmit"
      >
        <UPageCard
          :title="t('profile.title')"
          :description="t('profile.description')"
          variant="naked"
          orientation="horizontal"
          class="mb-4"
        >
          <UButton
            form="profile-form"
            :label="saving ? t('profile.saving') : t('profile.save')"
            color="neutral"
            type="submit"
            :loading="saving"
            :disabled="saving"
            class="w-fit lg:ms-auto"
          />
        </UPageCard>

        <UPageCard variant="subtle">
          <!-- 用户名：CNB 资源路径唯一标识，只读展示 -->
          <UFormField
            name="username"
            :label="t('profile.username')"
            :description="t('profile.usernameDesc')"
            class="flex max-sm:flex-col justify-between items-start gap-4"
          >
            <UInput
              :model-value="cnbUser?.username"
              disabled
              autocomplete="off"
            />
          </UFormField>
          <USeparator />
          <!-- 头像：在 CNB 网站账号设置中维护，此处展示 + 跳转引导 -->
          <UFormField
            name="avatar"
            :label="t('profile.avatar')"
            :description="t('profile.avatarDesc')"
            class="flex max-sm:flex-col justify-between sm:items-center gap-4"
          >
            <div class="flex flex-wrap items-center gap-3">
              <UAvatar
                :src="cnbUser?.avatar"
                :alt="cnbUser?.nickname"
                size="lg"
              />
              <UButton
                :label="t('profile.changeOnCnb')"
                color="neutral"
                variant="outline"
                icon="i-lucide-external-link"
                to="https://cnb.cool/profile"
                target="_blank"
              />
            </div>
          </UFormField>
          <USeparator />
          <!-- 昵称：CNB 不允许通过 API 修改（携带 nickname 提交一律 403），
               只读展示并提供官网跳转引导 -->
          <UFormField
            name="nickname"
            :label="t('profile.nickname')"
            :description="t('profile.nicknameDesc')"
            class="flex max-sm:flex-col justify-between items-start gap-4"
          >
            <div class="flex flex-wrap items-center gap-3">
              <UInput
                :model-value="cnbUser?.nickname"
                disabled
                autocomplete="off"
              />
              <UButton
                :label="t('profile.changeOnCnb')"
                color="neutral"
                variant="outline"
                icon="i-lucide-external-link"
                :to="cnbUser?.username ? `https://cnb.cool/u/${cnbUser.username}` : 'https://cnb.cool'"
                target="_blank"
              />
            </div>
          </UFormField>
          <USeparator />
          <UFormField
            name="bio"
            :label="t('profile.bio')"
            class="flex max-sm:flex-col justify-between items-start gap-4"
            :ui="{ container: 'w-full' }"
          >
            <UTextarea
              v-model="profile.bio"
              :rows="4"
              autoresize
              class="w-full"
            />
          </UFormField>
          <USeparator />
          <UFormField
            name="company"
            :label="t('profile.company')"
            class="flex max-sm:flex-col justify-between items-start gap-4"
          >
            <UInput
              v-model="profile.company"
              autocomplete="off"
            />
          </UFormField>
          <USeparator />
          <UFormField
            name="location"
            :label="t('profile.location')"
            class="flex max-sm:flex-col justify-between items-start gap-4"
          >
            <UInput
              v-model="profile.location"
              autocomplete="off"
            />
          </UFormField>
          <USeparator />
          <UFormField
            name="address"
            :label="t('profile.address')"
            class="flex max-sm:flex-col justify-between items-start gap-4"
          >
            <UInput
              v-model="profile.address"
              autocomplete="off"
            />
          </UFormField>
          <USeparator />
          <!-- 个人主页：服务器要求必须带 http(s):// 协议前缀（否则 400），
               schema 已做预校验，placeholder 亦作引导 -->
          <UFormField
            name="site"
            :label="t('profile.site')"
            :description="t('profile.siteDesc')"
            class="flex max-sm:flex-col justify-between items-start gap-4"
          >
            <UInput
              v-model="profile.site"
              type="url"
              placeholder="https://"
              autocomplete="off"
            />
          </UFormField>
          <USeparator />
          <UFormField
            name="wechatMp"
            :label="t('profile.wechatMp')"
            class="flex max-sm:flex-col justify-between items-start gap-4"
          >
            <UInput
              v-model="profile.wechatMp"
              autocomplete="off"
            />
          </UFormField>
        </UPageCard>
      </UForm>

      <!-- ====== 社交增强区块（T14，独立降级：不阻塞上方表单） ====== -->
      <div class="mt-6 max-w-2xl flex flex-col gap-4">
        <!-- 粉丝 / 关注 / Star 计数（点击开抽屉；缺失显示 —） -->
        <UPageCard variant="subtle">
          <div class="flex items-center gap-6 flex-wrap">
            <button
              type="button"
              class="flex items-center gap-1.5 text-sm cursor-pointer hover:opacity-80"
              @click="openFollowDrawer('followers')"
            >
              <UIcon
                name="i-lucide-users"
                class="size-4 text-dimmed"
              />
              <span class="text-dimmed">{{ t('profile.followers') }}</span>
              <span class="font-semibold text-highlighted">{{ followerDisplay }}</span>
            </button>
            <button
              type="button"
              class="flex items-center gap-1.5 text-sm cursor-pointer hover:opacity-80"
              @click="openFollowDrawer('following')"
            >
              <UIcon
                name="i-lucide-user-plus"
                class="size-4 text-dimmed"
              />
              <span class="text-dimmed">{{ t('profile.following') }}</span>
              <span class="font-semibold text-highlighted">{{ followingDisplay }}</span>
            </button>
            <div class="flex items-center gap-1.5 text-sm">
              <UIcon
                name="i-lucide-star"
                class="size-4 text-dimmed"
              />
              <span class="text-dimmed">{{ t('profile.starCountLabel') }}</span>
              <span class="font-semibold text-highlighted">{{ starsDisplay }}</span>
            </div>
          </div>
        </UPageCard>

        <!-- 「我的 Star / 仓库墙」页签（红线：无任何"点 Star"入口） -->
        <UTabs
          v-model="socialTab"
          :items="socialTabItems"
          color="neutral"
        />

        <!-- 我的 Star 页签：仓库列表（点击进应用内详情；不提供 Star 操作） -->
        <div v-if="socialTab === 'stars'">
          <StateAlert
            v-if="starredLoading"
            state="loading"
            loading-variant="list"
          />
          <StateAlert
            v-else-if="starredError"
            state="error"
            :error="starredError"
            :retry="loadStarred"
          />
          <StateAlert
            v-else-if="starredRepos.length === 0"
            state="empty"
            :empty-text="t('profile.starsEmpty')"
            :empty-desc="t('profile.starsEmptyDesc')"
          />
          <div
            v-else
            class="flex flex-col gap-2"
          >
            <button
              v-for="repo in starredRepos"
              :key="repo.path"
              type="button"
              class="flex items-center gap-3 px-4 py-2.5 rounded-lg border border-default text-left hover:bg-elevated/50 cursor-pointer"
              @click="openStarredRepo(repo.path)"
            >
              <UIcon
                name="i-lucide-folder-git-2"
                class="size-4 text-muted shrink-0"
              />
              <span class="min-w-0 flex flex-col">
                <span class="text-sm font-medium text-highlighted truncate">{{ repo.name }}</span>
                <span
                  v-if="repo.description"
                  class="text-xs text-dimmed truncate"
                >{{ repo.description }}</span>
              </span>
              <span class="ms-auto flex items-center gap-3 text-xs text-dimmed shrink-0">
                <span
                  v-if="repo.starCount > 0"
                  class="inline-flex items-center gap-1"
                >
                  <UIcon
                    name="i-lucide-star"
                    class="size-3"
                  />
                  {{ repo.starCount }}
                </span>
                <span
                  v-if="repo.forkCount > 0"
                  class="inline-flex items-center gap-1"
                >
                  <UIcon
                    name="i-lucide-git-fork"
                    class="size-3"
                  />
                  {{ repo.forkCount }}
                </span>
              </span>
            </button>
          </div>
        </div>

        <!-- 仓库墙页签：个人墙只读（复用组织墙组件，样式一致，T14 验收 2） -->
        <PinnedRepoWall
          v-else
          :username="cnbUser?.username || ''"
          mode="readonly"
        />
      </div>

      <!-- 粉丝 / 关注列表抽屉（T14 验收 1；列表项外跳用户主页） -->
      <FollowListDrawer
        v-model:open="drawerOpen"
        :mode="drawerMode"
        :username="cnbUser?.username || ''"
      />
    </template>
  </UDashboardPanel>
</template>
