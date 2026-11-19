<script setup lang="ts">
/**
 * 设置 · 令牌（只读 + 登录方式展示 + 退出登录 + 外跳管理页）。
 *
 * 产品口径（主理人拍板）：不提供应用内替换令牌 —— 更换令牌的唯一路径
 * 是退出登录后重新登录，避免误操作覆盖登录态。
 * 展示：脱敏令牌（前 4 后 4，中间以 • 遮蔽）—— 完整令牌不落日志不回显。
 *
 * OAuth 扩展（cnb-cli 设备授权登录）：
 * - 显示登录方式（OAuth 设备授权 / PAT）与令牌到期时间；
 * - 「重新授权」：回登录页重新走设备授权流（默认选中 OAuth）；
 * - 「同时在 CLI 中退出登录」：调 cnb logout 清 CLI 侧 ~/.cnb/token，
 *   保持应用与 CLI 两端登录态一致。
 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { openUrl } from '@tauri-apps/plugin-opener'
import { cnbToken, logout, CNB_TOKEN_MANAGE_URL } from '../../composables/useCnbAuth'
import { useAppToast } from '../../composables/useAppToast'
// 登出可选清空持久化通知（SQLite）：勾选时在 logout() 之前物理删除
// 当前账号的本地通知数据（依赖 username，logout 之后拿不到）
import { clearNoticesInDb } from '../../composables/useNoticeDb'
import ConfirmDialog from '../../components/common/ConfirmDialog.vue'
import {
  cnbAuthMethod,
  cnbTokenExpiresAt,
  logoutCliSide,
} from '../../composables/useCnbCliAuth'

const router = useRouter()
const { t } = useI18n()
const toast = useAppToast()

/** 当前登录方式标识（OAuth 设备授权 / PAT 访问令牌） */
const authMethodLabel = computed(() =>
  cnbAuthMethod.value === 'oauth'
    ? t('settings.token.methodOauth')
    : t('settings.token.methodPat'),
)

/** OAuth 令牌到期时间（本地化展示；PAT 或未知为空串不展示） */
const expiresAtLabel = computed(() => {
  if (cnbAuthMethod.value !== 'oauth' || !cnbTokenExpiresAt.value) {
    return ''
  }
  // expiresAt 为 Unix 秒，转毫秒后按本地时区格式化
  return new Date(cnbTokenExpiresAt.value * 1000).toLocaleString()
})

/** 脱敏令牌：前 4 后 4，中间 8 个 •；过短令牌整体遮蔽（防信息泄漏） */
const maskedToken = computed(() => {
  const token = cnbToken.value
  if (!token) {
    return t('settings.token.notLoggedIn')
  }
  if (token.length <= 8) {
    return '•'.repeat(token.length)
  }
  return `${token.slice(0, 4)}••••••••${token.slice(-4)}`
})

/** 在系统浏览器打开令牌管理页 */
function openManage() {
  if ('__TAURI_INTERNALS__' in window) {
    void openUrl(CNB_TOKEN_MANAGE_URL)
  }
  else {
    window.open(CNB_TOKEN_MANAGE_URL, '_blank')
  }
}

/** 重新授权：回登录页重新走 OAuth 设备授权流（登录页默认选中 OAuth） */
function handleReauthorize() {
  void router.push('/login')
}

/** 在 CLI 侧退出登录（cnb logout），保持应用与 CLI 两端一致 */
async function handleCliLogout() {
  try {
    await logoutCliSide()
    toast.add({
      title: t('settings.token.cliLoggedOut'),
      color: 'neutral',
      duration: 3000,
    })
  } catch {
    toast.add({
      title: t('settings.token.cliLogoutFailed'),
      color: 'error',
      duration: 3000,
    })
  }
}

/** 退出登录确认弹窗开关（与 UserMenu 同范式：退出前拦一道二次确认） */
const logoutDialogOpen = ref(false)

/**
 * 退出时是否同时清空本地通知数据（SQLite 持久化的历史通知）。
 * 默认 false —— 数据保留是默认策略，用户显式勾选才物理删除。
 */
const logoutClearData = ref(false)

/**
 * 打开退出确认弹窗（「退出登录」按钮入口）：
 * 每次打开重置勾选为默认的不勾选，不残留上次的选择。
 */
function openLogoutDialog() {
  logoutClearData.value = false
  logoutDialogOpen.value = true
}

/**
 * 确认退出：清空本地令牌与账号信息；OAuth 登录时同步清理 CLI 侧令牌。
 *
 * 可选清空数据：勾选「同时清空本地通知数据」时先物理删除当前账号的
 * SQLite 通知（必须在 logout() 之前 —— clearNoticesInDb 依赖
 * cnbUser.username）；删除失败用 toast 告知但不阻塞登出（凭证清理
 * 不能因通知删除失败而中断，用户知道数据还在即可）。
 */
