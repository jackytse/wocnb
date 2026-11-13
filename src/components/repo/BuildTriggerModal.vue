<script setup lang="ts">
/**
 * 触发构建弹窗（设计文档 §4.1 / T04）。
 *
 * 交互：分支下拉（fetchRepoBranches 懒加载，打开弹窗时才请求）+ 可选构建
 * 标题 → 提交。请求体语义由数据层 triggerBuild 固定（event='api_trigger'、
 * sync='false' 字符串），本组件不拼装请求体。
 *
 * ⚠️ HTTP 200 + success=false 是合法组合（分支不存在等，dto.BuildResult）：
 * 必须判 result.success，false 时 toast 透出服务端 message 并保留弹窗，
 * 绝不当作成功关闭。
 *
 * 设计文档建议复用 RepoBranchSelect，但该组件选中即写路由 query（switchRef），
 * 与弹窗内"暂存选择"语义冲突 —— 因此用 USelect 承载分支选择（偏差已记录）。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { fetchRepoBranches, triggerBuild, type BranchItem } from '../../composables/useCnbRepo'

const props = defineProps<{
  /** 弹窗开关（v-model:open） */
  open: boolean
  repoPath: string
  /** 归档仓库禁止触发构建（写入口禁用） */
  disabled?: boolean
}>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  /** 触发成功，携带新构建 sn（列表据此刷新并高亮） */
  (e: 'triggered', sn: string): void
}>()

const { t } = useI18n()
const toast = useToast()

const openModel = computed({
  get: () => props.open,
  set: (value: boolean) => emit('update:open', value),
})

// ---------------------------------------------------------------------------
// 分支列表（弹窗打开时懒加载）
// ---------------------------------------------------------------------------

const branches = ref<BranchItem[]>([])
const branchesLoading = ref(false)
/** 分支加载失败标记（触发仍可用 —— branch 缺省由服务端取主分支） */
const branchesError = ref(false)

async function loadBranches() {
  if (!props.repoPath || branches.value.length > 0) {
    return
  }
  branchesLoading.value = true
  branchesError.value = false
  try {
    branches.value = await fetchRepoBranches(props.repoPath)
  }
  catch {
    branches.value = []
    branchesError.value = true
  }
  finally {
    branchesLoading.value = false
  }
}

// 弹窗打开即拉分支列表
watch(() => props.open, (value) => {
  if (value) {
    void loadBranches()
  }
})

// ---------------------------------------------------------------------------
// 表单与提交
// ---------------------------------------------------------------------------

const selectedBranch = ref('')
const title = ref('')
const submitting = ref(false)

/** 分支下拉选项（value 一律非空 —— 空串会触发 Reka UI 渲染异常，见 RepoBuildList 注释） */
const branchItems = computed(() =>
  branches.value.map(b => ({ label: b.name, value: b.name })),
)

// 打开时重置表单（选首个分支为默认值）
watch(() => props.open, (value) => {
  if (value) {
    selectedBranch.value = branches.value[0]?.name || ''
    title.value = ''
  }
})

/** 提交触发：成功判定以 result.success 为准（HTTP 200 也可能失败） */
async function onSubmit() {
  if (!props.repoPath || submitting.value) {
    return
  }
  submitting.value = true
  try {
    const result = await triggerBuild(props.repoPath, {
      branch: selectedBranch.value || undefined,
      title: title.value.trim() || undefined,
    })
    // success=false（HTTP 200）：透出服务端 message，保留弹窗（T04-3 验收点）
    if (!result.success) {
      toast.add({
        title: t('builds.triggerFailed'),
        description: result.message || t('builds.triggerRejected'),
        color: 'error',
        duration: 6000,
      })
      return
    }
    toast.add({
      title: t('builds.triggered'),
      description: result.sn ? `#${result.sn}` : '',
      color: 'success',
      duration: 2500,
    })
    emit('triggered', result.sn)
    emit('update:open', false)
  }
  catch (err) {
    // 网络层 / 权限层异常（403 缺 repo-cnb-trigger:rw 等）：透出 message 不登出
    toast.add({
      title: t('builds.triggerFailed'),
      description: (err as Error)?.message || '',
      color: 'error',
      duration: 6000,
    })
  }
  finally {
    submitting.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="openModel"
    :title="t('builds.triggerTitle')"
    :ui="{ content: 'max-w-md' }"
  >
    <template #body>
      <div class="flex flex-col gap-4">
        <!-- 分支选择 -->
        <UFormField :label="t('builds.branch')" required>
          <USelect
            v-model="selectedBranch"
            class="w-full"
            :items="branchItems"
            value-key="value"
            :loading="branchesLoading"
            :disabled="branchesLoading"
            :placeholder="t('builds.branchPlaceholder')"
          />
          <!-- 分支加载失败提示：不阻断触发（branch 可缺省） -->
          <p v-if="branchesError" class="text-xs text-warning mt-1">
            {{ t('builds.branchLoadFailed') }}
          </p>
        </UFormField>

        <!-- 构建标题（可选） -->
        <UFormField :label="t('builds.buildTitle')">
          <UInput
            v-model="title"
            class="w-full"
            :placeholder="t('builds.buildTitlePlaceholder')"
          />
        </UFormField>

        <!-- 说明：请求固定 event=api_trigger（只读事实说明，帮助用户理解列表里的 event 值） -->
        <p class="text-xs text-dimmed">
          {{ t('builds.triggerHint') }}
        </p>
      </div>
    </template>

    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton
          color="neutral"
          variant="ghost"
          :label="t('common.cancel')"
          @click="emit('update:open', false)"
        />
        <UButton
          color="primary"
          icon="i-lucide-play"
          :loading="submitting"
          :disabled="disabled"
          :label="t('builds.trigger')"
          @click="onSubmit"
        />
      </div>
    </template>
  </UModal>
</template>
