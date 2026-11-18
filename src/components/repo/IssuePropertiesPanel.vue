<script setup lang="ts">
/**
 * Issue 自定义属性面板 —— 批次 2 · REQ-09。
 *
 * 数据来源（三条并行请求）：
 * - `listRepoProperties`            仓库可见属性字典（决定"有哪些字段可填"）
 * - `listRepoInvisibleProperties`   仓库隐藏属性字典（仅自己可见，需标注）
 * - `listIssueProperties`           该 Issue 已填写的值
 *
 * 表单按属性的 `type` 三值（string / date / number）选控件；提交时一律
 * 统一为字符串（api.PropertyForm.value 是 string）。
 *
 * ⚠️ 部分失败：PATCH 返回 `{ success_count, failed_count, failed_keys }`，
 * HTTP 200 不等于全部成功。必须按 failedCount 展示"部分失败 + 失败键名"，
 * 不能只看状态码报成功（N2 同类陷阱）。
 *
 * 【待产品确认】空串语义（QA 批次 2 观察项）：保存时**过滤掉空串值**，
 * 即"空串 = 不修改该属性"而非"清空该属性"——PUT 部分更新语义下服务端对
 * 空串的行为未定义（可能报 400/可能写空），在裁决前不做"清空"能力。
 * 若产品确认需要清空，应改用显式删除端点或空串约定，并同步更新此处注释。
 */
// 数据层：属性字典（可见/隐藏）与 Issue 属性读写
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
// updateIssueProperties 返回 { success_count, failed_count, failed_keys }（部分失败语义）
import {
  listIssueProperties,
  listRepoInvisibleProperties,
  listRepoProperties,
  updateIssueProperties,
  type RepoPropertyDef,
} from '../../composables/useCnbRepo'

const props = defineProps<{
  /** 仓库完整路径（org/repo） */
  repoPath: string
  /** Issue 编号 */
  number: string
  /** 是否可编辑（repo-issue:rw 预判） */
  canEdit: boolean
}>()

const { t } = useI18n()
const toast = useToast() // 分级反馈（success / warning / error 三档）

/** 是否展开（折叠面板；展开才首次加载，避免打开详情就发请求） */
const expanded = ref(false)
/** 字典/值加载中 */
const loading = ref(false)
/** 加载失败文案（面板内提示条，不阻塞页面主体） */
const loadError = ref('')
/** 是否已加载过（折叠再展开不重复请求，写后主动刷新） */
const loaded = ref(false)

/** 全部可选属性（可见 + 隐藏合并，隐藏项标 visible=false 供 UI 提示） */
const definitions = ref<RepoPropertyDef[]>([])
/** 已填写的值：key → value */
const values = ref<Record<string, string>>({})
const saving = ref(false) // 保存请求进行中（按钮 loading）

/**
 * 加载字典 + 当前值。
 * 三个请求并行（彼此独立），任一失败不影响其他结果可用：
 * 字典失败 → 面板显示错误条；值失败 → 视为全空，用户可重新填。
 */
async function load() {
  // 路径/编号未就绪：不发请求（详情页切换瞬间）
  if (!props.repoPath || !props.number) {
    return
  }
  loading.value = true
  loadError.value = ''
  try {
    // 三个 .catch 降级：可见字典失败也会走主流程（merged 可能只有隐藏项）
    const [visibleDefs, invisibleDefs, issueProps] = await Promise.all([
      listRepoProperties(props.repoPath).catch(() => [] as RepoPropertyDef[]),
      listRepoInvisibleProperties(props.repoPath).catch(() => [] as RepoPropertyDef[]),
      listIssueProperties(props.repoPath, props.number).catch(() => []),
    ])
    // 合并去重：同一 key 以可见字典为准（隐藏字典只补充缺失项）
    const merged = new Map<string, RepoPropertyDef>()
    for (const def of visibleDefs) {
      merged.set(def.key, def)
    }
    for (const def of invisibleDefs) {
      if (!merged.has(def.key)) {
        merged.set(def.key, def)
      }
    }
    definitions.value = [...merged.values()]
    // 值初始化：字典全覆盖空串，再以服务端已填值覆盖（保证每个可填字段都有响应式键）
    const next: Record<string, string> = {}
    for (const def of definitions.value) {
      next[def.key] = ''
    }
    for (const item of issueProps) {
      next[item.key] = item.value
    }
    values.value = next
    loaded.value = true
  }
  catch (err) {
    // 字典请求整体失败（Promise.all 只会因未 catch 的异常进入）：记文案展示
    loadError.value = (err as Error)?.message || String(err)
  }
  finally {
    loading.value = false
  }
}

/** 展开时首次加载 */
watch(expanded, (value) => {
  if (value && !loaded.value) { // 已加载过不重复请求（写后由 save 重拉）
    void load()
  }
})

