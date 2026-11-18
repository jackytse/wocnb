<script setup lang="ts">
/**
 * 分支 / 标签选择器（代码、提交页签共用；REQ-01 扩展为分支管理中心）。
 *
 * 交互：按钮显示当前 ref；点开 UPopover 懒加载分支与标签两个列表
 * （首次打开才发请求，之后驻留），支持本地过滤；选中写回 ?ref= 并
 * 清空 path/sha（useRepoRoute.switchRef，内容源已变旧定位失效）。
 *
 * REQ-01 增量（canManage 时显示写入口，事前预判不事后报错）：
 * - 底部「+ 新建分支」→ CreateBranchModal → 成功后重拉并 switchRef 自动切过去；
 * - 每个分支行的锁/解锁与删除图标：锁状态**直接复用列表项的 locked 字段**
 *   （fetchRepoBranches 已归一化，避免为每行调详情端点造成 N+1）；
 * - 删除走 ConfirmDialog（error 色）；受保护分支服务端 400/403 以 error toast
 *   呈现，**不静默吞、不登出**；删除当前 ref 时自动切到剩余首个分支。
 *
 * selectMode='emit' 时仅 emit('update:modelValue')，不写 ?ref=（模态框内选
 * head/base/target 用，避免误清下钻键）。
 */
import { computed, ref as vueRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  fetchRepoBranches,
  fetchRepoTags,
  type BranchItem,
  type TagItem,
} from '../../composables/useCnbRepo'
import {
  deleteBranch,
  lockBranch,
  unlockBranch,
} from '../../composables/useCnbGitRefs'
import { useRepoRoute } from '../../composables/useRepoRoute'
import CreateBranchModal from './CreateBranchModal.vue'
import ConfirmDialog from '../common/ConfirmDialog.vue'

const props = defineProps<{
  /** 仓库完整路径 */
  repoPath: string
  /** 当前生效 ref（route 的 ?ref= 或默认分支名） */
  modelValue: string
  /**
   * 选中行为（T11 扩展，向后兼容）：
   * - 'route'（默认）：写回 ?ref=（useRepoRoute.switchRef），代码/提交页签语义；
   * - 'emit'：仅 emit('update:modelValue')，不做路由写入 —— 提交比较的
   *   base/head 是本地选择态，写 ?ref= 会误清 path/sha 下钻键。
   */
  selectMode?: 'route' | 'emit'
  /**
   * 是否可管理（Master/Owner，由仓库详情 canManage 单点预判传入）。
   * false 时新建/删除/锁写入口全部隐藏 —— 权限预判前置，不靠 403 兜底。
   */
  canManage?: boolean
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
}>()

const { t } = useI18n()
const toast = useToast()
const { switchRef } = useRepoRoute()

const open = vueRef(false)
/** 本地过滤词（客户端过滤，分支/标签通常几十个，无需服务端搜索） */
const filter = vueRef('')

/** 分支/标签列表与加载状态 */
const branches = vueRef<BranchItem[]>([])
const tags = vueRef<TagItem[]>([])
const loading = vueRef(false)
const loadError = vueRef(false)
/** 是否已完成首次加载（懒加载只发生一次；写后手动重置可重拉） */
const loadedOnce = vueRef(false)

/** 拉取分支与标签（并行，单失败降级为对应列表为空）；force=true 忽略缓存 */
async function loadRefs(force = false) {
  if ((loadedOnce.value && !force) || !props.repoPath) {
    return
  }
  loading.value = true
  loadError.value = false
  try {
    const [b, tg] = await Promise.allSettled([
      fetchRepoBranches(props.repoPath),
      fetchRepoTags(props.repoPath),
    ])
    branches.value = b.status === 'fulfilled' ? b.value : []
    tags.value = tg.status === 'fulfilled' ? tg.value : []
    loadError.value = b.status === 'rejected' && tg.status === 'rejected'
    loadedOnce.value = true
  }
  finally {
    loading.value = false
  }
}

// 抽屉打开时懒加载（避免挂载即请求）
watch(open, (value) => {
  if (value) {
    void loadRefs()
  }
})

/** 过滤后的分支/标签列表 */
const filteredBranches = computed(() =>
  branches.value.filter(b => b.name.toLowerCase().includes(filter.value.toLowerCase())),
)
const filteredTags = computed(() =>
  tags.value.filter(tg => tg.name.toLowerCase().includes(filter.value.toLowerCase())),
)

