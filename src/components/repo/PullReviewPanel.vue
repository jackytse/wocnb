<script setup lang="ts">
/**
 * PR 评审区 —— 批次 2 · REQ-10。
 *
 * 结构（设计文档 §3.4）：
 * - 顶部操作条：批准 / 请求修改 / 评论（三档 ReviewEvent，提交 POST /reviews）
 * - 评审人管理：手输用户名增删（POST/DELETE /reviewers）
 * - 评审列表：状态徽标 + 正文 + 行级评论树（buildReviewThreads 分层）
 * - 回复：对某条顶层评论回复（POST /reviews/{rid}/replies，返回实体）
 *
 * 通道要点：`POST /reviews` 是 **201 空 body** → cnbFetchVoid；而回复/评审人/
 * 标签写端点都**有 body** → cnbFetch。同一区域通道不一致，逐条已按设计 §8.2 落实。
 *
 * 展开态路由化（QA 批次 2 遗留②）：评审卡的展开 id 与行级评论定位**不再用
 * 本地 ref**，而是消费 useRepoRoute 的 `?review=` / `?rcomment=` 键 —— 打开/
 * 收起走 openReview/closeReview，评论定位走 openReviewComment。收益：刷新或
 * 分享 URL 后评审卡按 URL 恢复展开与定位；返回键可在评审间回退。
 * 注意：switchTab 已在路由层统一清空这两个键，跨页签不会残留。
 *
 * 评审状态配色与 RepoPullDetail 的 reviewColor() 保持一致（approved=success /
 * changes_requested=error / commented=warning / 其余 neutral），避免同一状态
 * 在页面两处显示不同颜色。
 */
// Vue 组合式 API：nextTick 供深链滚动前等待线程 DOM 渲染完成
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
// 评审域数据层：评审/评论/回复/评审人 CRUD（通道依据见各函数注释）
import {
  addPullReviewers,
  buildReviewThreads,
  createPullReview,
  listPullReviews,
  listReviewComments,
  removePullReviewers,
  replyReviewComment,
  type PullReview,
  type ReviewComment,
  type ReviewEvent,
  type ReviewThread,
} from '../../composables/useCnbPullReviews'
// 评审下钻键（?review= / ?rcomment=）的读写收口在 useRepoRoute（唯一定义处）
import { useRepoRoute } from '../../composables/useRepoRoute'
import { useAppToast } from '../../composables/useAppToast'

const props = defineProps<{
  /** 仓库完整路径（org/repo；路径编码由数据层负责） */
  repoPath: string
  /** PR 编号（路径段，数据层负责编码） */
  number: string
  /** 是否可提交评审 / 管理评审人（PR 处于 open 且有 repo-pr:rw） */
  canEdit: boolean
}>()

const { t } = useI18n() // 文案与状态标签本地化
const toast = useAppToast() // 成功/失败提示（区块级，不登出）
// 展开态与评论定位的读写：组件内只调用路由层方法，禁止散写 router.push
const repoRoute = useRepoRoute()

/** 评审列表（归一化后；失败降级空数组 + loadError 文案） */
const reviews = ref<PullReview[]>([])
/** 列表加载中（本区块文案级提示，非骨架屏） */
const loading = ref(false)
/** 加载失败文案（展示在区块内，不影响 PR 主体） */
const loadError = ref('')
/**
 * 展开中的评审 id：**来自路由 ?review=**（原为本地 ref，刷新即丢失）。
 * 空串 = 全部收起；值不在当前评审列表里时不匹配任何卡片（自然收起，
 * 因此切 PR 后旧键残留也安全）。
 */
const activeReviewId = computed(() => repoRoute.review.value)
/** 定位的行级评论 id：路由 ?rcomment=（依赖 review，路由层已做联动归一） */
const activeCommentId = computed(() => repoRoute.rcomment.value)
/** 评审 id → 线程列表（按需加载后缓存） */
const threadsMap = ref<Record<string, ReviewThread[]>>({})
/** 评审 id → 评论加载中 */
const commentsLoading = ref<Record<string, boolean>>({})

