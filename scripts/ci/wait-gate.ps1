# =============================================================================
# wait-gate.ps1 - Windows 发版流水线门禁等待脚本（release-windows 用）
#
# 解决什么问题：tag_push 同时触发三条并行流水线，CNB 不支持流水线间依赖
# 编排；release-meta 门禁（typecheck/lint/test）失败后 mac/windows 仍会
# 空跑编译（rc.46 实测空耗近 10 分钟）。本脚本作为 release-windows 的
# 第一个 stage（install 之前）：轮询同构建（同 sn）的 release-meta 状态：
#   success -> exit 0 继续构建；error/cancel -> exit 1 立即终止本流水线。
# 超时（默认 900s）按失败终止，宁可误杀也不挂死节点。
#
# 依赖 CNB 内置变量：CNB_API_ENDPOINT / CNB_REPO_SLUG / CNB_BUILD_ID(=sn)
# / CNB_TOKEN（临时令牌，可信事件含 repo-cnb-detail:r 构建详情读权限）。
#
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts/ci/wait-gate.ps1
# （目标流水线名默认 release-meta，可用 -TargetPipeline 覆盖）
#
# !!! 本文件必须保存为 UTF-8 with BOM：Windows PowerShell 5.1 读无 BOM
# 文件按 GBK 解码，中文注释会吃掉后续引号引发级联语法错误（rc.20 教训）。
# =============================================================================
param([string]$TargetPipeline = "release-meta")

# 逐段探测而非一条命令：任何变量缺失时给出可读错误，而非拼出畸形 URL
if (-not $env:CNB_API_ENDPOINT) { Write-Output "[wait-gate] 缺少 CNB_API_ENDPOINT"; exit 1 }
if (-not $env:CNB_REPO_SLUG) { Write-Output "[wait-gate] 缺少 CNB_REPO_SLUG"; exit 1 }
if (-not $env:CNB_BUILD_ID) { Write-Output "[wait-gate] 缺少 CNB_BUILD_ID"; exit 1 }

$apiUrl = "${env:CNB_API_ENDPOINT}/${env:CNB_REPO_SLUG}/-/build/status/${env:CNB_BUILD_ID}"
$timeoutSec = 900
$intervalSec = 10
$deadline = (Get-Date).AddSeconds($timeoutSec)

Write-Output "[wait-gate] waiting for gate pipeline '$TargetPipeline' (build ${env:CNB_BUILD_ID}, max ${timeoutSec}s)"

while ($true) {
    try {
        # Bearer 临时令牌（可信事件含 repo-cnb-detail:r，够查构建状态）
        $resp = Invoke-RestMethod -Uri $apiUrl -Method Get `
            -Headers @{ Authorization = "Bearer ${env:CNB_TOKEN}" }
        # pipelinesStatus 以 pipelineId 为 key，按 name 匹配目标流水线
        #（不依赖 -001 序号硬编码，数组顺序调整也不失效）
        $status = ''
        $ps = $resp.data.pipelinesStatus
        if ($ps) {
            foreach ($prop in $ps.PSObject.Properties) {
                if ($prop.Value.name -eq $TargetPipeline) {
                    $status = $prop.Value.status
                    break
                }
            }
        }
        switch ($status) {
            'success' {
                Write-Output "[wait-gate] gate passed ($TargetPipeline: success), continue build"
                exit 0
            }
            'error' { Write-Output "[wait-gate] gate FAILED ($TargetPipeline: error), abort this pipeline"; exit 1 }
            'fail' { Write-Output "[wait-gate] gate FAILED ($TargetPipeline: fail), abort this pipeline"; exit 1 }
            'failure' { Write-Output "[wait-gate] gate FAILED ($TargetPipeline: failure), abort this pipeline"; exit 1 }
            'cancel' { Write-Output "[wait-gate] gate canceled ($TargetPipeline), abort this pipeline"; exit 1 }
            'canceled' { Write-Output "[wait-gate] gate canceled ($TargetPipeline), abort this pipeline"; exit 1 }
            'skipped' { Write-Output "[wait-gate] gate skipped ($TargetPipeline), abort this pipeline"; exit 1 }
            '' { Write-Output "[wait-gate] $TargetPipeline status not reported yet, retry in ${intervalSec}s" }
            default { Write-Output "[wait-gate] $TargetPipeline: $status (running), recheck in ${intervalSec}s" }
        }
    }
    catch {
        # 网络抖动/瞬时 5xx 不直接判死：记日志继续重试，由超时兜底
        Write-Output "[wait-gate] API query failed, will retry: $($_.Exception.Message)"
    }
    if ((Get-Date) -ge $deadline) {
        Write-Output "[wait-gate] timeout (${timeoutSec}s) waiting for $TargetPipeline, abort this pipeline"
        exit 1
    }
    Start-Sleep -Seconds $intervalSec
}
