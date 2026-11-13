<script setup lang="ts">
/**
 * 仓库详情容器（catch-all 路由 /repos/:repoPath(.*)*）。
 *
 * 路由约定（设计文档 §3）：
 * - repoPath 为 catch-all 数组，join('/') 后是仓库完整路径（多级子组织可用）；
 * - 视图定位全用 query：tab（默认 code）/ ref / path / number / sn / sha /
 *   state / page / keyword，读写统一经 useRepoRoute；
 * - /repos 由 repos/index.vue 静态路由承接（静态段评分高于 catch-all），
 *   若用户直接访问 /repos/<空> 则 replace 回 /repos 兜底。
 *
 * 组装：RepoHeader（概览头）+ RepoTabs（五页签）+ 按 tab/number/sn 切换
 * 的视图组件；仓库详情与默认分支并行加载（fetchRepoDetail + fetchGitHead）。
 */
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { CnbApiError } from '../../composables/useCnbAuth'
import {
  fetchGitHead,
  fetchRepoDetail,
  repoSiteUrl,
  type GitRefInfo,
  type RepoDetail,
} from '../../composables/useCnbRepo'
import { parsePositiveInt, useRepoRoute } from '../../composables/useRepoRoute'
import StateAlert from '../../components/repo/StateAlert.vue'
import RepoHeader from '../../components/repo/RepoHeader.vue'
import RepoTabs from '../../components/repo/RepoTabs.vue'
import RepoCodeBrowser from '../../components/repo/RepoCodeBrowser.vue'
import RepoCommits from '../../components/repo/RepoCommits.vue'
import RepoIssueList from '../../components/repo/RepoIssueList.vue'
import RepoIssueDetail from '../../components/repo/RepoIssueDetail.vue'
import RepoPullList from '../../components/repo/RepoPullList.vue'
import RepoPullDetail from '../../components/repo/RepoPullDetail.vue'
import RepoBuildList from '../../components/repo/RepoBuildList.vue'
import RepoBuildDetail from '../../components/repo/RepoBuildDetail.vue'
import RepoReleases from '../../components/repo/RepoReleases.vue'
import RepoPackages from '../../components/repo/RepoPackages.vue'
import RepoCommunity from '../../components/repo/RepoCommunity.vue'

const router = useRouter()
// route 用于读取原始 query.number（useRepoRoute 只暴露解析后的 number）
const route = useRoute()
const { t } = useI18n()
const {
  repoPath,
  tab,
  refName,
  number,
  sn,
  backToList,
} = useRepoRoute()

// ---------------------------------------------------------------------------
// 仓库概览（详情 + 默认分支，并行加载）
// ---------------------------------------------------------------------------

const detail = ref<RepoDetail | null>(null)
const head = ref<GitRefInfo | null>(null)
const loading = ref(false)
const error = ref<Error | null>(null)

/** 生效 ref：?ref= 优先，缺省用默认分支名（head 加载完成前为空） */
const effectiveRef = computed(() => refName.value || head.value?.name || '')

async function loadRepo() {
  // repoPath 为空（/repos/ 之类）：replace 回列表页兜底（防 catch-all 吞掉 /repos 的极端情况）
  if (!repoPath.value) {
    void router.replace('/repos')
    return
  }
  loading.value = true
  error.value = null
  try {
    // 详情与默认分支无依赖，并行请求缩短首屏
    const [d, h] = await Promise.all([
      fetchRepoDetail(repoPath.value),
      fetchGitHead(repoPath.value).catch(() => null),
    ])
    detail.value = d
    head.value = h
  }
  catch (err) {
    detail.value = null
    head.value = null
    error.value = err as Error
  }
  finally {
    loading.value = false
  }
}

// 仓库路径变化（切仓库）即重载概览
watch(repoPath, () => void loadRepo(), { immediate: true })

/** 仓库站点地址（错误态的外跳兜底出口） */
const siteUrl = computed(() => repoSiteUrl(repoPath.value))

/** tab=code 且 ref 已就绪才渲染代码视图（避免用空 ref 请求） */
const codeReady = computed(() => tab.value === 'code' && !!effectiveRef.value)

// ---------------------------------------------------------------------------
// 非法编号判定（QA 回归修复项 #1）
// ---------------------------------------------------------------------------

/**
 * 「未找到」态错误对象（复用 StateAlert 的 404 分支文案）。
 * number 存在但不是正整数时，不能回落到列表页 —— 设计文档 §3 要求
 * 渲染"未找到"态而非静默忽略参数。
 */