/** 评审状态 → 颜色（与 RepoPullDetail.reviewColor 同口径） */
function stateColor(state: string): 'neutral' | 'success' | 'error' | 'warning' {
  switch (state) {
    case 'approved': return 'success' // 通过：绿
    case 'changes_requested': return 'error' // 需要修改：红
    case 'commented': return 'warning' // 仅评论：黄（不阻塞合并但需留意）
    default: return 'neutral' // pending 等未知态：中性
  }
}

/** 评审状态 → 本地化标签（未知值原样展示，不吞信息） */
function stateLabel(state: string): string {
  const key = `repo.pulls.review.state.${state}`
  const translated = t(key)
  // vue-i18n 找不到键时返回键名本身 → 回退到服务端原始值
  return translated === key ? state : translated
}

/** 加载评审列表（写操作后重拉，服务端不返回新评审实体） */
async function load() {
  // 路径/编号未就绪：不发请求（详情页未渲染完成的瞬间）
  if (!props.repoPath || !props.number) {
    return
  }
  loading.value = true // 区块加载提示
  loadError.value = ''
  try {
    reviews.value = await listPullReviews(props.repoPath, props.number)
  }
  catch (err) {
    // 区块级降级：清列表 + 记文案，绝不把异常抛到页面级
    reviews.value = []
    loadError.value = (err as Error)?.message || String(err)
  }
  finally {
    loading.value = false
  }
}

/**
 * 确保某条评审的线程已加载（幂等）：深链恢复与手动展开共用同一条通道。
 * 评论加载失败不阻塞评审正文展示：给空线程即可（不弹全局错误）。
 */
async function ensureThreads(reviewId: string) {
  // 无 id 或已加载过（缓存命中）：直接返回，避免重复请求
  if (!reviewId || threadsMap.value[reviewId]) {
    return
  }
  commentsLoading.value = { ...commentsLoading.value, [reviewId]: true }
  try {
    // 服务端返回该评审下全部评论（顶层+回复），由 buildReviewThreads 分层
    const comments = await listReviewComments(props.repoPath, props.number, reviewId)
    threadsMap.value = { ...threadsMap.value, [reviewId]: buildReviewThreads(comments) }
  }
  catch {
    // 失败给空线程：正文仍可见，只是没有评论（不打断用户阅读）
    threadsMap.value = { ...threadsMap.value, [reviewId]: [] }
  }
  finally {
    commentsLoading.value = { ...commentsLoading.value, [reviewId]: false }
  }
}

/**
 * 切换评审卡展开：写路由键（openReview 同时清 rcomment —— 换了评审，旧的
 * 行级评论定位必然失效）；再次点击同一卡 = 收起（closeReview 清双键）。
 */
function toggleReview(reviewId: string) {
  // 已展开 → 收起（清 review + rcomment，push 语义可返回）
  if (activeReviewId.value === reviewId) {
    repoRoute.closeReview()
    return
  }
  repoRoute.openReview(reviewId)
}

/**
 * 深链/展开联动：?review= 有值且列表已就绪 → 拉线程恢复展开；
 * ?rcomment= 有值 → 线程就绪后滚动定位到目标评论（模板给每个线程
 * 写了 rcomment-{id} 锚点）。immediate：首次挂载即尝试恢复。
 */