async function handleLogout() {
  // 勾选了清空数据：删除该账号的持久化通知（构建 + 应用两个分区）
  if (logoutClearData.value) {
    try {
      await clearNoticesInDb()
    }
    catch (err) {
      // 删除失败：明确告知"数据未删除"，避免用户误以为已清空
      toast.add({
        title: t('menu.logoutClearFailed'),
        description: String(err),
        color: 'warning',
        duration: 5000,
      })
    }
  }
  logoutDialogOpen.value = false
  // OAuth 登录方式：先清 CLI 侧（cnb logout），失败不阻塞本地登出
  if (cnbAuthMethod.value === 'oauth') {
    await logoutCliSide().catch(() => {})
  }
  logout()
  cnbAuthMethod.value = ''
  cnbTokenExpiresAt.value = 0
  toast.add({
    title: t('menu.loggedOut'),
    description: t('menu.loggedOutDesc'),
    color: 'neutral',
    duration: 3000,
  })
  void router.replace('/login')
}
</script>

<template>
  <UPageCard
    :title="t('settings.token.title')"
    :description="t('settings.token.desc')"
    variant="naked"
  />

  <!-- 当前令牌（脱敏只读）+ 登录方式 + OAuth 到期时间 -->
  <UPageCard variant="subtle">
    <div class="flex items-center justify-between gap-4 flex-wrap">
      <div class="min-w-0">
        <p class="text-sm font-semibold text-highlighted">
          {{ t('settings.token.current') }}
        </p>
        <p class="mt-1 font-mono text-sm text-muted break-all">
          {{ maskedToken }}
        </p>
        <!-- 登录方式：OAuth 设备授权（cnb-cli）/ PAT 访问令牌 -->
        <p class="mt-2 text-sm text-muted">
          <UIcon
            :name="cnbAuthMethod === 'oauth' ? 'i-lucide-fingerprint' : 'i-lucide-key-round'"
            class="size-4 align-text-bottom me-1"
          />
          {{ t('settings.token.method') }}：{{ authMethodLabel }}
        </p>
        <!-- OAuth 令牌到期时间（仅 OAuth 登录且已知过期时间时展示） -->
        <p v-if="expiresAtLabel" class="mt-1 text-sm text-muted">
          <UIcon name="i-lucide-clock" class="size-4 align-text-bottom me-1" />
          {{ t('settings.token.expiresAt') }}：{{ expiresAtLabel }}
        </p>
      </div>
      <UButton
        size="sm"
        color="neutral"
        variant="outline"
        icon="i-lucide-external-link"
        :label="t('settings.token.manage')"
        @click="openManage"
      />
    </div>
  </UPageCard>

  <!-- OAuth 专属操作：重新授权 + CLI 侧退出 -->
  <UPageCard
    v-if="cnbAuthMethod === 'oauth'"
    variant="subtle"
    :title="t('settings.token.oauthActions')"
    :description="t('settings.token.oauthActionsDesc')"
  >
    <template #footer>
      <div class="flex gap-2 flex-wrap">
        <UButton
          size="sm"
          color="neutral"
          variant="outline"
          icon="i-lucide-refresh-cw"
          :label="t('settings.token.reauthorize')"
          @click="handleReauthorize"
        />
        <UButton
          size="sm"
          color="neutral"
          variant="soft"
          icon="i-lucide-unplug"
          :label="t('settings.token.cliLogout')"
          @click="handleCliLogout"
        />
      </div>
    </template>
  </UPageCard>

  <!-- 退出登录（清空本机凭证；替换令牌请退出后重新登录） -->
  <UPageCard
    variant="subtle"
    :title="t('settings.token.logout')"
    :description="t('settings.token.logoutDesc')"
  >
    <template #footer>
      <UButton
        size="sm"
        color="error"
        variant="soft"
        icon="i-lucide-log-out"
        :label="t('settings.token.logout')"
        :disabled="!cnbToken"
        @click="openLogoutDialog"
      />
    </template>
  </UPageCard>

  <!--
    退出登录二次确认弹窗（ConfirmDialog 复用组件）：
    desc 说明默认保留本地通知数据；extra 插槽放「清空数据」勾选框
    （默认不勾选），勾选后 handleLogout 先删 SQLite 通知再登出。
  -->
  <ConfirmDialog
    v-model:open="logoutDialogOpen"
    :title="t('menu.logoutConfirmTitle')"
    :desc="t('menu.logoutConfirmDesc')"
    :confirm-label="t('menu.logout')"
    confirm-color="error"
    @confirm="handleLogout"
  >
    <template #extra>
      <UCheckbox
        v-model="logoutClearData"
        :label="t('menu.logoutClearData')"
      />
    </template>
  </ConfirmDialog>
</template>
