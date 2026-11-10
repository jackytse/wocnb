# =============================================================================
# WOCNB - Windows 安装包整理
#
# ⚠️【未实测】属 P3 链路，从未在真实 Windows 自托管节点上执行过（只做过 PowerShell 语法解析）。
#   真机失败点未被覆盖（MSVC ARM64 工具链、nsis bundle 目录结构差异等）。
#   启用前必须先空跑验证（见 .cnb.yml 文件末尾声明）。
#
# 用途：在自托管 Windows 构建节点上，把 `tauri build --target <triple> --bundles nsis`
#       产出的 *-setup.exe 搬到 release\ 并重命名为
#       wocnb-<版本>-windows-<架构>-setup.exe
#
# 用法：
#   powershell -NoProfile -File scripts\ci\collect-windows.ps1 -Triple x86_64-pc-windows-msvc -Arch x64
#   powershell -NoProfile -File scripts\ci\collect-windows.ps1 -Triple aarch64-pc-windows-msvc -Arch arm64
#
# 产物路径（Tauri 约定）：src-tauri\target\<triple>\release\bundle\nsis\*-setup.exe
# =============================================================================
param(
    [Parameter(Mandatory = $true)][string]$Triple,
    [Parameter(Mandatory = $true)][string]$Arch,
    [string]$OutDir = 'release',
    [string]$Version = ''
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# 0) 定位仓库根目录（脚本位于 scripts\ci\ 下）
# ---------------------------------------------------------------------------
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = (Resolve-Path (Join-Path $ScriptDir '..\..')).Path
Push-Location $RepoRoot
try {
    # ------------------------------------------------------------------
    # 1) 解析版本号：显式参数 > 环境变量 APP_VERSION > tauri.conf.json
    # ------------------------------------------------------------------
    if ([string]::IsNullOrWhiteSpace($Version)) {
        $Version = $env:APP_VERSION
    }
    if ([string]::IsNullOrWhiteSpace($Version)) {
        $confPath = Join-Path $RepoRoot 'src-tauri\tauri.conf.json'
        if (-not (Test-Path $confPath)) {
            throw "找不到 $confPath"
        }
        $conf = Get-Content -Raw -Path $confPath | ConvertFrom-Json
        $Version = [string]$conf.version
    }
    if ([string]::IsNullOrWhiteSpace($Version)) {
        throw '无法确定版本号，请传入 -Version'
    }

    # ------------------------------------------------------------------
    # 2) 匹配构建产物
    # ------------------------------------------------------------------
    $srcDir = Join-Path $RepoRoot "src-tauri\target\$Triple\release\bundle\nsis"
    if (-not (Test-Path $srcDir)) {
        throw "构建产物目录不存在：$srcDir（请确认已执行 tauri build --target $Triple --bundles nsis）"
    }

    $candidates = @(Get-ChildItem -Path $srcDir -Filter '*-setup.exe' -File)
    if ($candidates.Count -eq 0) {
        throw "$srcDir 下没有匹配 '*-setup.exe' 的文件"
    }
    if ($candidates.Count -gt 1) {
        Write-Host "警告：$srcDir 下匹配到 $($candidates.Count) 个安装包，取最新修改的那个" -ForegroundColor Yellow
    }
    $srcFile = $candidates | Sort-Object LastWriteTime -Descending | Select-Object -First 1

    # ------------------------------------------------------------------
    # 3) 复制并按统一命名规范重命名
    # ------------------------------------------------------------------
    $destName = "wocnb-$Version-windows-$Arch-setup.exe"
    $outPath = Join-Path $RepoRoot $OutDir
    New-Item -ItemType Directory -Force -Path $outPath | Out-Null
    $destPath = Join-Path $outPath $destName

    Copy-Item -Path $srcFile.FullName -Destination $destPath -Force

    $size = (Get-Item $destPath).Length
    Write-Host "==> 收集安装包：$($srcFile.FullName)"
    Write-Host "    -> $destPath（$size 字节）"
}
finally {
    Pop-Location
}