const numberNotFound = new CnbApiError('invalid number param', 404, 'notFound')

/**
 * number 参数存在（含空串 `?number=`）但解析为非正整数时置真。
 * 注意：?tab=issues（**无** number 参数，query.number === undefined）
 * 不受影响，仍正常渲染列表，不误伤。
 */
const invalidNumber = computed(() => {
  if (tab.value !== 'issues' && tab.value !== 'pulls') {
    return false
  }
  // query.number 可能是 string 或数组（重复参数），parsePositiveInt
  // 对两者统一按 Number() 归一判定；undefined 表示参数未出现
  const raw = route.query.number
  return raw !== undefined && parsePositiveInt(raw as string | string[]) === null
})
</script>

<template>
  <UDashboardPanel id="repo-detail">
    <template #header>
      <UDashboardNavbar :title="repoPath || t('layout.repos')">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #right>
          <UButton
            size="sm"
            color="neutral"
            variant="ghost"
            icon="i-lucide-arrow-left"
            :label="t('repo.back')"
            @click="router.push('/repos')"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <!-- 概览加载失败：整页状态（403/404/网络） -->
      <StateAlert
        v-if="error"
        state="error"
        :error="error"
        :site-url="siteUrl"
        :retry="loadRepo"
        @back="router.push('/repos')"
      />

      <template v-else>
        <RepoHeader :detail="detail" :loading="loading" @updated="loadRepo" />

        <!-- 页签：概览加载中禁点（防用未就绪的 ref 发请求） -->
        <RepoTabs v-if="!loading && detail" />

        <div class="mt-2">
          <!-- 代码页签：等 ref 就绪（?ref= 或默认分支）再渲染 -->
          <template v-if="tab === 'code'">
            <StateAlert
              v-if="!codeReady"
              state="loading"
              loading-variant="detail"
            />
            <RepoCodeBrowser
              v-else
              :repo-path="repoPath"
              :git-ref="effectiveRef"
              :visibility="detail?.visibility"
            />
          </template>

          <!-- 提交页签 -->
          <template v-else-if="tab === 'commits'">
            <RepoCommits :repo-path="repoPath" :git-ref="effectiveRef" />
          </template>

          <!-- Issue 页签：number 非法 → 未找到态；number 合法 → 详情；无 number → 列表 -->
          <template v-else-if="tab === 'issues'">
            <StateAlert
              v-if="invalidNumber"
              state="error"
              :error="numberNotFound"
              :site-url="siteUrl"
              @back="backToList"
            />
            <RepoIssueDetail
              v-else-if="number"
              :repo-path="repoPath"
              :number="String(number)"
            />
            <RepoIssueList v-else :repo-path="repoPath" />
          </template>

          <!-- PR 页签：判定逻辑与 Issue 页签一致 -->
          <template v-else-if="tab === 'pulls'">
            <StateAlert
              v-if="invalidNumber"
              state="error"
              :error="numberNotFound"
              :site-url="siteUrl"
              @back="backToList"
            />
            <RepoPullDetail
              v-else-if="number"
              :repo-path="repoPath"
              :number="String(number)"
            />
            <RepoPullList v-else :repo-path="repoPath" />
          </template>

          <!-- 流水线页签：sn 存在 → 详情，否则列表；archived 单向下发禁写入口 -->
          <template v-else-if="tab === 'builds'">
            <RepoBuildDetail
              v-if="sn"
              :repo-path="repoPath"
              :sn="sn"
              :archived="detail?.archived"
            />
            <RepoBuildList
              v-else
              :repo-path="repoPath"
              :archived="detail?.archived"
            />
          </template>

          <!-- Releases 页签：release 下钻 → 详情，否则列表（T07） -->
          <template v-else-if="tab === 'releases'">
            <RepoReleases :repo-path="repoPath" :detail="detail" />
          </template>

          <!-- 制品库页签（T08）：三栏布局 + URL 三键恢复（ptype/pname/ptag） -->
          <template v-else-if="tab === 'packages'">
            <RepoPackages :repo-path="repoPath" :detail="detail" />
          </template>

          <!-- 社区页签（T09）：四区块独立降级（贡献者/趋势/Fork/Star） -->
          <template v-else-if="tab === 'community'">
            <RepoCommunity :repo-path="repoPath" />
          </template>
        </div>
      </template>
    </template>
  </UDashboardPanel>
</template>
