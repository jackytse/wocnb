<script setup lang="ts">
/**
 * Release 表单弹窗（新建 / 编辑复用，T07）。
 *
 * 字段映射（swagger 核对）：
 * - 新建（POST /{repo}/-/releases，openapi.PostReleaseForm）：tag_name 必填 +
 *   target_commitish（分支/SHA）+ name + body + draft + prerelease + make_latest；
 * - 编辑（PATCH /{repo}/-/releases/{id}，openapi.PatchReleaseForm）：**仅支持
 *   name / body / draft / prerelease / make_latest** —— tag 与提交绑定后不可
 *   迁移，编辑模式隐藏 tag / target 字段。
 *
 * 校验：tag 必填且格式 ^[A-Za-z0-9._/-]+$（创建模式）；失败 422/400 时
 * 透出服务端 message 并保留输入（不关弹窗）。
 */
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  createRelease,
  updateRelease,
  type CreateReleaseInput,
  type ReleaseItem,
} from '../../composables/useCnbReleases'

const props = defineProps<{
  /** 弹窗开关（v-model:open） */
  open: boolean
  repoPath: string
  /** 编辑模式：传入目标 Release（tag/target 只读不可改） */
  release?: ReleaseItem | null
  /** 归档仓库：提交禁用 */
  disabled?: boolean
}>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  /** 创建成功（携带完整 ReleaseItem；编辑成功不 emit 此事件） */
  (e: 'created', item: ReleaseItem): void
  /** 编辑成功（父页重拉详情与列表） */
  (e: 'saved'): void
}>()

const { t } = useI18n()
const toast = useToast()

const isEdit = computed(() => !!props.release?.id)

const openModel = computed({
  get: () => props.open,
  set: (value: boolean) => emit('update:open', value),
})

// ---------------------------------------------------------------------------
// 表单状态
// ---------------------------------------------------------------------------

const form = reactive({
  tagName: '',
  targetCommitish: '',
  name: '',
  body: '',
  draft: false,
  prerelease: false,
  /** make_latest 是 swagger 字符串枚举（true/false/legacy），非布尔 */
  makeLatest: 'true' as 'true' | 'false' | 'legacy',
})
const submitting = ref(false)
const tagError = ref('')

const makeLatestItems = computed(() => [
  { label: t('repo.releases.makeLatestTrue'), value: 'true' },
  { label: t('repo.releases.makeLatestFalse'), value: 'false' },
  { label: t('repo.releases.makeLatestLegacy'), value: 'legacy' },
])

/** CNB tag 命名：字母/数字/下划线/点/连字符/斜杠（设计文档 §6.2 校验规则） */
const TAG_PATTERN = /^[A-Za-z0-9._/-]+$/

// 打开时回填（编辑模式用 release 值；新建模式重置）
watch(() => props.open, (value) => {
  if (!value) {
    return
  }
  tagError.value = ''
  if (props.release) {
    form.tagName = props.release.tagName
    form.targetCommitish = props.release.tagCommitish
    form.name = props.release.name
    form.body = props.release.body
    form.draft = props.release.isDraft
    form.prerelease = props.release.isPrerelease
    form.makeLatest = 'false'
  }
  else {
    form.tagName = ''
    form.targetCommitish = ''
    form.name = ''
    form.body = ''
    form.draft = false
    form.prerelease = false
    form.makeLatest = 'true'
  }
})

/** tag 校验：必填 + 命名规则（仅创建模式校验，编辑模式 tag 只读） */
function validateTag(): boolean {
  if (isEdit.value) {
    return true
  }
  const tag = form.tagName.trim()
  if (!tag) {
    tagError.value = t('repo.releases.tagRequired')
    return false
  }
  if (!TAG_PATTERN.test(tag)) {
    tagError.value = t('repo.releases.tagInvalid')
    return false
  }
  tagError.value = ''
  return true
}

