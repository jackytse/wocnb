# =============================================================================
# WOCNB - Windows 热更新清单发布（updater-manifest Release 的 latest.json 合并写入）
#
# 背景（2026-11-19，Windows 热更新链路）：
#   macOS 线在 release-macos 的 publish-manifest 阶段生成并上传 latest.json
#   （此前只有 darwin-aarch64 条目）。Windows 线现在也能产出 NSIS 安装包 +
#   .sig 签名（64 位 makensis 装配解锁，见 .cnb.yml build-x64 注释），需要在
#   自己的流水线末尾把 windows-x86_64 条目合并进同一份清单。
#
# 合并策略（双向防覆盖）：
#   1) 下载现网 updater-manifest Release 的 latest.json（匿名可读）；
#   2) version 与本次一致 → 保留其 platforms 里已有的其他条目（darwin-*）；
#      version 不同（上一版本的旧清单）→ 只发 windows 条目；
#      下载失败（首次发版/网络）→ 只发 windows 条目；
#   3) 写入/覆盖 windows-x86_64 条目 → 上传（只上传不删除，与 macOS 同构）。
#   时序假设：Windows build-x64 耗时远大于 macOS 全流水线（实测 ~11min vs
#   ~2min），Windows 合并时现网清单几乎必然已是本次版本；macOS 端
#   collect-updater-macos.sh 也有对称的合并逻辑兜底反向竞态。
#
# 用法：
#   powershell -NoProfile -File scripts\ci\publish-manifest-windows.ps1 -Dir .\release
#   （-Dir 指向 collect-windows.ps1 的产物目录，从中读 *-setup.exe.sig）
#
# 必需环境变量（CNB 流水线内置）：CNB_TOKEN / CNB_BRANCH / CNB_REPO_SLUG_LOWERCASE
# =============================================================================
param(
    [string]$Dir = 'release'
)

$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 默认不启用 TLS 1.2，访问 https 接口会失败
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = (Resolve-Path (Join-Path $ScriptDir '..\..')).Path
$dirPath = if ([System.IO.Path]::IsPathRooted($Dir)) { $Dir } else { Join-Path $RepoRoot $Dir }

# ---------------------------------------------------------------------------
# 1) 解析版本号（与 collect-windows.ps1 同口径：APP_VERSION > tauri.conf.json）
# ---------------------------------------------------------------------------
$Version = $env:APP_VERSION
if ([string]::IsNullOrWhiteSpace($Version)) {
    $confPath = Join-Path $RepoRoot 'src-tauri\tauri.conf.json'
    if (-not (Test-Path $confPath)) { throw "找不到 $confPath" }
    $Version = [string]((Get-Content -Raw -Path $confPath | ConvertFrom-Json).version)
}
if ([string]::IsNullOrWhiteSpace($Version)) { throw '无法确定版本号' }

# ---------------------------------------------------------------------------
# 2) 定位本次 NSIS 产物的签名文件
#    命名规范见 collect-windows.ps1：wocnb-<版本>-windows-<架构>-setup.exe.sig
#    签名缺失（三级降级到裸 exe / msi 时）→ 跳过发布并成功退出：
#    该场景 Windows 本就不参与热更新，manifest 维持 macOS-only 是正确状态。
# ---------------------------------------------------------------------------
$sigPath = Get-ChildItem -Path $dirPath -Filter '*.sig' -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like 'wocnb-*-setup.exe.sig' } |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $sigPath) {
    # 区分两种「没有 .sig」：真的没安装包（裸 exe/msi 降级，本该跳过）vs
    # 有安装包却漏收签名（收集脚本 bug，必须报错）。rc.42 实测踩过后者：
    # collect-windows.ps1 把 .sig 路径拼成 ...\setup.exe\setup.exe.sig，
    # 收集静默失败，本脚本也静默跳过 → 构建全绿但 Windows 热更新不生效。
    $setupExe = Get-ChildItem -Path $dirPath -Filter 'wocnb-*-setup.exe' -File -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($setupExe) {
        throw "发现安装包 $($setupExe.Name) 却没有对应的 .sig —— 热更新清单会静默缺 windows-x86_64 条目，按失败处理（请检查 collect-windows.ps1 的签名收集路径）"
    }
    Write-Host '==> 未找到 setup 安装包（走了裸 exe/msi 降级链路），跳过 windows-x86_64 清单发布'
    exit 0
}
$signature = (Get-Content -Raw -Path $sigPath.FullName).Trim()
$assetName = [System.IO.Path]::GetFileNameWithoutExtension($sigPath.FullName)   # 去掉 .sig → setup.exe 文件名
$assetUrl  = "https://cnb.cool/jackytse/wocnb/-/releases/download/v$Version/$assetName"
Write-Host "==> 签名文件：$($sigPath.Name)"
Write-Host "==> 更新包 URL：$assetUrl"

