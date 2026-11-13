<script setup lang="ts">
/**
 * Release 附件只读列表（T07，D1 裁决：上传本轮不做）。
 *
 * 能力：
 * - 展示附件 名称 / 大小 / 哈希（hash_algo: hash_value）；
 * - 下载：**白名单扩展名**（.zip / .tar.gz / .tgz，与 Rust 文件名清洗白名单
 *   一致）→ 走 T02 的 tauriDownload.downloadArchive（Rust 流式落盘，
 *   **绝不走 cnbFetch/cnbFetchText** —— 二进制会被 .text() 破坏）；
 * - 非白名单扩展名（exe/dmg 等）：Rust 侧会拒绝自动落盘可执行文件，
 *   此时不提供应用内下载，改为「在浏览器打开」外跳 browserUrl 兜底；
 * - 上传：本轮不做（D1）—— 只显示一行"上传请到 Web 端"说明 + 外跳，
 *   **不留禁用态按钮**（设计文档 §2.1 明确禁止灰色入口）。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { openUrl } from '@tauri-apps/plugin-opener'
import { releaseAssetApiUrl, type ReleaseAsset, type ReleaseItem } from '../../composables/useCnbReleases'
import { cnbToken } from '../../composables/useCnbAuth'
import { downloadArchive } from '../../utils/tauriDownload'
import { formatBytes } from '../../utils'

const props = defineProps<{
  /** 所属 Release（tagName 用于拼装下载地址兜底） */
  release: ReleaseItem
  repoPath: string
}>()

const { t } = useI18n()
const toast = useToast()

/** 附件列表（空时不渲染容器） */
const assets = computed(() => props.release.assets)

/**
 * 白名单扩展名：与 Rust sanitize_archive_name 的后缀白名单一致。
 * 只有这些类型可以在应用内自动落盘；其余类型外跳浏览器下载。
 */
const ALLOWED_EXTENSIONS = ['.zip', '.tar.gz', '.tgz']

/** 附件是否可应用内下载（后缀在白名单内，大小写不敏感） */
function isDownloadable(asset: ReleaseAsset): boolean {
  const lower = asset.name.toLowerCase()
  return ALLOWED_EXTENSIONS.some(ext => lower.endsWith(ext))
}

/** 附件的展示哈希（algo: value，缺一不可） */
function hashText(asset: ReleaseAsset): string {
  if (asset.hashAlgo && asset.hashValue) {
    return `${asset.hashAlgo}: ${asset.hashValue}`
  }
  return ''
}

// ---------------------------------------------------------------------------
// 下载（Rust 通道）
// ---------------------------------------------------------------------------

/** 正在下载的附件 id 集合（按钮 loading 态） */
const downloadingIds = ref(new Set<string>())

async function onDownload(asset: ReleaseAsset) {
  if (downloadingIds.value.has(asset.id)) {
    return
  }
  downloadingIds.value.add(asset.id)
  try {
    // 下载地址：asset.url（API 域）优先，缺失时按路径规则拼装兜底
    const url = asset.apiUrl || releaseAssetApiUrl(props.repoPath, props.release.tagName, asset.name)
    const result = await downloadArchive(url, asset.name, cnbToken.value)
    // 非 Tauri（浏览器调试）：桌面端专属提示 + 浏览器外跳兜底
    if ('unsupported' in result) {
      toast.add({
        title: t('repo.releases.desktopOnly'),
        color: 'warning',
        duration: 4000,
      })
      if (asset.browserUrl) {
        openInBrowser(asset.browserUrl)
      }
      return
    }
    if (result.ok) {
      toast.add({
        title: t('repo.releases.downloadSuccess'),
        description: result.path,
        color: 'success',
        duration: 6000,
        // 复制路径动作（结果 toast 的辅助操作）
        actions: [{
          label: t('common.copyPath'),
          onClick: () => {
            void navigator.clipboard.writeText(result.path)
          },
        }],
      })
    }
    else {
      // Rust 侧中文错误信息（401 过期 / 403 缺权限 / 404 引用不存在）直接透出
      toast.add({
        title: t('repo.releases.downloadFailed'),
        description: result.message,
        color: 'error',
        duration: 6000,
      })
    }
  }
  finally {
    downloadingIds.value.delete(asset.id)
  }
}

/** 在系统浏览器打开（非 Tauri 环境兜底 window.open） */
function openInBrowser(url: string) {
  if (!url) {
    return
  }
  if ('__TAURI_INTERNALS__' in window) {
    void openUrl(url)
  }
  else {
    window.open(url, '_blank')
  }
}

/** Web 端上传入口（D1：上传延后，外跳 Release 编辑页） */
const webReleaseUrl = computed(() =>
  `https://cnb.cool/${props.repoPath}/-/releases`,
)
</script>

<template>
  <!-- 无附件：一行说明占位（不渲染整个区块容器） -->
  <div v-if="assets.length === 0" class="text-xs text-dimmed">
    {{ t('repo.releases.noAssets') }}
  </div>

  <div v-else class="flex flex-col gap-2">
    <h3 class="text-sm font-semibold text-highlighted flex items-center gap-1.5">
      <UIcon name="i-lucide-paperclip" class="size-4 text-muted" />
      {{ t('repo.releases.assets') }}
      <UBadge
        color="neutral"
        variant="subtle"
        size="sm"
        :label="String(assets.length)"
      />
    </h3>

    <div class="flex flex-col border border-default rounded-lg divide-y divide-default overflow-hidden">
      <div
        v-for="asset in assets"
        :key="asset.id || asset.name"
        class="flex items-center gap-3 px-4 py-2.5"
      >
        <UIcon name="i-lucide-file-archive" class="size-4 text-muted shrink-0" />
        <div class="flex-1 min-w-0">
          <p class="text-sm text-highlighted truncate">
            {{ asset.name }}
          </p>
          <p class="mt-0.5 text-xs text-dimmed flex items-center gap-3 flex-wrap">
            <span>{{ formatBytes(asset.size) }}</span>
            <span v-if="hashText(asset)" class="font-mono break-all">{{ hashText(asset) }}</span>
          </p>
        </div>
        <!-- 下载：白名单扩展名走 Rust 通道；其余外跳浏览器 -->
        <UButton
          v-if="isDownloadable(asset)"
          size="xs"
          color="neutral"
          variant="soft"
          icon="i-lucide-download"
          :loading="downloadingIds.has(asset.id)"
          :label="t('repo.releases.downloadAsset')"
          @click="onDownload(asset)"
        />
        <UButton
          v-else
          size="xs"
          color="neutral"
          variant="ghost"
          icon="i-lucide-external-link"
          :label="t('repo.releases.openInBrowser')"
          @click="openInBrowser(asset.browserUrl)"
        />
      </div>
    </div>

    <!-- 上传延后说明（D1 裁决：只留说明 + 外跳，绝不做禁用态按钮） -->
    <div class="flex items-center gap-2 text-xs text-dimmed">
      <UIcon name="i-lucide-info" class="size-3.5 shrink-0" />
      <span>{{ t('repo.releases.assetUploadDeferred') }}</span>
      <UButton
        size="xs"
        color="neutral"
        variant="ghost"
        icon="i-lucide-external-link"
        :label="t('repo.releases.uploadInWeb')"
        @click="openInBrowser(webReleaseUrl)"
      />
    </div>
  </div>
</template>
