<script setup lang="ts">
/**
 * 设置 · 通用（/settings 本身，settings/index.vue 原地改造）。
 *
 * 只读摘要：当前登录账号 + 当前选中组织 + 两个跳转入口
 * （应用内个人资料页 / CNB 令牌管理页），以及本版本的「构建通知」设置卡片
 * （开关 / 轮询间隔 / 权限与 scope 提示）。不提供账号编辑能力 ——
 * 个人资料编辑职责在 /profile 页（职责边界由主理人拍板）。
 *
 * 数据来源（全部是响应式的共享状态，本页不自己发请求）：
 * - cnbUser / selectedGroup：登录态与组织选中态，来自 useCnbAuth（localStorage 持久化）；
 * - buildNotifyEnabled / buildNotifyIntervalSec：本页唯一可写的两项用户偏好；
 * - buildScopeMissingCount / buildWatchRepoCount / buildWatchTruncated /
 *   buildNotifyPermissionDenied：轮询侧的只读观测值（由 useCnbBuildWatch 维护）。
 * 这样拆分的好处：设置页只渲染"当前事实"，不改写轮询状态，刷新/重进不会出现
 * "页面显示已开启但轮询其实没跑"的双份真相。
 */
import { computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { openUrl } from '@tauri-apps/plugin-opener'
import { cnbAvatarUrl, cnbGroupLogoUrl, cnbUser, selectedGroup } from '../../composables/useCnbAuth'
import { CNB_TOKEN_MANAGE_URL } from '../../composables/useCnbAuth'
import {
  BUILD_NOTIFY_INTERVAL_OPTIONS,
  buildNotifyEnabled,
  buildNotifyIntervalSec,
  buildNotifyPermissionDenied,
  buildScopeMissingCount,
  buildWatchRepoCount,
  buildWatchTruncated,
  requestBuildNotificationPermission,
} from '../../composables/useCnbBuildWatch'

const { t } = useI18n()

/**
 * 当前登录账号展示名（昵称优先，兜底用户名）。
 * 为什么三级兜底：CNB 允许昵称为空（GET /user 返回空串），也允许"有令牌但
 * 用户信息尚未恢复"的中间态（restoreSession 是后台进行的）。任何一级缺失
 * 都要有可见文案，不能让这一栏变成空白。
 */
const displayName = computed(() => {
  const user = cnbUser.value
  return user?.nickname || user?.username || t('menu.notLoggedIn')
})

/**
 * 头像地址（缺失时按 CNB 默认头像规则兜底）。
 * 为什么兜底：用户没在 CNB 设置自定义头像时 avatar 是空串，但 cnb.cool
 * 网站仍按 /users/{username}/avatar/s 展示默认头像；不兜底会出现"网站有头像、
 * 应用里是空白"的观感缺陷。
 */
const avatar = computed(() => cnbUser.value?.avatar || (cnbUser.value?.username ? cnbAvatarUrl(cnbUser.value.username) : ''))

/**
 * 当前组织（侧边栏 GroupsMenu 选中态；未选中给占位文案）。
 * selectedGroup 不持久化（每次启动默认组织列表第一项），因此启动早期可能
 * 为 null —— 这里必须给占位文案，且构建通知卡片的"跟随组织"文案会随之
 * 显示占位值，避免出现 "关注 个仓库" 这类缺字句子。
 */
const groupName = computed(() => selectedGroup.value?.name || selectedGroup.value?.path || t('settings.general.noGroup'))

/**
 * 在系统浏览器打开链接（非 Tauri 环境兜底 window.open）。
 *
 * 为什么必须分环境：Tauri Webview 会拦截 target="_blank" 的新窗口请求，
 * 且 cnb.cool 站点会因 origin 为 tauri://localhost 而拒绝嵌入，因此 Tauri
 * 环境下必须交给系统浏览器（opener 插件）；而 `pnpm dev` 直接开浏览器调试时
 * 没有 __TAURI_INTERNALS__，仍用 window.open，保证两种运行方式下外链都能打开。
 */
function openExternal(url: string) {
  if ('__TAURI_INTERNALS__' in window) {
    void openUrl(url)
  }
  else {
    window.open(url, '_blank')
  }
}

// ---------------------------------------------------------------------------
// 构建通知设置
//
// 本节只负责"开关 + 间隔"两个用户可调项，以及三个只读提示（缺权限仓库数、
// 系统通知权限、当前关注仓库数）。所有轮询逻辑、快照、通知投递都在
// useCnbBuildWatch 里，本页不持有任何轮询状态 —— 避免"设置页关掉开关后
// 页面自己还留着一份旧状态"的双份真相问题。
// ---------------------------------------------------------------------------

/**
 * 间隔下拉选项（30 / 60 / 120 秒）。
 *
 * 为什么只给三档而不是自由输入：一次 tick 的成本随仓库数线性增长
 * （每仓库一次 pending 查询 + 结束时的 sn 回查），CNB 网关对突发请求有
 * 风控（403）。三档是"够及时 / 默认 / 够省"的折中，避免用户填 5 秒把
 * 自己和网关都拖垮。选项值来自 BUILD_NOTIFY_INTERVAL_OPTIONS，与轮询侧的
 * 校验共用同一份常量，避免设置页能选出轮询侧不认的值（选了也会被
 * normalizeIntervalSec 静默回落到 60，用户会以为设置没生效）。
 */
const intervalItems = computed<{ label: string, value: number }[]>(() =>
  BUILD_NOTIFY_INTERVAL_OPTIONS.map(sec => ({
    label: t('buildWatch.settings.intervalSec', { sec }),
    value: sec,
  })),
)

/**
 * 间隔的双向绑定。
 * useStorage 存的是 number，而 USelect 的 modelValue 可能是 string，
 * 这里统一在 setter 里转 number，保证落盘类型稳定（避免 '60' 与 60 混用
 * 导致 normalizeIntervalSec 里的 includes() 判断失败、静默回落默认值）。
 * getter 里再兜一层：落盘值若被旧版本/手改污染成非法值，界面显示 60
 * 而不是空白，让"当前实际生效的间隔"始终可见。
 */
const intervalModel = computed<number>({
  get: () => {
    const current = buildNotifyIntervalSec.value
    return (BUILD_NOTIFY_INTERVAL_OPTIONS as readonly number[]).includes(current) ? current : 60
  },
  set: (value: number) => {
    buildNotifyIntervalSec.value = Number(value)
  },
})

/**
 * 用户主动打开开关时申请一次系统通知权限。
 *
 * 为什么放在这里而不是启动时：启动就弹权限框会打扰还没决定要用这个功能的用户，
 * 而"用户刚刚打开开关"是申请权限的最佳时机（意图明确）。
 * 为什么只 watch `enabled === true`：关闭开关时不该有任何副作用（权限属于
 * 系统级设置，应用无权也无法在关闭时撤销它）；重新打开时会再走一次本函数，
 * 而 useCnbBuildWatch 内部有会话级去重，不会重复弹框。
 */
watch(buildNotifyEnabled, (enabled) => {
  if (enabled) {
    void requestBuildNotificationPermission()
  }
})

/**
 * 开关直接 v-model 到共享 ref（useStorage）而不是先存本地再 watch 回写。
 *
 * 理由：轮询侧的 watch 监听的就是同一个 ref，任何"本地暂存 + 手动提交"的
 * 中间层都会引入一份可能不同步的状态（用户改了开关但忘记点保存 → 界面显示
 * 开启、实际没跑）。直接双向绑定让"用户操作即刻生效"，与"应用需保持运行"
 * 的产品心智一致。
 *
 * 为什么不提供"发送测试通知"按钮：系统通知权限只在真有内容时申请（见
 * useCnbBuildWatch 的口径说明），加一个测试按钮会诱导用户在没授权的情况
 * 下反复点击，反而制造"点了没反应"的误判；构建通知本身就是最好的自检。
 */

/**
 * 本页卡片顺序（模板中自上而下）与理由：
 * 1. 页面标题（UPageCard naked）；
 * 2. 登录账号 —— 用户最先确认"我现在是谁"；
 * 3. 当前组织 —— 决定构建通知关注范围的输入；
 * 4. 构建通知 —— 本版本主功能，紧跟其依赖项（组织）；
 * 5. 访问令牌 —— 低频的危险操作（换令牌需重新登录），放最后避免误点。
 * 新增卡片时请插在合适语义位置，不要一律追加到末尾。
 */

/**
 * 维护提示（改这个页面时请先读）：
 * - 间隔下拉在开关关闭时置灰（:disabled）：改间隔不会立刻生效（轮询已停），
 *   让用户以为"改了但没用"；置灰比静默接受更诚实。
 * - 所有新增文案必须走 i18n（zh-CN / zh-TW / en 三语键集合必须一致），
 *   文案键统一挂在 `buildWatch.settings.*` 下，便于按功能整体迁移。
 * - 本页不要引入网络请求：任何需要远端数据的展示都应先在 useCnbBuildWatch
 *   里变成响应式只读值再暴露，避免设置页打开时多打一次 API（网关有风控）。
 */
</script>

<template>
  <div class="flex flex-col gap-6">
    <UPageCard
      :title="t('settings.general.title')"
      :description="t('settings.general.desc')"
      variant="naked"
    />

    <!-- 登录账号（只读摘要 + 编辑入口跳应用内 /profile） -->
    <UPageCard variant="subtle">
      <div class="flex items-center gap-4 flex-wrap">
        <UAvatar :src="avatar" :alt="displayName" size="lg" />
        <div class="min-w-0">
          <p class="text-sm font-semibold text-highlighted">
            {{ t('settings.general.user') }}
          </p>
          <p class="text-xs text-muted truncate">
            {{ displayName }}<span v-if="cnbUser?.username" class="text-dimmed">@{{ cnbUser.username }}</span>
          </p>
          <p class="text-xs text-dimmed mt-0.5">
            {{ t('settings.general.userDesc') }}
          </p>
        </div>
        <UButton
          class="ms-auto"
          size="sm"
          color="neutral"
          variant="outline"
          icon="i-lucide-user-pen"
          :label="t('settings.general.editProfile')"
          to="/profile"
        />
      </div>
    </UPageCard>

    <!-- 当前组织（只读摘要） -->
    <UPageCard variant="subtle">
      <div class="flex items-center gap-4 flex-wrap">
        <UAvatar
          v-if="selectedGroup"
          :src="cnbGroupLogoUrl(selectedGroup.path)"
          :alt="groupName"
          size="lg"
        />
        <UIcon v-else name="i-lucide-building-2" class="size-8 text-dimmed" />
        <div class="min-w-0">
          <p class="text-sm font-semibold text-highlighted">
            {{ t('settings.general.group') }}
          </p>
          <p class="text-xs text-muted truncate">
            {{ groupName }}
          </p>
          <p class="text-xs text-dimmed mt-0.5">
            {{ t('settings.general.groupDesc') }}
          </p>
        </div>
      </div>
    </UPageCard>

    <!-- 构建通知（本版本主功能：轮询构建状态 → 系统通知 + 应用内通知面板） -->
    <!--
      合并阈值口径（为什么本页不暴露"通知合并阈值"）：
      一次 tick 里结束的构建 ≤5 条时逐条通知，>5 条时合并成一条摘要
      （成功 x / 失败 y / 取消 z，未知数另附一句）。这个 5 是产品口径、
      写在 useCnbBuildWatch 的 summarizeNotifications 默认参数里，属于
      "防通知轰炸"的保护而不是用户偏好，故不提供设置项，避免用户把
      阈值调到 50 之后被弹窗淹没又回头报"通知太多"。
    -->
    <UPageCard
      variant="subtle"
      :title="t('buildWatch.settings.title')"
      :description="t('buildWatch.settings.desc')"
    >
      <div class="flex flex-col gap-4">
        <!-- 开关 -->
        <div class="flex items-center gap-4 flex-wrap">
          <div class="min-w-0 flex-1">
            <p class="text-sm font-semibold text-highlighted">
              {{ t('buildWatch.settings.enable') }}
            </p>
            <p class="text-xs text-dimmed mt-0.5">
              {{ t('buildWatch.settings.enableDesc') }}
            </p>
          </div>
          <USwitch v-model="buildNotifyEnabled" />
        </div>

        <USeparator />

        <!-- 轮询间隔 -->
        <div class="flex items-center gap-4 flex-wrap">
          <div class="min-w-0 flex-1">
            <p class="text-sm font-semibold text-highlighted">
              {{ t('buildWatch.settings.interval') }}
            </p>
            <p class="text-xs text-dimmed mt-0.5">
              {{ t('buildWatch.settings.intervalDesc') }}
            </p>
          </div>
          <USelect
            v-model="intervalModel"
            :items="intervalItems"
            :disabled="!buildNotifyEnabled"
            class="w-32"
          />
        </div>

        <!-- 说明：跟随侧边栏选中组织 + 应用需保持运行 -->
        <p class="text-xs text-muted">
          {{ t('buildWatch.settings.followGroup', { group: groupName }) }}
        </p>
        <p class="text-xs text-muted">
          {{ t('buildWatch.settings.keepRunning') }}
        </p>
        <!--
          当前关注仓库数口径：只算"真的在轮询"的仓库 —— useCnbBuildWatch
          已经把缺权限被跳过的仓库从计数里减掉，所以这个数字小于组织仓库总数
          时是正常的（差额见下面的缺权限警示条），不代表漏关注。
          截断提示仅在接口确认"还有第 101 个仓库"时出现（见 loadRepoList），
          不会因为恰好 100 个仓库就误报。
        -->
        <p v-if="buildNotifyEnabled && buildWatchRepoCount > 0" class="text-xs text-dimmed">
          {{ t('buildWatch.settings.watching', { count: buildWatchRepoCount }) }}
          <span v-if="buildWatchTruncated">· {{ t('buildWatch.settings.truncated', { max: 100 }) }}</span>
        </p>

        <!--
          缺权限警示（scopeMissing 展示口径）：
          这里的数字是"本次会话内因 403 被跳过的仓库数"，只反映轮询侧观察到的
          事实，**不代表登录态有问题** —— 403（令牌少了 repo-cnb-history:r）
          按项目红线绝不登出，因此这只是一条"少看几个仓库"的降级提示。
          计数在切换组织 / 重新登录 / 重启应用后归零重算，所以它可能小于
          实际的缺权限仓库总数（尚未被轮询触达的那些还没计进来）。
        -->
        <div
          v-if="buildScopeMissingCount > 0"
          class="flex items-center gap-3 rounded-md bg-warning/10 p-3 flex-wrap"
        >
          <UIcon name="i-lucide-shield-alert" class="size-5 shrink-0 text-warning" />
          <p class="min-w-0 flex-1 text-xs text-muted">
            {{ t('buildWatch.settings.scopeMissing', { count: buildScopeMissingCount }) }}
          </p>
          <UButton
            size="xs"
            color="warning"
            variant="subtle"
            icon="i-lucide-key-round"
            :label="t('state.manageToken')"
            @click="openExternal(CNB_TOKEN_MANAGE_URL)"
          />
        </div>

        <!--
          系统通知权限被拒提示。
          为什么只给文字指引、不做"打开系统设置"按钮：macOS 没有公开的 API
          能让第三方应用直接跳到「设置 → 通知 → 本应用」那一页
          （x-apple.systempreferences 的深链在近几版系统上已不可靠），
          放一个点了没反应的按钮比给一句准确路径更糟。
          另外这不是"功能坏了"：应用内通知面板仍然照常工作，所以用中性色
          而不是警示色，避免用户以为整个功能失效。
        -->
        <div
          v-if="buildNotifyPermissionDenied"
          class="flex items-center gap-3 rounded-md bg-elevated/60 p-3 flex-wrap"
        >
          <UIcon name="i-lucide-bell-off" class="size-5 shrink-0 text-muted" />
          <p class="min-w-0 flex-1 text-xs text-muted">
            {{ t('buildWatch.settings.permissionDenied') }}
          </p>
        </div>
      </div>
    </UPageCard>

    <!-- CNB 令牌管理外跳（本应用不提供应用内替换令牌） -->
    <UPageCard
      variant="subtle"
      :title="t('settings.general.tokenManage')"
      :description="t('settings.token.desc')"
    >
      <template #footer>
        <UButton
          size="sm"
          color="neutral"
          variant="outline"
          icon="i-lucide-key-round"
          :label="t('settings.token.manage')"
          @click="openExternal(CNB_TOKEN_MANAGE_URL)"
        />
      </template>
    </UPageCard>
  </div>
</template>