/** Issue 切换 → 重置缓存，下次展开重拉 */
watch(() => `${props.repoPath}|${props.number}`, () => {
  expanded.value = false // 收起面板（新 Issue 不该带着旧展开态）
  loaded.value = false // 强制下次展开重新加载
  definitions.value = [] // 清字典（防串数据：旧 Issue 的字段不该出现）
  values.value = {} // 清已填值
})

/** 是否有可展示的属性（无字典时不渲染折叠头，避免空壳） */
const hasDefinitions = computed(() => definitions.value.length > 0)

/**
 * 保存：提交全部非空值（服务端按 key 逐条校验）。
 * 按返回的成功/失败计数给出分级反馈：
 * - 全成功 → success toast；
 * - 部分失败 → warning toast 并列出失败键；
 * - 全失败 → error toast。
 */
async function save() {
  // 提交中防重复（按钮 loading，双保险）
  if (saving.value) {
    return
  }
  const properties = definitions.value
    .map(def => ({ key: def.key, value: values.value[def.key] || '' }))
    // 【待产品确认】空串过滤：空串视为"不修改该属性"而非"清空"——
    // PUT 部分更新语义下空串含义未定义（见文件头注释），裁决前不提交空值
    .filter(item => item.value !== '')
  if (properties.length === 0) {
    return // 全空：无内容可提交
  }
  saving.value = true
  try {
    const result = await updateIssueProperties(props.repoPath, props.number, properties)
    if (result.failedCount > 0 && result.successCount > 0) {
      // 部分失败：warning + 失败键列表（HTTP 200 但有键没写进去，N2 陷阱）
      toast.add({
        title: t('repo.properties.partialFailed', { count: result.failedCount }),
        description: result.failedKeys.join(', '),
        color: 'warning',
        duration: 6000,
      })
    }
    else if (result.failedCount > 0 && result.successCount === 0) {
      // 全失败：error + 失败键列表
      toast.add({
        title: t('repo.properties.allFailed'),
        description: result.failedKeys.join(', '),
        color: 'error',
        duration: 6000,
      })
    }
    else {
      // 全成功
      toast.add({ title: t('repo.properties.saved'), color: 'success', duration: 2500 })
    }
    // 写后重拉：服务端可能对值做规范化（如日期格式），以服务端为准
    await load()
  }
  catch (err) {
    // 整体异常（网络/403）：toast 透出，不静默吞不登出
    toast.add({
      title: t('repo.properties.saveFailed'),
      description: (err as Error)?.message || '',
      color: 'error',
      duration: 6000,
    })
  }
  finally {
    saving.value = false
  }
}
</script>

<template>
  <div v-if="hasDefinitions || !loaded" class="flex flex-col gap-2">
    <!-- 折叠头 -->
    <div class="flex items-center gap-2">
      <UIcon name="i-lucide-list-checks" class="size-4 text-muted" />
      <span class="text-sm font-medium text-highlighted">{{ t('repo.properties.title') }}</span>
      <div class="ms-auto flex items-center gap-1">
        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          :icon="expanded ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
          :aria-label="t('repo.annotations.toggle')"
          @click="expanded = !expanded"
        />
      </div>
    </div>

    <div v-if="expanded" class="flex flex-col gap-3 rounded-md border border-default p-3">
      <p v-if="loadError" class="text-xs text-error">
        {{ loadError }}
      </p>
      <p v-else-if="loading" class="text-xs text-dimmed">
        {{ t('common.loading') }}
      </p>
      <template v-else>
        <!-- 按 type 渲染控件：date → 日期选择，number → 数字框，其余文本框 -->
        <UFormField
          v-for="def in definitions"
          :key="def.key"
          :label="def.name || def.key"
        >
          <div class="flex items-center gap-2 w-full">
            <UInput
              v-if="def.type === 'date'"
              v-model="values[def.key]"
              type="date"
              class="w-full"
              :disabled="!canEdit"
            />
            <UInput
              v-else-if="def.type === 'number'"
              v-model="values[def.key]"
              type="number"
              class="w-full"
              :disabled="!canEdit"
            />
            <UInput
              v-else
              v-model="values[def.key]"
              class="w-full"
              :disabled="!canEdit"
            />
            <!-- 隐藏属性提示：仅自己可见，避免用户误以为是公共字段 -->
            <UBadge
              v-if="!def.visible"
              color="neutral"
              variant="subtle"
              size="sm"
              :label="t('repo.properties.privateBadge')"
            />
          </div>
        </UFormField>

        <div v-if="canEdit" class="flex justify-end">
          <UButton
            size="xs"
            color="primary"
            :loading="saving"
            :label="t('common.save')"
            @click="save"
          />
        </div>
      </template>
    </div>
  </div>
</template>
