<script setup lang="ts">
/**
 * 创建组织弹窗（2026-11-11 组织能力扩展）。
 *
 * 端点：`POST /groups`（dto.CreateGroupReq，scope group-manage:rw）。
 * body：`{ path, description?, remark?, bind_domain? }` —— 只放有值的字段。
 *
 * 两个使用场景共用本弹窗（避免两份表单两套校验）：
 * 1. 侧边栏 GroupsMenu「创建组织」→ 不传 parentPath，path 由用户自由填写；
 * 2. 组织页「新建子组织」→ 传 parentPath，path 前缀固定为 `{父组织}/`，
 *    用户只填组织名（服务端接受 `parent/child` 形式的路径）。
 *
 * 成功后：重新拉取组织列表（fetchCnbGroups 会写入共享状态 cnbGroups，
 * 侧边栏下拉即时更新）→ 若新组织出现在列表里则切换选中 → 关窗。
 * 201 未声明响应 schema（swagger 只给 201 无 body），故 createGroup 走
 * cnbFetchVoid，不抛错即视为成功。
 */
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  createGroup,
  type CreateGroupInput,
} from '../../composables/useCnbOrgSettings'
import {
  cnbGroups,
  fetchCnbGroups,
  selectedGroup,
  type CnbGroup,
} from '../../composables/useCnbAuth'

const props = defineProps<{
  /** 弹窗开关（v-model:open） */
  open: boolean
  /**
   * 父组织路径（可选）：传值时 path 输入框只接受「组织名」，
   * 实际提交为 `{parentPath}/{name}`，用于「新建子组织」场景。
   */
  parentPath?: string
}>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  /** 创建成功：回传新组织完整路径（调用方可据此跳转/联动） */
  (e: 'created', path: string): void
}>()

const { t } = useI18n()
const toast = useToast()

const openModel = computed({
  get: () => props.open,
  set: (value: boolean) => emit('update:open', value),
})

const form = reactive({
  /** 组织名（有 parentPath 时只填这一段；否则为完整 path） */
  name: '',
  description: '',
  remark: '',
  bindDomain: '',
})
const submitting = ref(false)
/** 路径校验错误（为空表示通过） */
const pathError = ref('')

/**
 * CNB 组织路径规则：字母/数字/下划线/点/连字符（与仓库命名同族）。
 * 有父组织时只校验最后一段；无父组织时允许 `a/b` 形式（服务端支持
 * 直接在指定父路径下创建），因此按 `/` 分段后每段单独校验。
 */
const SEGMENT_PATTERN = /^[\w.-]+$/

/** 打开时重置表单（父组织变化也要重置，避免残留上次的输入） */
watch([() => props.open, () => props.parentPath], ([open]) => {
  if (open) {
    form.name = ''
    form.description = ''
    form.remark = ''
    form.bindDomain = ''
    pathError.value = ''
  }
})

/** 实际提交的完整路径：有父组织则拼接，否则用用户输入 */
const fullPath = computed(() => {
  const name = form.name.trim()
  const parent = (props.parentPath || '').trim()
  if (!name) {
    return ''
  }
  return parent ? `${parent}/${name}` : name
})

/** 路径校验：非空 + 每段符合命名规则 */
function validatePath(): boolean {
  const path = fullPath.value
  if (!path) {
    pathError.value = t('org.createGroup.pathRequired')
    return false
  }
  const invalid = path.split('/').some(segment => !SEGMENT_PATTERN.test(segment))
  if (invalid) {
    pathError.value = t('org.createGroup.pathInvalid')
    return false
  }
  pathError.value = ''
  return true
}

/** 提交创建 */
async function onCreate() {
  if (!validatePath() || submitting.value) {
    return
  }
  const path = fullPath.value
  const input: CreateGroupInput = {
    path,
    description: form.description.trim() || undefined,
    remark: form.remark.trim() || undefined,
    bindDomain: form.bindDomain.trim() || undefined,
  }
  submitting.value = true
  try {
    await createGroup(input)
    // 刷新共享列表 → 侧边栏立即出现新组织（不必等组件重新挂载）
    let created: CnbGroup | undefined
    try {
      const list = await fetchCnbGroups()
      created = list.find(item => item.path === path)
    }
    catch {
      // 列表刷新失败不影响创建结果（组织已建立），只是无法自动选中
    }
    if (created) {
      selectedGroup.value = created
    }
    else if (cnbGroups.value === null) {
      // 列表彻底没拿到：至少把选中路径指向新组织，页面可正常打开
      selectedGroup.value = {
        id: path,
        name: path.split('/').pop() || path,
        path,
        description: form.description.trim(),
        member_count: 0,
        all_sub_repo_count: 0,
        access_role: '',
      }
    }
    toast.add({
      title: t('org.createGroup.created'),
      description: path,
      color: 'success',
      duration: 3000,
    })
    emit('update:open', false)
    emit('created', path)
  }
  catch (err) {
    // 403（缺 group-manage:rw）/ 409（路径已存在）/ 422（路径非法）：
    // 透出服务端原文，保留弹窗让用户改完重试
    toast.add({
      title: t('org.createGroup.createFailed'),
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
    :title="parentPath ? t('org.createGroup.subTitle') : t('org.createGroup.title')"
    :ui="{ content: 'max-w-md' }"
  >
    <template #body>
      <div class="flex flex-col gap-4">
        <!-- 父组织上下文：仅在「新建子组织」时展示，让用户明确建在哪 -->
        <div
          v-if="parentPath"
          class="flex items-center gap-2 text-sm text-muted"
        >
          <UIcon
            name="i-lucide-corner-down-right"
            class="size-4 shrink-0"
          />
          <span class="font-mono">{{ parentPath }}/</span>
        </div>

        <UFormField
          :label="parentPath ? t('org.createGroup.name') : t('org.createGroup.path')"
          required
          :error="pathError || undefined"
          :hint="parentPath ? undefined : t('org.createGroup.pathHint')"
        >
          <UInput
            v-model="form.name"
            class="w-full"
            :placeholder="parentPath ? t('org.createGroup.namePlaceholder') : t('org.createGroup.pathPlaceholder')"
            @blur="form.name && validatePath()"
          />
        </UFormField>

        <UFormField :label="t('org.createGroup.description')">
          <UTextarea
            v-model="form.description"
            class="w-full"
            :rows="2"
            autoresize
            :placeholder="t('org.createGroup.descriptionPlaceholder')"
          />
        </UFormField>

        <UFormField
          :label="t('org.createGroup.remark')"
          :hint="t('org.createGroup.optional')"
        >
          <UInput
            v-model="form.remark"
            class="w-full"
          />
        </UFormField>

        <!-- 绑定域名只对根组织有意义（子组织继承根组织域名），故仅无父组织时展示 -->
        <UFormField
          v-if="!parentPath"
          :label="t('org.createGroup.bindDomain')"
          :hint="t('org.createGroup.optional')"
        >
          <UInput
            v-model="form.bindDomain"
            class="w-full"
            placeholder="example.com"
          />
        </UFormField>

        <!-- 提交预览：让用户在建之前看到最终路径，避免拼错父路径 -->
        <p
          v-if="fullPath"
          class="text-xs text-muted font-mono"
        >
          {{ t('org.createGroup.preview') }}: {{ fullPath }}
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
          icon="i-lucide-plus"
          :loading="submitting"
          :label="t('org.createGroup.submit')"
          @click="onCreate"
        />
      </div>
    </template>
  </UModal>
</template>