/** 选中：route 模式写回 ?ref=（replace 且清空 path/sha）；emit 模式仅向上传递 */
function select(name: string) {
  open.value = false
  if (props.selectMode === 'emit') {
    emit('update:modelValue', name)
  }
  else {
    switchRef(name)
  }
}

// ---------------------------------------------------------------------------
// 分支管理（新建 / 删除 / 锁定，T04）
// ---------------------------------------------------------------------------

/** 新建分支弹窗开关 */
const createOpen = vueRef(false)
/** 已有分支/标签名（重名校验用，含当前 ref） */
const allRefNames = computed(() => [
  ...branches.value.map(b => b.name),
  ...tags.value.map(tg => tg.name),
])

/** 新建成功：重拉列表（force）后自动切到新分支（emit 模式仅向上传递） */
async function onBranchCreated(name: string) {
  await loadRefs(true)
  select(name)
}

/** 删除确认状态 */
const deleteTarget = vueRef('')
const deleteOpen = vueRef(false)
const deleting = vueRef(false)

function confirmDeleteBranch(branch: BranchItem) {
  // 当前分支 / 受保护分支前端置灰，理论上不会走到这里；双重保险
  if (branch.name === props.modelValue || branch.protected) {
    return
  }
  deleteTarget.value = branch.name
  deleteOpen.value = true
}

/** 删除分支：成功后本地移除；若删的是当前 ref 则切到剩余首个分支 */
async function doDeleteBranch() {
  const name = deleteTarget.value
  if (!name || deleting.value) {
    return
  }
  deleting.value = true
  try {
    await deleteBranch(props.repoPath, name)
    branches.value = branches.value.filter(b => b.name !== name)
    tags.value = tags.value.filter(tg => tg.name !== name)
    toast.add({ title: t('repo.branches.deleteSuccess'), color: 'success', duration: 2500 })
    deleteOpen.value = false
    if (name === props.modelValue) {
      const fallback = branches.value[0]?.name
      if (fallback) {
        select(fallback)
      }
    }
  }
  catch (err) {
    // 受保护分支服务端 400/403 → error toast，绝不静默吞、不登出
    toast.add({
      title: t('repo.branches.deleteFailed'),
      description: (err as Error)?.message || '',
      color: 'error',
      duration: 6000,
    })
  }
  finally {
    deleting.value = false
  }
}

/** 锁/解锁：成功后**原地更新 locked 字段**（接口列表已带该字段，不整表重拉） */
async function toggleLock(branch: BranchItem) {
  try {
    if (branch.locked) {
      await unlockBranch(props.repoPath, branch.name)
    }
    else {
      await lockBranch(props.repoPath, branch.name)
    }
    branch.locked = !branch.locked
    toast.add({
      title: branch.locked ? t('repo.branches.lockSuccess') : t('repo.branches.unlockSuccess'),
      color: 'success',
      duration: 2000,
    })
  }
  catch (err) {
    toast.add({
      title: branch.locked ? t('repo.branches.unlockFailed') : t('repo.branches.lockFailed'),
      description: (err as Error)?.message || '',
      color: 'error',
      duration: 6000,
    })
  }
}
</script>

