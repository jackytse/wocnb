<script setup lang="ts">
/**
 * 仓库墙（T13 验收 2 / T14 验收 2）—— 组织墙（可编辑）与个人墙（只读）
 * 复用同一组件，样式完全一致。
 *
 * 模式：
 * - 组织墙：slug 传入，mode='manage' 且 canManage 时显示「编辑」入口；
 *   编辑态支持**搜索添加**（GET /{slug}/-/repos?search=）、**上/下移排序**
 *   （已裁决：上下移按钮，不引入拖拽库）、移除；保存 PUT 全量 string[]，
 *   服务端按提交顺序展示，成功后以返回列表即时反映新顺序（§8.5）。
 * - 个人墙（T14）：username 传入，恒只读（数据源 /users/{x}/pinned-repos）。
 *
 * 降级（验收 2 / §8.2）：GET 403（缺 group-manage:r / account-engage:r）
 * **仅本区块** StateAlert forbidden，绝不影响页面其余区块。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import {
  fetchPinnedRepos,
  savePinnedRepos,
  type PinnedRepoItem,
} from '../../composables/useCnbOrg'
import {
  fetchUserPinnedRepos,
} from '../../composables/useCnbSocial'
import { fetchCnbGroupRepos } from '../../composables/useCnbAuth'
import { formatRelativeTime } from '../../utils'
import StateAlert from '../repo/StateAlert.vue'

const props = defineProps<{
  /** 组织路径（组织墙数据源与 PUT 目标；个人墙时忽略） */
  slug?: string
  /** 用户名（传入时切换为个人墙数据源，恒只读 —— T14） */
  username?: string
  /** 'manage'：可编辑（还需 canManage）；'readonly'：纯展示 */
  mode: 'manage' | 'readonly'
  /** 是否有管理权限（canManageRole 收敛判定，组织墙编辑入口用） */
  canManage?: boolean
}>()

const { t } = useI18n()
const toast = useToast()
const router = useRouter()

/** 是否处于可编辑组织墙（个人墙恒只读） */
const editable = computed(() => !props.username && props.mode === 'manage' && !!props.canManage)

// ---------------------------------------------------------------------------
// 列表加载
// ---------------------------------------------------------------------------

const items = ref<PinnedRepoItem[]>([])
const loading = ref(false)
const error = ref<Error | null>(null)

async function load() {
  const source = props.username || props.slug
  if (!source) {
    items.value = []
    return
  }
  loading.value = true
  error.value = null
  try {
    items.value = props.username
      ? await fetchUserPinnedRepos(props.username)
      : await fetchPinnedRepos(props.slug!)
  }
  catch (err) {
    items.value = []
    error.value = err as Error
  }
  finally {
    loading.value = false
  }
}

// 数据源变化重拉（组织切换 / 用户名变化）
watch(() => `${props.slug || ''}|${props.username || ''}`, () => void load(), { immediate: true })

/** 点击仓库卡进应用内详情 */
function openRepo(path: string) {
  void router.push(`/repos/${path}?tab=code`)
}

// ---------------------------------------------------------------------------
// 编辑态（组织墙 + canManage）：搜索添加 / 上下移 / 移除 / PUT 全量保存
// ---------------------------------------------------------------------------

/** 编辑态开关（编辑中 = 操作本地 draft，保存/取消后才回到展示态） */
const editing = ref(false)
/** 本地有序草稿（上下移只改 draft，保存时整段 PUT） */
const draft = ref<PinnedRepoItem[]>([])
const saving = ref(false)

function enterEdit() {
  draft.value = [...items.value]
  editing.value = true
}

function cancelEdit() {
  editing.value = false
  draft.value = []
}

/** 上移（index > 0）：与前一元素交换 —— 排序即数组顺序（§8.5 全量 PUT 口径） */
function moveUp(index: number) {
  if (index <= 0) {
    return
  }
  const next = [...draft.value]
  ;[next[index - 1], next[index]] = [next[index], next[index - 1]]
  draft.value = next
}

