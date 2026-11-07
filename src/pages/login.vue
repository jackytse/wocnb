<script setup lang="ts">
/**
 * 登录页 —— 双登录方式：OAuth 设备授权（默认/首选）+ PAT 令牌。
 *
 * OAuth 流程（useCliDeviceLogin 状态机）：
 * 1. 点击「使用 CNB 账号授权登录」→ 检测 cnb CLI（无则一键自动安装，
 *    失败给出官方手动安装指引）
 * 2. 展示设备码（大字 + 复制）+「打开授权页面」按钮 + 等待授权状态
 *    （cnb login 子进程自身会尝试打开浏览器，按钮作为手动兜底）
 * 3. 每 2s 轮询授权结果，成功后写入登录态并原路返回；可随时取消
 *
 * PAT 方式保留为次级入口（与原实现完全一致）。
 */
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { openUrl } from '@tauri-apps/plugin-opener'
import { loginWithPat, CnbApiError, CNB_TOKEN_GUIDE_URL, CNB_TOKEN_MANAGE_URL } from '../composables/useCnbAuth'
import { useCliDeviceLogin, extractUserCode, markPatLogin } from '../composables/useCnbCliAuth'

const route = useRoute()
const router = useRouter()
// 登录页文案随语言切换（错误提示/按钮/引导区等）
const { t } = useI18n()
const toast = useToast()

/** 当前展示的登录方式：oauth 为默认首选（401 跳转回登录页同样落在这里） */
const view = ref<'oauth' | 'pat'>('oauth')

/**
 * 是否因登录态过期被重定向到登录页（401 拦截器携带 expired=1 参数）。
 * 此时在卡片顶部展示提示，让用户明白为什么回到了登录页。
 */
const isSessionExpired = computed(() => route.query.expired === '1')

/** OAuth 设备授权状态机（成功后原路返回） */
const deviceLogin = useCliDeviceLogin({
  onSuccess: () => void navigateAfterLogin(),
})

/** 设备码：从验证链接 query 参数提取（CLI 输出非 debug 模式不含独立 user_code 行） */
const deviceCode = computed(() => extractUserCode(deviceLogin.verificationUrl.value))

/** 登录成功后跳转：回到登录前想访问的页面（路由守卫写入 redirect 参数） */
async function navigateAfterLogin() {
  const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/'
  await router.replace(redirect)
}

/** 手动打开授权页面（CLI 自动打开浏览器失败时的兜底；系统浏览器打开） */
function openVerificationPage() {
  const url = deviceLogin.verificationUrl.value
  if (!url) {
    return
  }
  if ('__TAURI_INTERNALS__' in window) {
    void openUrl(url)
  }
  else {
    window.open(url, '_blank')
  }
}

/** 复制设备码（Webview 支持 clipboard API；失败降级提示） */
async function copyDeviceCode() {
  if (!deviceCode.value) {
    return
  }
  try {
    await navigator.clipboard.writeText(deviceCode.value)
    toast.add({
      title: t('common.copied'),
      color: 'neutral',
      duration: 2000,
    })
  } catch {
    // 剪贴板权限被拒等：静默失败，用户仍可手动选中复制
  }
}

// —— PAT 登录（保留原有实现） ——
/**
 * 输入框中的令牌明文（type=password 掩码显示，可切换可见性）。
 * 本地调试（dev 模式）自动预填测试令牌，省去手动粘贴；
 * 测试令牌来自 .env.development（不进 git、不进 build 产物），生产构建为空串。
 */
const pat = ref(import.meta.env.VITE_CNB_TEST_TOKEN || '')
/** 令牌明文可见性切换 */
const showToken = ref(false)
/** 登录中状态：按钮禁用 + loading 动画，防止重复提交 */
const loading = ref(false)
/** 登录失败的提示文案（空字符串表示无错误） */
const errorMessage = ref('')