watch(
  () => [activeReviewId.value, reviews.value] as const,
  async () => {
    const id = activeReviewId.value
    // 无展开目标或列表未就绪（评审 id 不在列表里）：不动作
    if (!id || !reviews.value.some(review => review.id === id)) {
      return
    }
    await ensureThreads(id) // 恢复展开的评论树（幂等）
    if (activeCommentId.value) {
      // 线程 DOM 在本轮渲染后才存在，必须等 nextTick 再滚动
      await nextTick()
      document
        .getElementById(`rcomment-${activeCommentId.value}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' }) // 居中展示定位目标
    }
  },
  { immediate: true },
)

// ---------------------------------------------------------------------------
// 提交评审（批准 / 请求修改 / 评论）
// ---------------------------------------------------------------------------

const reviewModalOpen = ref(false)
const reviewEvent = ref<ReviewEvent>('comment') // 本轮提交的动作档位
const reviewBody = ref('') // 评审正文草稿（打开弹窗时清空）
const submitting = ref(false) // 提交中（按钮 loading，防重复）

/**
 * 打开评审提交弹窗（按钮决定 event）。
 * 命名为 openReviewModal：`openReview` 在路由层已被"展开评审卡"占用，
 * 同名会互相遮蔽（原实现正是撞名后才改用本地 ref 的）。
 */
function openReviewModal(event: ReviewEvent) {
  reviewEvent.value = event // 记录档位：提交与提示文案都依赖它
  reviewBody.value = '' // 每次打开都是新一轮评审，不带上一轮草稿
  reviewModalOpen.value = true
}

/**
 * 提交评审：POST /reviews（201 空 body → cnbFetchVoid）成功后重拉列表。
 * 「请求修改」要求填写理由（否则作者不知道该改什么），在前端先拦住。
 */
async function submitReview() {
  // 提交中：直接返回（按钮 loading，双保险）
  if (submitting.value) {
    return
  }
  // 「请求修改」必须有理由：前端先拦（服务端也会校验，但那样用户体验差）
  if (reviewEvent.value === 'request_changes' && reviewBody.value.trim() === '') {
    return
  }
  submitting.value = true
  try {
    await createPullReview(props.repoPath, props.number, {
      event: reviewEvent.value,
      body: reviewBody.value.trim() || undefined, // 空正文不提交 body 字段
    })
    reviewModalOpen.value = false
    toast.add({ title: t('repo.pulls.review.submitted'), color: 'success', duration: 2500 })
    await load() // 服务端不返回新实体，重拉列表呈现新评审
  }
  catch (err) {
    // 403（缺 repo-notes:rw）等：toast 透出服务端原因，不静默吞不登出
    toast.add({
      title: t('repo.pulls.review.submitFailed'),
      description: (err as Error)?.message || '',
      color: 'error',
      duration: 6000,
    })
  }
  finally {
    submitting.value = false
  }
}

// ---------------------------------------------------------------------------
// 评审人管理（手输用户名，P0 无成员端点时的 creatable 方案延续到 P1）
// ---------------------------------------------------------------------------

const reviewerInput = ref('') // 手输框原始文本（回车或按钮提交时才解析）
const reviewerBusy = ref(false) // 增删请求进行中（两处按钮共用，防并发写）

/** 规范化输入：逗号/空格分隔多用户，去空去重 */
function parseReviewers(text: string): string[] {
  // 中文逗号也支持（输入法常态）；Set 去重避免同一用户提交两次
  return [...new Set(text.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean))]
}

/** 添加评审人：POST /reviewers（201 api.Pull → cnbFetch），成功后清输入 */
async function addReviewers() {
  const list = parseReviewers(reviewerInput.value)
  // 空列表（全是分隔符）或已在请求中：直接返回
  if (list.length === 0 || reviewerBusy.value) {
    return
  }
  reviewerBusy.value = true
  try {
    await addPullReviewers(props.repoPath, props.number, list)
    reviewerInput.value = '' // 成功清空输入框，便于连续添加下一批
    toast.add({ title: t('repo.pulls.review.added'), color: 'success', duration: 2500 })
  }
  catch (err) {
    // 失败保留输入框内容，便于修正后重试
    toast.add({
      title: t('repo.pulls.review.addFailed'),
      description: (err as Error)?.message || '',
      color: 'error',
      duration: 6000,
    })
  }
  finally {
    reviewerBusy.value = false
  }
}

/** 移除评审人：DELETE /reviewers（200 api.Pull → cnbFetch，带 body） */
async function removeReviewer(username: string) {
  // 用户名解析失败（空）或已在请求中：忽略
  if (!username || reviewerBusy.value) {
    return
  }
  reviewerBusy.value = true
  try {
    await removePullReviewers(props.repoPath, props.number, [username])
    toast.add({ title: t('repo.pulls.review.removed'), color: 'success', duration: 2000 })
  }
  catch (err) {
    toast.add({
      title: t('repo.pulls.review.removeFailed'),
      description: (err as Error)?.message || '',
      color: 'error',
      duration: 6000,
    })
  }
  finally {
    reviewerBusy.value = false
  }
}

// ---------------------------------------------------------------------------
// 回复行级评论
// ---------------------------------------------------------------------------

const replyOpen = ref(false)
/** 回复目标（顶层评论；回复挂在它下面） */
const replyTarget = ref<ReviewComment | null>(null)
const replyDraft = ref('') // 回复正文草稿
const replying = ref(false) // 提交中（按钮 loading，防重复）

/**
 * 打开回复弹窗：同时用 openReviewComment 写路由键（review + rcomment）——
 * 被回复的顶层评论成为"定位目标"，深链可直达该线程。
 */
function openReply(reviewId: string, comment: ReviewComment) {
  replyTarget.value = comment // 记录回复目标（提交时按它的 id 构造 reply_to）
  replyDraft.value = ''
  replyOpen.value = true
  repoRoute.openReviewComment(reviewId, comment.id) // 展开态路由化（遗留②）
}

/**
 * 提交回复：POST /replies（201 实体 → cnbFetch）。
 * 成功后本地把回复插入对应线程（不重拉整棵评论树，避免丢失展开态）。
 */
async function submitReply() {
  const target = replyTarget.value
  // 无目标 / 空正文 / 提交中：直接返回（按钮 disabled，双保险）
  if (!target || !replyDraft.value.trim() || replying.value) {
    return
  }
  replying.value = true
  try {
    const created = await replyReviewComment(
      props.repoPath,
      props.number,
      activeReviewId.value, // 回复必须挂在当前展开的评审下
      { body: replyDraft.value.trim(), replyToCommentId: target.id },
    )
    // 本地插入而非重拉：保住线程展开态与滚动位置（重拉会回到收起态）
    const existing = threadsMap.value[activeReviewId.value] || []
    threadsMap.value = {
      ...threadsMap.value,
      [activeReviewId.value]: existing.map(thread =>
        thread.root.id === target.id
          ? { ...thread, replies: [...thread.replies, created] } // 追加到目标线程末尾
          : thread,
      ),
    }
    replyOpen.value = false
    replyDraft.value = ''
    toast.add({ title: t('repo.pulls.review.replied'), color: 'success', duration: 2000 })
  }
  catch (err) {
    // 失败保留草稿（replyDraft 不动），透出服务端原因
    toast.add({
      title: t('repo.pulls.review.replyFailed'),
      description: (err as Error)?.message || '',
      color: 'error',
      duration: 6000,
    })
  }
  finally {
    replying.value = false
  }
}

/** 行级评论的位置描述：line 类型带文件+行号，file 类型只显示文件 */
function commentLocation(comment: ReviewComment): string {
  // 整文件评论：无行号可定位
  if (comment.subjectType === 'file') {
    return comment.path
  }
  // 行区间：单行只显示一个号，多行显示 start-end
  const range = comment.startLine === comment.endLine
    ? String(comment.startLine)
    : `${comment.startLine}-${comment.endLine}`
  return `${comment.path}:${range}`
}

/**
 * PR/仓库变化 → 重拉评审列表。
 * 注意**不**清路由键：activeReviewId 是路由派生值，旧 review id 不在新 PR 的
 * 列表里时自然不匹配任何卡片（收起态）；清键需要 router 导航，在 watch 里
 * 导航易与本次变更竞态，收益为零。
 */
watch(() => `${props.repoPath}|${props.number}`, () => {
  threadsMap.value = {}
  void load()
}, { immediate: true })

/** 是否有评审记录（空态判定；加载中/出错时由前面的分支先行接管） */
const hasReviews = computed(() => reviews.value.length > 0)
</script>

<template>
  <section class="mt-4 border border-default rounded-lg p-4 flex flex-col gap-3">
    <header class="flex items-center gap-2 flex-wrap">
      <UIcon name="i-lucide-clipboard-check" class="size-4 text-muted" />
      <h3 class="text-sm font-semibold text-highlighted">
        {{ t('repo.pulls.review.title') }}
      </h3>
      <UBadge
        v-if="reviews.length"
        color="neutral"
        variant="subtle"
        size="sm"
        :label="String(reviews.length)"
      />
      <!-- 三档评审入口：canEdit（open + repo-pr:rw）才渲染，事前隐藏不事后 403 -->
      <div v-if="canEdit" class="ms-auto flex items-center gap-1">
        <UButton
          size="xs"
          color="success"
          variant="soft"
          icon="i-lucide-check"
          :label="t('repo.pulls.review.approve')"
          @click="openReviewModal('approve')"
        />
        <UButton
          size="xs"
          color="error"
          variant="soft"
          icon="i-lucide-x"
          :label="t('repo.pulls.review.requestChanges')"
          @click="openReviewModal('request_changes')"
        />
        <UButton
          size="xs"
          color="neutral"
          variant="soft"
          icon="i-lucide-message-square"
          :label="t('repo.pulls.review.comment')"
          @click="openReviewModal('comment')"
        />
      </div>
    </header>

    <!-- 评审人管理：手输用户名（逗号/空格分隔），增删都需 repo-pr:rw -->
    <div v-if="canEdit" class="flex items-center gap-2 flex-wrap">
      <UInput
        v-model="reviewerInput"
        size="sm"
        class="w-64"
        :placeholder="t('repo.pulls.review.reviewerPlaceholder')"
        @keydown.enter="addReviewers"
      />
      <UButton
        size="sm"
        color="neutral"
        variant="soft"
        icon="i-lucide-user-plus"
        :loading="reviewerBusy"
        :disabled="!reviewerInput.trim()"
        :label="t('repo.pulls.review.addReviewer')"
        @click="addReviewers"
      />
      <UButton
        v-if="reviewerInput.trim()"
        size="sm"
        color="error"
        variant="ghost"
        icon="i-lucide-user-minus"
        :label="t('repo.pulls.review.removeReviewer')"
        @click="removeReviewer(parseReviewers(reviewerInput)[0] || '')"
      />
    </div>

    <!-- 错误 / 加载 / 空态：区块级降级，不影响 PR 主体（G2） -->
    <p v-if="loadError" class="text-xs text-error">
      {{ loadError }}
    </p>
    <p v-else-if="loading" class="text-xs text-dimmed">
      {{ t('common.loading') }}
    </p>
    <p v-else-if="!hasReviews" class="text-xs text-dimmed">
      {{ t('repo.pulls.review.empty') }}
    </p>

    <!-- 评审列表 -->
    <div v-else class="flex flex-col gap-2">
      <article
        v-for="review in reviews"
        :key="review.id"
        class="border border-default rounded-md"
      >
        <!-- 卡头：整行可点切换展开（写 ?review=，浏览器返回键可回退） -->
        <button
          type="button"
          class="w-full flex items-center gap-2 p-2 text-left"
          @click="toggleReview(review.id)"
        >
          <UBadge
            :color="stateColor(review.state)"
            variant="subtle"
            size="sm"
            :label="stateLabel(review.state)"
          />
          <span class="text-sm text-highlighted">{{ review.author || '-' }}</span>
          <span class="text-xs text-dimmed truncate">{{ review.body }}</span>
          <UIcon
            :name="activeReviewId === review.id ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
            class="size-4 text-dimmed ms-auto shrink-0"
          />
        </button>

        <!-- 展开：评审正文 + 行级评论树（深链 ?review= 时由 watch 自动展开到这里） -->
        <div v-if="activeReviewId === review.id" class="px-2 pb-2 flex flex-col gap-2">
          <p v-if="review.body" class="text-xs text-muted whitespace-pre-wrap">
            {{ review.body }}
          </p>
          <p v-if="commentsLoading[review.id]" class="text-xs text-dimmed">
            {{ t('common.loading') }}
          </p>
          <p v-else-if="!(threadsMap[review.id] || []).length" class="text-xs text-dimmed">
            {{ t('repo.pulls.review.noComments') }}
          </p>
          <div v-else class="flex flex-col gap-2">
            <!-- 线程：顶层评论 + 缩进回复。
                 每个线程带 rcomment-{id} 锚点：?rcomment= 深链恢复时滚动到此；
                 命中定位目标的线程加高亮底色，让"URL 指到哪条"可见。 -->
            <div
              v-for="thread in threadsMap[review.id]"
              :id="`rcomment-${thread.root.id}`"
              :key="thread.root.id"
              class="border-s-2 border-default ps-2 flex flex-col gap-1 rounded"
              :class="thread.root.id === activeCommentId ? 'bg-elevated/60' : ''"
            >
              <div class="text-xs font-mono text-dimmed">
                {{ commentLocation(thread.root) }}
              </div>
              <p class="text-xs text-muted whitespace-pre-wrap">
                {{ thread.root.body }}
              </p>
              <div
                v-for="reply in thread.replies"
                :key="reply.id"
                class="border-s-2 border-default ps-2 text-xs text-muted whitespace-pre-wrap"
              >
                {{ reply.body }}
              </div>
              <UButton
                v-if="canEdit"
                size="xs"
                color="neutral"
                variant="ghost"
                icon="i-lucide-reply"
                :label="t('repo.pulls.review.reply')"
                class="self-start"
                @click="openReply(review.id, thread.root)"
              />
            </div>
          </div>
        </div>
      </article>
    </div>

    <!-- 提交评审弹窗 -->
    <UModal v-model:open="reviewModalOpen" :title="t('repo.pulls.review.submitTitle')">
      <template #body>
        <div class="flex flex-col gap-3">
          <!-- 按档位给出不同提示：批准/请求修改/评论的语义差异在这里讲清楚 -->
          <p class="text-xs text-dimmed">
            {{ reviewEvent === 'approve'
              ? t('repo.pulls.review.approveHint')
              : reviewEvent === 'request_changes'
                ? t('repo.pulls.review.requestChangesHint')
                : t('repo.pulls.review.commentHint') }}
          </p>
          <UTextarea
            v-model="reviewBody"
            :rows="4"
            autoresize
            class="w-full"
            :placeholder="t('repo.pulls.review.bodyPlaceholder')"
          />
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2 w-full">
          <UButton
            color="neutral"
            variant="ghost"
            :label="t('common.cancel')"
            @click="reviewModalOpen = false"
          />
          <!-- 请求修改必须有理由：空正文时禁用提交，避免作者收到"无内容"的驳回 -->
          <UButton
            color="primary"
            :loading="submitting"
            :disabled="reviewEvent === 'request_changes' && !reviewBody.trim()"
            :label="t('repo.pulls.review.submit')"
            @click="submitReview"
          />
        </div>
      </template>
    </UModal>

    <!-- 回复弹窗 -->
    <UModal v-model:open="replyOpen" :title="t('repo.pulls.review.reply')">
      <template #body>
        <UTextarea
          v-model="replyDraft"
          :rows="3"
          autoresize
          class="w-full"
          :placeholder="t('repo.pulls.review.replyPlaceholder')"
        />
      </template>
      <template #footer>
        <div class="flex justify-end gap-2 w-full">
          <UButton
            color="neutral"
            variant="ghost"
            :label="t('common.cancel')"
            @click="replyOpen = false"
          />
          <UButton
            color="primary"
            :loading="replying"
            :disabled="!replyDraft.trim()"
            :label="t('common.send')"
            @click="submitReply"
          />
        </div>
      </template>
    </UModal>
  </section>
</template>