/** 提交（创建或编辑） */
async function onSubmit() {
  if (!props.repoPath || submitting.value || props.disabled) {
    return
  }
  if (!validateTag()) {
    return
  }
  submitting.value = true
  try {
    if (isEdit.value && props.release) {
      // 编辑：仅提交 PatchReleaseForm 支持的字段（tag/target 不可迁移）
      await updateRelease(props.repoPath, props.release.id, {
        name: form.name.trim(),
        body: form.body,
        draft: form.draft,
        prerelease: form.prerelease,
        // make_latest 编辑模式下固定 false —— "最新版"应由服务端按时间序
        // 维护，手动改绑最新版属危险操作，UI 不提供
        makeLatest: form.makeLatest,
      })
      toast.add({ title: t('repo.releases.saveSuccess'), color: 'success', duration: 2500 })
      emit('update:open', false)
      emit('saved')
    }
    else {
      // 创建：完整 PostReleaseForm
      const input: CreateReleaseInput = {
        tagName: form.tagName.trim(),
        name: form.name.trim() || undefined,
        body: form.body || undefined,
        draft: form.draft,
        prerelease: form.prerelease,
        targetCommitish: form.targetCommitish.trim() || undefined,
        makeLatest: form.makeLatest,
      }
      const item = await createRelease(props.repoPath, input)
      toast.add({
        title: t('repo.releases.createSuccess'),
        description: item.tagName,
        color: 'success',
        duration: 3000,
      })
      emit('update:open', false)
      emit('created', item)
    }
  }
  catch (err) {
    // 422/400（tag 已存在 / target 非法）/ 403（缺 repo-release:rw）：
    // 透出服务端 message，保留弹窗与输入（不关不表单清空）
    toast.add({
      title: isEdit.value ? t('repo.releases.saveFailed') : t('repo.releases.createFailed'),
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
    :title="isEdit ? t('repo.releases.edit') : t('repo.releases.create')"
    :ui="{ content: 'max-w-xl' }"
  >
    <template #body>
      <div class="flex flex-col gap-4">
        <!-- tag 名（仅新建可填；编辑模式 tag 与提交绑定不可迁移，只读展示） -->
        <UFormField
          :label="t('repo.releases.tagName')"
          required
          :error="tagError || undefined"
        >
          <UInput
            v-if="!isEdit"
            v-model="form.tagName"
            class="w-full"
            :placeholder="t('repo.releases.tagNamePlaceholder')"
            @blur="form.tagName && validateTag()"
          />
          <!-- 编辑模式：只读展示（tag 不可改） -->
          <div v-else class="flex items-center gap-2 text-sm text-muted">
            <UBadge
              color="neutral"
              variant="subtle"
              :label="form.tagName"
              class="font-mono"
            />
            <span class="text-xs text-dimmed">{{ t('repo.releases.tagLocked') }}</span>
          </div>
        </UFormField>

        <!-- 目标分支/SHA（仅新建可选填） -->
        <UFormField v-if="!isEdit" :label="t('repo.releases.targetCommitish')">
          <UInput
            v-model="form.targetCommitish"
            class="w-full"
            :placeholder="t('repo.releases.targetPlaceholder')"
          />
        </UFormField>

        <!-- 标题（选填，缺省服务端用 tag 名） -->
        <UFormField :label="t('repo.releases.name')">
          <UInput
            v-model="form.name"
            class="w-full"
            :placeholder="t('repo.releases.namePlaceholder')"
          />
        </UFormField>

        <!-- 描述（Markdown，复用 issue 评论的多行域形态） -->
        <UFormField :label="t('repo.releases.body')">
          <UTextarea
            v-model="form.body"
            class="w-full"
            :rows="6"
            autoresize
            :placeholder="t('repo.releases.bodyPlaceholder')"
          />
        </UFormField>

        <!-- draft / prerelease 开关 -->
        <div class="flex items-center gap-6">
          <USwitch v-model="form.draft" :label="t('repo.releases.draft')" />
          <USwitch v-model="form.prerelease" :label="t('repo.releases.prerelease')" />
        </div>

        <!-- make_latest（仅新建可选；编辑模式固定 false 不展示） -->
        <UFormField v-if="!isEdit" :label="t('repo.releases.makeLatest')">
          <USelect
            v-model="form.makeLatest"
            class="w-48"
            :items="makeLatestItems"
            value-key="value"
          />
        </UFormField>
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
          :loading="submitting"
          :disabled="disabled"
          :label="isEdit ? t('common.save') : t('repo.releases.create')"
          @click="onSubmit"
        />
      </div>
    </template>
  </UModal>
</template>