/** 切换到 PAT 视图：先取消进行中的设备授权会话（缺陷 D5 —— 否则 CLI 子进程
 * 与轮询继续存活，用户在 PAT 页登录成功后旧授权仍可能迟到完成） */
function switchToPat() {
  view.value = 'pat'
  void deviceLogin.cancel()
}

/** 提交 PAT 登录 */
async function handleLogin() {
  errorMessage.value = ''
  if (!pat.value.trim()) {
    errorMessage.value = t('login.emptyToken')
    return
  }
  loading.value = true
  try {
    await loginWithPat(pat.value)
    // 记录登录方式为 PAT（缺陷 D2）：防止残留 oauth 标记让重启时的
    // 临期刷新分支把 CLI 侧旧 OAuth 令牌静默覆盖刚登录的 PAT
    markPatLogin()
    await navigateAfterLogin()
  }
  catch (err) {
    // CnbApiError 携带面向用户的中文提示；其他异常给出兜底文案
    errorMessage.value = err instanceof CnbApiError ? err.message : t('login.loginFailed')
  }
  finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="w-full max-w-sm px-4">
    <UCard class="rounded-lg">
      <div class="flex flex-col items-center gap-1 mb-6">
        <!-- 应用标识：与应用图标同款的橙色圆角方块 + 白色 W -->
        <div class="size-12 rounded-lg bg-[#db5400] flex items-center justify-center mb-2">
          <span class="text-white text-2xl font-bold">W</span>
        </div>
        <h1 class="text-lg font-semibold text-highlighted">
          {{ t('login.title') }}
        </h1>
        <p class="text-sm text-muted text-center">
          {{ t('login.subtitle') }}
        </p>
      </div>

      <!-- 登录态过期提示：由 401 拦截器重定向时携带 expired=1 -->
      <UAlert
        v-if="isSessionExpired"
        icon="i-lucide-clock-alert"
        color="warning"
        variant="soft"
        :title="t('login.expiredTitle')"
        :description="t('login.expiredDesc')"
        class="mb-4"
      />

      <!-- ==================== OAuth 设备授权（默认视图） ==================== -->
      <div v-if="view === 'oauth'" class="flex flex-col gap-4">
        <!-- 阶段一：未开始，主入口按钮 -->
        <template v-if="deviceLogin.phase.value === 'idle'">
          <UButton
            size="lg"
            block
            icon="i-lucide-fingerprint"
            @click="deviceLogin.begin()"
          >
            {{ t('login.oauthButton') }}
          </UButton>
          <p class="text-xs text-muted text-center">
            {{ t('login.oauthDesc') }}
          </p>
        </template>

        <!-- 阶段二：准备中（检测/安装 CLI） -->
        <template v-else-if="deviceLogin.phase.value === 'preparing'">
          <div class="flex flex-col items-center gap-3 py-6">
            <UIcon name="i-lucide-loader-circle" class="size-6 animate-spin text-muted" />
            <p class="text-sm text-muted">
              {{ deviceLogin.statusText.value }}
            </p>
          </div>
          <UButton
            color="neutral"
            variant="ghost"
            block
            size="sm"
            @click="deviceLogin.cancel()"
          >
            {{ t('login.cancelAuth') }}
          </UButton>
        </template>

        <!-- 阶段三：等待授权（设备码 + 打开授权页 + 轮询中） -->
        <template v-else-if="deviceLogin.phase.value === 'waiting'">
          <div class="flex flex-col items-center gap-3">
            <p class="text-sm text-muted">
              {{ t('login.waitingAuth') }}
            </p>
            <!-- 设备码大字展示（提取自验证链接；缺失时仅展示链接按钮） -->
            <template v-if="deviceCode">
              <p class="text-sm text-muted">
                {{ t('login.userCodeLabel') }}
              </p>
              <div class="flex items-center gap-2">
                <span class="font-mono text-3xl font-bold tracking-widest text-highlighted select-all">{{ deviceCode }}</span>
                <UButton
                  icon="i-lucide-copy"
                  color="neutral"
                  variant="ghost"
                  size="sm"
                  :aria-label="t('login.copyCode')"
                  @click="copyDeviceCode"
                />
              </div>
            </template>
            <UIcon name="i-lucide-loader-circle" class="size-5 animate-spin text-muted" />
          </div>
          <UButton
            size="lg"
            block
            icon="i-lucide-external-link"
            @click="openVerificationPage"
          >
            {{ t('login.openAuthPage') }}
          </UButton>
          <UButton
            color="neutral"
            variant="ghost"
            block
            size="sm"
            @click="deviceLogin.cancel()"
          >
            {{ t('login.cancelAuth') }}
          </UButton>
        </template>

        <!-- 阶段四：失败（错误详情 + 重试） -->
        <template v-else-if="deviceLogin.phase.value === 'failed'">
          <UAlert
            icon="i-lucide-circle-alert"
            color="error"
            variant="soft"
            :title="t('login.cliAuthFailed')"
            :description="deviceLogin.errorMessage.value"
          />
          <UButton
            size="lg"
            block
            icon="i-lucide-refresh-cw"
            @click="deviceLogin.retry()"
          >
            {{ t('login.retryAuth') }}
          </UButton>
        </template>

        <!-- 次级入口：切换到 PAT 登录（同时取消进行中的设备授权会话） -->
        <UButton
          color="neutral"
          variant="link"
          block
          size="sm"
          class="mt-2"
          @click="switchToPat"
        >
          {{ t('login.patSwitch') }}
        </UButton>
      </div>

      <!-- ==================== PAT 令牌登录（次级视图） ==================== -->
      <template v-else>
        <form class="flex flex-col gap-4" @submit.prevent="handleLogin">
          <UFormField :label="t('login.tokenLabel')" :error="errorMessage || undefined">
            <UInput
              v-model="pat"
              :type="showToken ? 'text' : 'password'"
              :placeholder="t('login.tokenPlaceholder')"
              class="w-full"
              size="lg"
              :disabled="loading"
              autocomplete="off"
            >
              <template #trailing>
                <UButton
                  :icon="showToken ? 'i-lucide-eye-off' : 'i-lucide-eye'"
                  color="neutral"
                  variant="link"
                  size="sm"
                  :aria-label="showToken ? t('login.hideToken') : t('login.showToken')"
                  @click="showToken = !showToken"
                />
              </template>
            </UInput>
          </UFormField>

          <UButton
            type="submit"
            size="lg"
            block
            :loading="loading"
            :disabled="loading"
          >
            {{ loading ? t('login.verifying') : t('login.signIn') }}
          </UButton>
        </form>

        <USeparator class="my-5" :label="t('login.noToken')" />

        <!-- 引导区：官方文档指南 + 令牌创建页，均在系统浏览器中打开 -->
        <div class="flex flex-col gap-2">
          <UButton
            :to="CNB_TOKEN_GUIDE_URL"
            target="_blank"
            color="neutral"
            variant="outline"
            block
            icon="i-lucide-book-open"
          >
            {{ t('login.howToGet') }}
          </UButton>
          <UButton
            :to="CNB_TOKEN_MANAGE_URL"
            target="_blank"
            color="neutral"
            variant="ghost"
            block
            size="sm"
            trailing-icon="i-lucide-external-link"
          >
            {{ t('login.manageToken') }}
          </UButton>
        </div>

        <!-- 返回 OAuth 授权登录（默认方式） -->
        <UButton
          color="neutral"
          variant="link"
          block
          size="sm"
          class="mt-4"
          @click="view = 'oauth'"
        >
          {{ t('login.oauthSwitch') }}
        </UButton>
      </template>
    </UCard>

    <p class="text-xs text-center text-muted mt-4">
      {{ t('login.privacy') }}
    </p>
  </div>
</template>

<route lang="yaml">
meta:
  layout: blank
</route>