# ---------------------------------------------------------------------------
# 3) 下载现网清单（匿名；带重试）
#    ⚠️ 这一步绝不能"失败即当空清单"：DNS 抖动一次就误判为空 → 覆盖上传
#    会静默丢掉 darwin-* 条目（比上传失败更危险的静默故障）。3 次重试后
#    仍失败才按空清单处理（此时大概率真的是首次发版/清单服务异常）。
# ---------------------------------------------------------------------------
$existing = $null
for ($dl = 1; $dl -le 3; $dl++) {
    try {
        $resp = Invoke-WebRequest -UseBasicParsing -Uri 'https://cnb.cool/jackytse/wocnb/-/releases/download/updater-manifest/latest.json' -TimeoutSec 60
        $existing = $resp.Content | ConvertFrom-Json
        Write-Host "==> 现网清单 version: $($existing.version)"
        break
    }
    catch {
        Write-Host "==> 现网清单下载第 $dl/3 次失败：$($_.Exception.Message)"
        if ($dl -lt 3) { Start-Sleep -Seconds 5 }
    }
}
if ($null -eq $existing) {
    Write-Host '==> 现网清单重试后仍不可达（首次发版或网络异常），按空清单处理'
}

# ---------------------------------------------------------------------------
# 4) 组装新清单：version 相同 → 保留其他平台条目（防互相覆盖丢 darwin 条目）
# ---------------------------------------------------------------------------
$platforms = New-Object PSObject
if ($null -ne $existing -and $existing.version -eq $Version) {
    foreach ($prop in $existing.platforms.PSObject.Properties) {
        # 跳过本条目自身（下方强制写入最新值）与 darwin 条目保留
        if ($prop.Name -ne 'windows-x86_64') {
            $platforms | Add-Member -MemberType NoteProperty -Name $prop.Name -Value $prop.Value
        }
    }
}
$winEntry = New-Object PSObject
$winEntry | Add-Member -MemberType NoteProperty -Name 'signature' -Value $signature
$winEntry | Add-Member -MemberType NoteProperty -Name 'url' -Value $assetUrl
$platforms | Add-Member -MemberType NoteProperty -Name 'windows-x86_64' -Value $winEntry

$manifest = New-Object PSObject
$manifest | Add-Member -MemberType NoteProperty -Name 'version' -Value $Version
$manifest | Add-Member -MemberType NoteProperty -Name 'notes' -Value "WOCNB v$Version"
# pub_date：UTC RFC 3339（updater 用它展示/排序）
$manifest | Add-Member -MemberType NoteProperty -Name 'pub_date' -Value ((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))
$manifest | Add-Member -MemberType NoteProperty -Name 'platforms' -Value $platforms

# ---------------------------------------------------------------------------
# 5) 写独立临时目录 + 上传到 updater-manifest Release
#    （不能写进 release\ —— release-upload.ps1 会把该目录全部文件上传）
# ---------------------------------------------------------------------------
$outDir = Join-Path $RepoRoot 'manifest-out'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
Remove-Item (Join-Path $outDir '*') -Force -ErrorAction SilentlyContinue
$manifestPath = Join-Path $outDir 'latest.json'
$manifest | ConvertTo-Json -Depth 10 | Set-Content -Path $manifestPath -Encoding ascii
Write-Host "==> 新清单内容："
Get-Content $manifestPath | ForEach-Object { Write-Host "    $_" }

# 覆盖流水线注入的目标 tag（v0.1.0-rc.N → updater-manifest 固定 Release）
$env:CNB_BRANCH = 'updater-manifest'
powershell -NoProfile -File (Join-Path $ScriptDir 'release-upload.ps1') -Dir $outDir
if ($LASTEXITCODE) { exit $LASTEXITCODE }

# ---------------------------------------------------------------------------
# 6) 上传后回读自校验：windows-x86_64 必须在列（防上传竞态静默丢条目）
#    回读带 3 次重试（rc.48 实测 asset.cnb.cool DNS 抖动会让单次回读失败
#    被误判为"竞态覆盖"，实际清单可能已正常落库）
# ---------------------------------------------------------------------------
Start-Sleep -Seconds 5
$checkManifest = $null
for ($i = 1; $i -le 3; $i++) {
    try {
        $check = Invoke-WebRequest -UseBasicParsing -Uri 'https://cnb.cool/jackytse/wocnb/-/releases/download/updater-manifest/latest.json' -TimeoutSec 60
        $checkManifest = $check.Content | ConvertFrom-Json
        break
    }
    catch {
        Write-Host "==> 自校验回读第 $i/3 次失败：$($_.Exception.Message)"
        if ($i -lt 3) { Start-Sleep -Seconds 10 }
    }
}
if ($null -eq $checkManifest) {
    throw '自校验失败：清单回读 3 次均失败（网络/CDN 异常），无法确认 windows-x86_64 条目是否落库'
}
if ($null -eq $checkManifest.platforms.'windows-x86_64') {
    throw '自校验失败：上传后回读清单仍无 windows-x86_64 条目（疑似与 macOS publish-manifest 竞态互相覆盖）'
}
Write-Host '==> 自校验通过：windows-x86_64 条目已在 updater-manifest 清单中'
Write-Host ("    平台条目：" + (($checkManifest.platforms.PSObject.Properties.Name) -join ', '))
