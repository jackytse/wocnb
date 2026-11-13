<script setup lang="ts">
/**
 * 创建仓库弹窗（REQ-A6 / T05）。
 *
 * 端点：POST /{slug}/-/repos（dto.CreateRepoReq，scope group-resource:rw）。
 * 组织取全局共享 selectedGroup（侧边栏当前选中组织）。
 *
 * 表单：name（必填，CNB 命名规则 ^[\w.-]+$ 前端预校验）/ description（选填）/
 * visibility（public | private，swagger 枚举为**小写**，默认 public）。
 *
 * 成功（201 无响应体）后：toast → 跳转新仓库详情页（应用内可达即证明
 * 创建成功；返回 /repos 时 HomeRepos 重新挂载自动重拉列表，列表即刷新）。
 */
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { createRepo, type CreateRepoVisibility } from '../composables/useCnbRepoManage'
import { selectedGroup } from '../composables/useCnbAuth'

const props = defineProps<{
  /** 弹窗开关（v-model:open） */
  open: boolean
}>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
}>()

const { t } = useI18n()
const router = useRouter()
const toast = useToast()

const openModel = computed({
  get: () => props.open,
  set: (value: boolean) => emit('update:open', value),
})

// ---------------------------------------------------------------------------
// 表单
// ---------------------------------------------------------------------------

const form = reactive({
  name: '',
  description: '',
  // 类型层三值（CreateRepoVisibility），UI 只暴露 public/private 两项 ——
  // 已批准的产品取舍（§3.5）：服务端默认 public 比这里的 private 更"暴露"，
  // 误建成本高；secret 类型层保留，将来开放 UI 不用改断言
  visibility: 'private' as CreateRepoVisibility,
})
const submitting = ref(false)
/** name 校验错误文案（为空表示通过） */
const nameError = ref('')

/** 可见性下拉选项（value 非空 —— Reka UI SelectItem 禁止空串值） */
const visibilityItems = computed(() => [
  { label: t('repos.create.visibilityPrivate'), value: 'private' },
  { label: t('repos.create.visibilityPublic'), value: 'public' },
])

/** CNB 仓库命名规则：字母/数字/下划线/点/连字符 */
const NAME_PATTERN = /^[\w.-]+$/

/** 打开时重置表单 */
watch(() => props.open, (value) => {
  if (value) {
    form.name = ''
    form.description = ''
    form.visibility = 'private'
    nameError.value = ''
  }
})

/** name 校验：非空 + 命名规则 */
function validateName(): boolean {
  const name = form.name.trim()
  if (!name) {
    nameError.value = t('repos.create.nameRequired')
    return false
  }
  if (!NAME_PATTERN.test(name)) {
    nameError.value = t('repos.create.nameInvalid')
    return false
  }
  nameError.value = ''
  return true
}

/** 提交创建：201 无响应体，不抛错即成功 */
async function onCreate() {
  if (!validateName() || submitting.value) {
    return
  }
  const slug = selectedGroup.value?.path
  if (!slug) {
    toast.add({
      title: t('repos.create.noGroup'),
      color: 'error',
      duration: 4000,
    })
    return
  }
  submitting.value = true
  try {
    const name = form.name.trim()
    await createRepo(slug, {
      name,
      description: form.description.trim() || undefined,
      visibility: form.visibility,
    })
    toast.add({
      title: t('repos.create.created'),
      description: `${slug}/${name}`,
      color: 'success',
      duration: 3000,
    })
    emit('update:open', false)
    // 跳转新仓库详情（应用内直接可达，列表回访时自动刷新）
    void router.push(`/repos/${slug}/${name}?tab=code`)
  }
  catch (err) {
    // 403（缺 group-resource:rw）/ 409（同名）等：透出服务端 message，保留弹窗
    toast.add({
      title: t('repos.create.createFailed'),
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
    :title="t('repos.create.title')"
    :ui="{ content: 'max-w-md' }"
  >
    <template #body>
      <div class="flex flex-col gap-4">
        <!-- 组织上下文（selectedGroup 只读展示） -->
        <div class="flex items-center gap-2 text-sm text-muted">
          <UIcon name="i-lucide-building-2" class="size-4 shrink-0" />
          <span>{{ selectedGroup?.path || t('repos.create.noGroup') }}</span>
        </div>

        <!-- 仓库名（必填，命名规则校验） -->
        <UFormField
          :label="t('repos.create.name')"
          required
          :error="nameError || undefined"
        >
          <UInput
            v-model="form.name"
            class="w-full"
            :placeholder="t('repos.create.namePlaceholder')"
            @blur="form.name && validateName()"
          />
        </UFormField>

        <!-- 描述（选填） -->
        <UFormField :label="t('repos.create.description')">
          <UTextarea
            v-model="form.description"
            class="w-full"
            :rows="2"
            autoresize
            :placeholder="t('repos.create.descriptionPlaceholder')"
          />
        </UFormField>

        <!-- 可见性（创建时可设；创建后 PATCH 不支持修改） -->
        <UFormField :label="t('repos.create.visibility')">
          <USelect
            v-model="form.visibility"
            class="w-full"
            :items="visibilityItems"
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
          icon="i-lucide-plus"
          :loading="submitting"
          :label="t('repos.create.submit')"
          @click="onCreate"
        />
      </div>
    </template>
  </UModal>
</template>