/** 下移（index < len-1）：与后一元素交换 */
function moveDown(index: number) {
  if (index >= draft.value.length - 1) {
    return
  }
  const next = [...draft.value]
  ;[next[index], next[index + 1]] = [next[index + 1], next[index]]
  draft.value = next
}

function removeAt(index: number) {
  draft.value = draft.value.filter((_, i) => i !== index)
}

// —— 搜索添加（GET /{slug}/-/repos?search=）——

const searchKeyword = ref('')
const searchResults = ref<PinnedRepoItem[]>([])
const searching = ref(false)
/** 搜索错误仅影响搜索行（不阻塞编辑态主体） */
const searchError = ref(false)

async function onSearch() {
  const keyword = searchKeyword.value.trim()
  if (!props.slug || !keyword || searching.value) {
    searchResults.value = []
    return
  }
  searching.value = true
  searchError.value = false
  try {
    const repos = await fetchCnbGroupRepos(props.slug, 1, 20, keyword)
    searchResults.value = repos.map(repo => ({
      path: repo.path,
      name: repo.name,
      description: repo.description,
      starCount: repo.starCount,
      forkCount: 0,
      language: repo.language,
      updatedAt: repo.updatedAt,
    }))
  }
  catch {
    searchResults.value = []
    searchError.value = true
  }
  finally {
    searching.value = false
  }
}

/** 已在草稿中的 path 集合（添加按钮防重复） */
const draftPaths = computed(() => new Set(draft.value.map(item => item.path)))

function addToDraft(item: PinnedRepoItem) {
  if (draftPaths.value.has(item.path)) {
    return
  }
  draft.value = [...draft.value, item]
}

