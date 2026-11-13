<script setup lang="ts">
/**
 * 源码包下载菜单（T12，代码页签工具栏入口）。
 *
 * 通道（D2 裁决红线）：二进制 archive **只走** Rust 命令 downloadArchive
 * （utils/tauriDownload 封装），禁止 cnbFetch/cnbFetchText/base64 ——
 * .text() 会按 UTF-8 解码破坏 zip 头。
 *
 * URL 与文件名：
 * - 归档端点 GET /{repo}/-/git/archive/{ref}.{format}（format = zip | tar.gz）；
 *   **ref 含 '/'（feature/x）时整段 encodeURIComponent**（swagger 单 path 段），
 *   格式后缀在编码段之外拼接；
 * - 落盘文件名 `{repoName}-{ref}.{format}`，ref 中的 '/' 替换为 '-'
 *   （Rust 侧 sanitize 只允许 [A-Za-z0-9._-]，防止文件名清洗后歧义）。
 *
 * Secret 仓库：下载按钮置灰 + tooltip（保密仓库不在客户端提供下载入口）。
 * 非 Tauri（浏览器调试）：返回 unsupported → 提示桌面端专属并外跳
 * CNB 网页端下载兜底。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { openUrl } from '@tauri-apps/plugin-opener'
import { CNB_API_BASE, cnbToken } from '../../composables/useCnbAuth'
import { downloadArchive, isTauri } from '../../utils/tauriDownload'
import { repoSiteUrl } from '../../composables/useCnbRepo'

const props = defineProps<{
  repoPath: string
  /** 当前生效 ref（分支/标签/SHA） */
  gitRef: string
  /** 仓库可见性（RepoDetail.visibility，大写三值；Secret 时置灰入口） */
  visibility?: string
}>()

const { t } = useI18n()
const toast = useToast()

/** 支持的归档格式（与 Rust sanitize 白名单一致） */
const FORMATS = [
  { format: 'zip', label: 'ZIP', icon: 'i-lucide-file-archive' },
  { format: 'tar.gz', label: 'TAR.GZ', icon: 'i-lucide-file-archive' },
] as const
type ArchiveFormat = (typeof FORMATS)[number]['format']

/** 仓库显示名（path 尾段） */
const repoName = computed(() => props.repoPath.split('/').pop() || 'repo')

/** Secret 仓库：下载入口置灰（保密仓库不提供客户端下载） */
const isSecret = computed(() => props.visibility === 'Secret')

/** ref 缺省（head 未就绪）时不可下载 */
const refReady = computed(() => !!props.gitRef)

const downloading = ref(false)

/** 归档资源 URL：ref 整段编码，格式后缀在编码段之外（验收口径） */
function archiveUrl(format: ArchiveFormat): string {
  return `${CNB_API_BASE}/${props.repoPath.split('/').map(encodeURIComponent).join('/')}/-/git/archive/${encodeURIComponent(props.gitRef)}.${format}`
}

/** 落盘文件名：ref 内 '/' 替换为 '-'（Rust sanitize 白名单兼容） */
function archiveFileName(format: ArchiveFormat): string {
  const safeRef = props.gitRef.replace(/\//g, '-')
  return `${repoName.value}-${safeRef}.${format}`
}

/** 网页端归档下载地址（非 Tauri / 失败兜底外跳） */
function webArchiveUrl(format: ArchiveFormat): string {
  return repoSiteUrl(props.repoPath, `/-/git/archive/${encodeURIComponent(props.gitRef)}.${format}`)
}

/** 执行下载：成功 toast + 失败透出错误；unsupported 时外跳网页端 */
async function onDownload(format: ArchiveFormat) {
  if (downloading.value || !refReady.value || isSecret.value) {
    return
  }
  downloading.value = true
  try {
    // Bearer 认证：token 从登录态传入（私有仓库下载必需）；仅经 IPC 传给
    // Rust 命令，不进 console/日志（team-lead 二次确认项）
    const result = await downloadArchive(archiveUrl(format), archiveFileName(format), cnbToken.value)
    if ('unsupported' in result) {
      // 浏览器调试环境：桌面端专属，外跳网页端下载兜底
      toast.add({
        title: t('repo.code.downloadDesktopOnly'),
        color: 'warning',
        duration: 4000,
      })
      if (isTauri()) {
        void openUrl(webArchiveUrl(format))
      }
      else {
        window.open(webArchiveUrl(format), '_blank')
      }
    }
    else if (result.ok) {
      toast.add({
        title: t('repo.code.downloadSuccess'),
        description: result.path,
        color: 'success',
        duration: 4000,
      })
    }
    else {
      toast.add({
        title: t('repo.code.downloadFailed'),
        description: result.message,
        color: 'error',
        duration: 6000,
      })
    }
  }
  finally {
    downloading.value = false
  }
}
</script>

<template>
  <!-- Secret 仓库：置灰 + tooltip（保密仓库不在客户端提供下载） -->
  <UTooltip :text="isSecret ? t('repo.code.downloadSecretDisabled') : ''">
    <UDropdownMenu
      :items="FORMATS.map(f => ([{
        label: `${t('repo.code.downloadAs')} ${f.label}`,
        icon: f.icon,
        disabled: !refReady || isSecret,
        onSelect: () => onDownload(f.format),
      }]))"
    >
      <UButton
        size="sm"
        color="neutral"
        variant="outline"
        icon="i-lucide-download"
        :label="t('repo.code.download')"
        :disabled="!refReady || isSecret"
        :loading="downloading"
      />
    </UDropdownMenu>
  </UTooltip>
</template>
