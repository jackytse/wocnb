<script setup lang="ts">
/**
 * 退出登录二次确认弹窗（全局唯一实例，挂在 App.vue 根部）。
 *
 * 为什么抽成全局组件：退出登录入口不止用户菜单一处 —— 托盘右键菜单的
 * 「退出登录」也会触发（Rust emit cnb://tray-logout → main.ts 调
 * openLogoutConfirm()）。UserMenu 的下拉菜单不是常驻挂载的，弹窗必须
 * 挂在应用根部常驻渲染，两个入口才能共用同一份状态（useLogoutConfirm
 * 模块级单例）。
 *
 * 交互与原 UserMenu 内嵌版本一致：
 * - 「取消」仅关闭弹窗；
 * - 「退出登录」先关弹窗再执行 confirmLogout（清凭证 → toast → 回登录页）；
 * - 勾选「清空本地通知数据」默认不勾选（登出默认保留 SQLite 通知，
 *   同一账号下次登录仍可见），用户显式勾选才物理删除当前账号的通知。
 */
import { useLogoutConfirm } from '../composables/useLogoutConfirm'

const { logoutConfirmOpen, logoutClearData, logoutBusy, confirmLogout } = useLogoutConfirm()
</script>

<template>
  <!-- max-w-sm：与原 UserMenu 内嵌版本一致的小尺寸确认弹窗 -->
  <UModal v-model:open="logoutConfirmOpen" :ui="{ content: 'max-w-sm' }">
    <template #content>
      <div class="p-6">
        <h2 class="text-base font-semibold text-highlighted leading-6">
          {{ $t('menu.logoutConfirmTitle') }}
        </h2>
        <p class="mt-2 text-sm text-muted">
          {{ $t('menu.logoutConfirmDesc') }}
        </p>
        <!-- 清空数据勾选（每次打开重置为不勾选）：勾选后 confirmLogout 会先删库再登出 -->
        <UCheckbox
          v-model="logoutClearData"
          class="mt-3"
          :label="$t('menu.logoutClearData')"
        />
        <div class="mt-6 flex justify-end gap-2">
          <UButton
            size="sm"
            color="neutral"
            variant="ghost"
            :label="$t('common.cancel')"
            :disabled="logoutBusy"
            @click="logoutConfirmOpen = false"
          />
          <!-- 退出中置 loading 并禁用：登出含网络/删库动作，防双击重复执行 -->
          <UButton
            size="sm"
            color="error"
            icon="i-lucide-log-out"
            :label="$t('menu.logout')"
            :loading="logoutBusy"
            @click="logoutConfirmOpen = false; void confirmLogout()"
          />
        </div>
      </div>
    </template>
  </UModal>
</template>