/** 保存：PUT 全量有序 path 数组，成功后以服务端返回即时反映新顺序 */
async function onSave() {
  if (!props.slug || saving.value) {
    return
  }
  saving.value = true
  try {
    items.value = await savePinnedRepos(props.slug, draft.value.map(item => item.path))
    toast.add({ title: t('org.wall.saved'), color: 'success', duration: 3000 })
    editing.value = false
    draft.value = []
  }
  catch (err) {
    // 403（缺 group-manage:rw）兜底：透出服务端信息，编辑态保留
    toast.add({
      title: t('org.wall.saveFailed'),
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
  <section class="flex flex-col gap-3">
    <!-- 标题行：编辑入口（仅可编辑组织墙显示） -->
    <div class="flex items-center justify-between gap-2">
      <h3 class="text-sm font-semibold">
        {{ t('org.wall.title') }}
      </h3>
      <UButton
        v-if="editable && !editing"
        size="xs"
        color="neutral"
        variant="outline"
        icon="i-lucide-pencil"
        :label="t('org.wall.edit')"
        @click="enterEdit"
      />
    </div>

    <!-- 展示态 -->
    <template v-if="!editing">
      <StateAlert
        v-if="loading"
        state="loading"
      />
      <StateAlert
        v-else-if="error"
        state="error"
        :error="error"
        :retry="load"
      />
      <StateAlert
        v-else-if="items.length === 0"
        state="empty"
        :empty-text="t('org.wall.empty')"
        :empty-desc="editable ? t('org.wall.emptyEditable') : ''"
      />
      <div
        v-else
        class="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"
      >
        <UCard
          v-for="item in items"
          :key="item.path"
          :ui="{ body: 'p-3 flex flex-col gap-1.5' }"
          class="cursor-pointer hover:ring-primary/40 transition"
          @click="openRepo(item.path)"
        >
          <span class="text-sm font-medium text-highlighted truncate">{{ item.name }}</span>
          <p
            v-if="item.description"
            class="text-xs text-dimmed line-clamp-1"
          >
            {{ item.description }}
          </p>
          <div class="flex items-center gap-3 text-xs text-dimmed">
            <span
              v-if="item.starCount > 0"
              class="inline-flex items-center gap-1"
            >
              <UIcon
                name="i-lucide-star"
                class="size-3"
              />
              {{ item.starCount }}
            </span>
            <span
              v-if="item.forkCount > 0"
              class="inline-flex items-center gap-1"
            >
              <UIcon
                name="i-lucide-git-fork"
                class="size-3"
              />
              {{ item.forkCount }}
            </span>
            <span
              v-if="item.updatedAt"
              class="ms-auto truncate"
            >
              {{ formatRelativeTime(item.updatedAt) }}
            </span>
          </div>
        </UCard>
      </div>
    </template>

    <!-- 编辑态：搜索添加 + 有序列表（上/下移 + 移除）+ 保存/取消 -->
    <template v-else>
      <!-- 搜索添加 -->
      <div class="flex flex-col gap-2 rounded-lg border border-default p-3">
        <div class="flex items-center gap-2">
          <UInput
            v-model="searchKeyword"
            size="sm"
            variant="soft"
            icon="i-lucide-search"
            :placeholder="t('org.wall.searchPlaceholder')"
            class="flex-1"
            @keydown.enter="onSearch"
          />
          <UButton
            size="sm"
            color="neutral"
            variant="soft"
            icon="i-lucide-search"
            :loading="searching"
            :label="t('org.wall.search')"
            @click="onSearch"
          />
        </div>
        <p
          v-if="searchError"
          class="text-xs text-error"
        >
          {{ t('org.wall.searchFailed') }}
        </p>
        <div
          v-else-if="searchResults.length > 0"
          class="flex flex-col gap-1 max-h-48 overflow-y-auto"
        >
          <div
            v-for="result in searchResults"
            :key="result.path"
            class="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-elevated/50 text-sm"
          >
            <span class="truncate flex-1">{{ result.name }}</span>
            <span class="text-xs text-dimmed truncate hidden sm:inline">{{ result.path }}</span>
            <UButton
              size="xs"
              color="primary"
              variant="soft"
              icon="i-lucide-plus"
              :disabled="draftPaths.has(result.path)"
              :label="t('org.wall.add')"
              @click="addToDraft(result)"
            />
          </div>
        </div>
      </div>

      <!-- 有序草稿列表 -->
      <StateAlert
        v-if="draft.length === 0"
        state="empty"
        :empty-text="t('org.wall.emptyDraft')"
      />
      <div
        v-else
        class="flex flex-col gap-1"
      >
        <div
          v-for="(item, index) in draft"
          :key="item.path"
          class="flex items-center gap-2 px-3 py-2 rounded-lg border border-default text-sm"
        >
          <UBadge
            color="neutral"
            variant="subtle"
            size="sm"
            :label="String(index + 1)"
            class="shrink-0 font-mono"
          />
          <span class="truncate flex-1">{{ item.name }}</span>
          <span class="text-xs text-dimmed truncate hidden md:inline">{{ item.path }}</span>
          <div class="flex items-center gap-1 shrink-0">
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              icon="i-lucide-arrow-up"
              :disabled="index === 0"
              :aria-label="t('org.wall.moveUp')"
              @click="moveUp(index)"
            />
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              icon="i-lucide-arrow-down"
              :disabled="index === draft.length - 1"
              :aria-label="t('org.wall.moveDown')"
              @click="moveDown(index)"
            />
            <UButton
              size="xs"
              color="error"
              variant="ghost"
              icon="i-lucide-x"
              :aria-label="t('org.wall.remove')"
              @click="removeAt(index)"
            />
          </div>
        </div>
      </div>

      <!-- 保存 / 取消 -->
      <div class="flex justify-end gap-2">
        <UButton
          size="sm"
          color="neutral"
          variant="ghost"
          :label="t('common.cancel')"
          @click="cancelEdit"
        />
        <UButton
          size="sm"
          color="primary"
          icon="i-lucide-save"
          :loading="saving"
          :label="t('org.wall.save')"
          @click="onSave"
        />
      </div>
    </template>
  </section>
</template>