<template>
  <UPopover v-model:open="open" :content="{ align: 'start' }">
    <UButton
      size="sm"
      color="neutral"
      variant="outline"
      icon="i-lucide-git-branch"
      :label="modelValue || t('repo.branch.select')"
      trailing-icon="i-lucide-chevrons-up-down"
      class="max-w-64"
    />

    <template #content>
      <div class="w-80 p-2 flex flex-col gap-2">
        <UInput
          v-model="filter"
          size="sm"
          variant="soft"
          icon="i-lucide-search"
          :placeholder="t('repo.branch.searchPlaceholder')"
        />

        <!-- 加载中骨架 -->
        <div v-if="loading" class="flex flex-col gap-1.5 py-1">
          <USkeleton v-for="i in 4" :key="i" class="h-7 w-full rounded-md" />
        </div>

        <!-- 两个列表都失败：错误提示（403 由全局 toast/StateAlert 呈现，此处不登出） -->
        <UAlert
          v-else-if="loadError"
          icon="i-lucide-cloud-alert"
          color="error"
          variant="soft"
          :title="t('state.error')"
          :description="t('state.errorDesc')"
        />

        <template v-else>
          <!-- 分支组 -->
          <p class="text-xs font-medium text-dimmed px-1 pt-1">
            {{ t('repo.branch.branches') }}
          </p>
          <p v-if="filteredBranches.length === 0" class="text-xs text-dimmed px-1 py-1">
            {{ t('repo.branch.empty') }}
          </p>
          <div
            v-for="branch in filteredBranches"
            :key="branch.name"
            class="flex items-center gap-1 w-full px-2 py-1.5 rounded-md hover:bg-elevated/60 text-sm"
          >
            <button
              type="button"
              class="flex items-center gap-2 min-w-0 flex-1 text-left cursor-pointer"
              @click="select(branch.name)"
            >
              <UIcon name="i-lucide-git-branch" class="size-3.5 text-muted shrink-0" />
              <span class="truncate" :class="branch.name === modelValue ? 'text-primary font-medium' : ''">
                {{ branch.name }}
              </span>
              <UIcon
                v-if="branch.protected"
                name="i-lucide-shield"
                class="size-3.5 text-dimmed shrink-0"
              />
            </button>
            <!-- 锁/解锁 + 删除：canManage 且当前分支不可删除 -->
            <template v-if="canManage">
              <UTooltip :text="branch.locked ? t('repo.branches.unlock') : t('repo.branches.lock')">
                <button
                  type="button"
                  class="p-1 rounded hover:bg-elevated cursor-pointer shrink-0"
                  @click.stop="toggleLock(branch)"
                >
                  <UIcon
                    :name="branch.locked ? 'i-lucide-lock' : 'i-lucide-lock-open'"
                    class="size-3.5 text-muted"
                  />
                </button>
              </UTooltip>
              <UTooltip :text="branch.name === modelValue ? t('repo.branches.currentNoDelete') : t('repo.branches.delete')">
                <button
                  type="button"
                  class="p-1 rounded hover:bg-elevated cursor-pointer shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
                  :disabled="branch.name === modelValue || branch.protected"
                  @click.stop="confirmDeleteBranch(branch)"
                >
                  <UIcon name="i-lucide-trash-2" class="size-3.5 text-muted" />
                </button>
              </UTooltip>
            </template>
          </div>

          <!-- 标签组 -->
          <template v-if="filteredTags.length > 0">
            <p class="text-xs font-medium text-dimmed px-1 pt-2">
              {{ t('repo.branch.tags') }}
            </p>
            <button
              v-for="tag in filteredTags"
              :key="`tag-${tag.name}`"
              type="button"
              class="flex items-center gap-2 w-full text-left px-2 py-1.5 rounded-md hover:bg-elevated/60 text-sm cursor-pointer"
              @click="select(tag.name)"
            >
              <UIcon name="i-lucide-tag" class="size-3.5 text-muted shrink-0" />
              <span class="truncate" :class="tag.name === modelValue ? 'text-primary font-medium' : ''">
                {{ tag.name }}
              </span>
            </button>
          </template>

          <!-- 新建分支入口：canManage 时显示（事前预判） -->
          <button
            v-if="canManage"
            type="button"
            class="flex items-center gap-2 w-full text-left px-2 py-2 mt-1 border-t border-default text-sm text-primary hover:bg-elevated/60 cursor-pointer rounded-md"
            @click="createOpen = true"
          >
            <UIcon name="i-lucide-plus" class="size-3.5 shrink-0" />
            {{ t('repo.branches.create') }}
          </button>
        </template>
      </div>
    </template>
  </UPopover>

  <!-- 新建分支弹窗 -->
  <CreateBranchModal
    v-model:open="createOpen"
    :repo-path="repoPath"
    :default-ref="modelValue"
    :refs="allRefNames"
    @created="onBranchCreated"
  />

  <!-- 删除分支二次确认（danger） -->
  <ConfirmDialog
    v-model:open="deleteOpen"
    :title="t('repo.branches.delete')"
    :desc="t('repo.branches.deleteConfirm', { branch: deleteTarget })"
    :confirm-label="t('repo.branches.delete')"
    confirm-color="error"
    :loading="deleting"
    @confirm="doDeleteBranch"
  />
</template>
