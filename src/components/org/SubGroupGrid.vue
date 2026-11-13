<script setup lang="ts">
/**
 * 子组织网格（T13 验收 3）：点击卡片进入下级组织。
 *
 * 下钻语义（关键）：/group 页无独立组织路由，"进入下级组织" = 
 * router.push(`/group?slug={path}`)，由 group.vue 读取 slug 并**同步
 * selectedGroup**（与 GroupsMenu 同一状态源，成员页/仓库页随联动）。
 * 本组件只负责展示与 emit('select', path)，状态写入收口在页面层。
 *
 * 数据：GET /{slug}/-/sub-groups（scope group-resource:r）；403/失败
 * 仅本区块降级（StateAlert），不影响组织页其余区块。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { fetchSubGroups, type SubGroupItem } from '../../composables/useCnbOrg'
import { cnbGroupLogoUrl } from '../../composables/useCnbAuth'
import StateAlert from '../repo/StateAlert.vue'

const props = defineProps<{
  /** 当前组织路径（父 slug） */
  slug: string
  /** 是否仍存在下级（服务端 sub_group_count = 0 时整块隐藏，避免空区块噪音） */
  subGroupCount: number
}>()

const emit = defineEmits<{
  (e: 'select', path: string): void
}>()

const { t } = useI18n()

const subGroups = ref<SubGroupItem[]>([])
const loading = ref(false)
const error = ref<Error | null>(null)

async function load() {
  if (!props.slug) {
    subGroups.value = []
    return
  }
  loading.value = true
  error.value = null
  try {
    subGroups.value = await fetchSubGroups(props.slug)
  }
  catch (err) {
    subGroups.value = []
    error.value = err as Error
  }
  finally {
    loading.value = false
  }
}

watch(() => props.slug, () => void load(), { immediate: true })

/** 无下级组织且加载成功 → 不渲染区块（验收：子组织数为 0 时不占位） */
const visible = computed(() => props.subGroupCount > 0 || subGroups.value.length > 0)
</script>

<template>
  <section
    v-if="visible"
    class="flex flex-col gap-3"
  >
    <h3 class="text-sm font-semibold">
      {{ t('org.subGroups.title') }}
    </h3>
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
      v-else-if="subGroups.length === 0"
      state="empty"
      :empty-text="t('org.subGroups.empty')"
    />
    <div
      v-else
      class="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"
    >
      <UCard
        v-for="group in subGroups"
        :key="group.path"
        :ui="{ body: 'p-3 flex flex-col gap-1.5' }"
        class="cursor-pointer hover:ring-primary/40 transition"
        @click="emit('select', group.path)"
      >
        <div class="flex items-center gap-2 min-w-0">
          <UAvatar
            :src="cnbGroupLogoUrl(group.path)"
            :alt="group.name"
            size="xs"
            class="rounded shrink-0"
          />
          <span class="text-sm font-medium truncate">{{ group.name }}</span>
        </div>
        <p
          v-if="group.description"
          class="text-xs text-dimmed line-clamp-1"
        >
          {{ group.description }}
        </p>
        <div class="flex items-center gap-3 text-xs text-dimmed">
          <span>{{ t('org.subGroups.repoCount', { count: group.allSubRepoCount }) }}</span>
          <span>{{ t('org.subGroups.memberCount', { count: group.memberCount }) }}</span>
        </div>
      </UCard>
    </div>
  </section>
</template>
