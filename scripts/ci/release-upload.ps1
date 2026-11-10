# =============================================================================
# WOCNB - Release 附件上传（Windows / PowerShell 版）
#
# ⚠️【未实测】属 P3 链路，从未在真实 Windows 自托管节点上执行过（只做过 PowerShell 语法解析）。
#   三段式上传（asset-upload-url -> PUT -> verify）与 release-upload.sh 同构，
#   真机首跑前请先用一个小文件试传。启用前必须先空跑验证（见 .cnb.yml 文件末尾声明）。
#
# 用途：与 scripts/ci/release-upload.sh 完全同构，用于自托管 Windows 节点。
#       把安装包上传到「同一次构建里由 P1 release-meta 创建的那个 Release」，
#       只上传，绝不创建/删除 Release。
#
# 步骤：
#   1) 轮询 GET /{repo}/-/releases/tags/{tag} 直到 Release 出现（默认 120 次 × 10 秒 = 20 分钟）
#   2) 每个文件：POST asset-upload-url -> PUT 字节 -> POST verify_url
#
# 用法：
#   powershell -NoProfile -File scripts\ci\release-upload.ps1 -Dir .\release
#
# 必需环境变量（CNB 流水线内置）：
#   CNB_TOKEN / CNB_BRANCH / CNB_REPO_SLUG_LOWERCASE（回退 CNB_REPO_SLUG）/ CNB_API_ENDPOINT
# =============================================================================
param(
    [string]$Dir = 'release',
    [int]$PollTimes = 120,
    [int]$PollIntervalSec = 10
)

$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 默认不启用 TLS 1.2，访问 https 接口会失败
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# ---------------------------------------------------------------------------
# 0) 环境与入参检查
# ---------------------------------------------------------------------------
if ([string]::IsNullOrWhiteSpace($env:CNB_TOKEN)) { throw '缺少 CNB_TOKEN' }
if ([string]::IsNullOrWhiteSpace($env:CNB_BRANCH)) { throw '缺少 CNB_BRANCH' }

$apiEndpoint = if ([string]::IsNullOrWhiteSpace($env:CNB_API_ENDPOINT)) { 'https://api.cnb.cool' } else { $env:CNB_API_ENDPOINT }
$repoSlug = if ([string]::IsNullOrWhiteSpace($env:CNB_REPO_SLUG_LOWERCASE)) { $env:CNB_REPO_SLUG } else { $env:CNB_REPO_SLUG_LOWERCASE }
if ([string]::IsNullOrWhiteSpace($repoSlug)) { throw '缺少 CNB_REPO_SLUG_LOWERCASE / CNB_REPO_SLUG' }
$repoSlug = $repoSlug.ToLowerInvariant()

$api = "$apiEndpoint/$repoSlug"
$tag = $env:CNB_BRANCH

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path (Join-Path $ScriptDir '..\..')).Path
$dirPath = if ([System.IO.Path]::IsPathRooted($Dir)) { $Dir } else { Join-Path $repoRoot $Dir }

if (-not (Test-Path $dirPath)) { throw "找不到目录：$dirPath" }
$files = @(Get-ChildItem -Path $dirPath -File)
if ($files.Count -eq 0) { throw "目录 $dirPath 下没有文件" }

$headers = @{
    'Authorization' = "Bearer $($env:CNB_TOKEN)"
    'Accept'        = 'application/vnd.cnb.api+json'
}

Write-Host "==> 目标仓库：$repoSlug"
Write-Host "==> 目标 Tag ：$tag"
Write-Host "==> API      ：$api"

# ---------------------------------------------------------------------------
# 1) 轮询等待 Release 出现
# ---------------------------------------------------------------------------
$releaseId = $null
for ($i = 1; $i -le $PollTimes; $i++) {
    try {
        $release = Invoke-RestMethod -Method Get -Uri "$api/-/releases/tags/$tag" -Headers $headers -TimeoutSec 60
        if ($null -ne $release.id) {
            $releaseId = $release.id
            Write-Host "==> 已找到 Release（id=$releaseId），第 $i 次轮询"
            break
        }
    }
    catch {
        if ($i % 6 -eq 0) {
            Write-Host "    等待 Release 出现…（第 $i/$PollTimes 次）：$($_.Exception.Message)" -ForegroundColor DarkGray
        }
    }
    Start-Sleep -Seconds $PollIntervalSec
}

if ($null -eq $releaseId) {
    throw "等待 $($PollTimes * $PollIntervalSec)s 后仍未找到 tag $tag 的 Release（通常意味着 P1 release-meta 失败）"
}

# ---------------------------------------------------------------------------
# 2) 逐个文件上传
# ---------------------------------------------------------------------------
$failed = 0
foreach ($file in $files) {
    $name = $file.Name
    $size = $file.Length
    Write-Host "==> 上传 $name（$size 字节）"

    $body = @{
        asset_name = $name
        size       = $size
        overwrite  = $true
    } | ConvertTo-Json

    try {
        $resp = Invoke-RestMethod -Method Post -Uri "$api/-/releases/$releaseId/asset-upload-url" `
            -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 60
    }
    catch {
        Write-Host "    错误：申请上传地址失败：$($_.Exception.Message)" -ForegroundColor Red
        $failed++
        continue
    }

    if ([string]::IsNullOrWhiteSpace($resp.upload_url) -or [string]::IsNullOrWhiteSpace($resp.verify_url)) {
        Write-Host '    错误：响应中缺少 upload_url / verify_url' -ForegroundColor Red
        $failed++
        continue
    }

    try {
        # PUT 原始字节：用 HttpWebRequest 以免 Invoke-RestMethod 对二进制 body 做序列化
        $req = [System.Net.HttpWebRequest]::Create($resp.upload_url)
        $req.Method = 'PUT'
        $req.ContentType = 'application/octet-stream'
        $req.ContentLength = $size
        $req.Timeout = 600000
        $stream = $req.GetRequestStream()
        $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Close()
        $putResp = $req.GetResponse()
        $putResp.Close()
    }
    catch {
        Write-Host "    错误：上传字节失败：$($_.Exception.Message)" -ForegroundColor Red
        $failed++
        continue
    }

    try {
        Invoke-RestMethod -Method Post -Uri $resp.verify_url -Headers $headers -TimeoutSec 60 | Out-Null
    }
    catch {
        Write-Host "    错误：确认上传失败：$($_.Exception.Message)" -ForegroundColor Red
        $failed++
        continue
    }

    Write-Host '    完成'
}

if ($failed -ne 0) {
    throw "$failed 个附件上传失败"
}

Write-Host "==> 全部 $($files.Count) 个附件上传成功"
