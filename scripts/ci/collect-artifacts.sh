#!/usr/bin/env bash
# =============================================================================
# WOCNB · 原生安装包收集整理（通用脚本）
#
# ⚠️【未实测】本脚本属于 P2/P3（macOS / Windows 自托管节点）链路，
#   从未在真实自托管节点上执行过，只在沙箱里用假产物验证过「匹配 + 改名 + 落盘」逻辑。
#   真机上的失败点未被覆盖（Xcode / MSVC、rustup target、bundle 目录结构差异等）。
#   启用 P2/P3 前必须先做一次空跑验证（见 .cnb.yml 文件末尾的声明）。
#
# 用途：把 `tauri build` 产出的安装包从 target 目录搬运到 release/，并按统一命名规范重命名：
#         wocnb-<版本>-<平台>-<架构><后缀>.<扩展名>
#       例：wocnb-0.1.0-macos-arm64.dmg / wocnb-0.1.0-windows-x64-setup.exe
#       供 CNB 流水线 release-macos / release-windows 的 build-* 阶段使用。
#
# 用法：
#   scripts/ci/collect-artifacts.sh --platform <macos|windows> --arch <x64|arm64> \
#       --triple <rust target triple> --bundle-dir <dmg|nsis> --glob '<匹配表达式>' \
#       --ext <dmg|exe> [--suffix <'-setup'>] [--out release] [--version VER]
#
# 示例（macOS x86_64）：
#   scripts/ci/collect-artifacts.sh --platform macos --arch x64 \
#     --triple x86_64-apple-darwin --bundle-dir dmg --glob '*.dmg' --ext dmg
#
# 示例（Windows arm64）：
#   scripts/ci/collect-artifacts.sh --platform windows --arch arm64 \
#     --triple aarch64-pc-windows-msvc --bundle-dir nsis --glob '*-setup.exe' \
#     --ext exe --suffix '-setup'
#
# 匹配到多个文件时取「最新修改」的那个并打印警告（Tauri 有时会同时留下 .app 与中间产物）；
# 一个都没匹配到时直接失败（宁可失败也不发出缺包的 Release）。
# =============================================================================
set -euo pipefail

PLATFORM=""
ARCH=""
TRIPLE=""
BUNDLE_DIR=""
GLOB=""
EXT=""
SUFFIX=""
OUT_DIR="release"
VERSION=""

while [ $# -gt 0 ]; do
  case "$1" in
    # 注意：一律用 `${2?...}`（仅“未设置”时报错）而不是 `${2:?...}`（空串也报错），
    # 因为 --suffix 允许显式传空串（macOS 没有 -setup 后缀）
    --platform)   PLATFORM="${2?--platform 需要一个值}";     shift 2 ;;
    --arch)       ARCH="${2?--arch 需要一个值}";             shift 2 ;;
    --triple)     TRIPLE="${2?--triple 需要一个值}";         shift 2 ;;
    --bundle-dir) BUNDLE_DIR="${2?--bundle-dir 需要一个值}"; shift 2 ;;
    --glob)       GLOB="${2?--glob 需要一个值}";             shift 2 ;;
    --ext)        EXT="${2?--ext 需要一个值}";               shift 2 ;;
    --suffix)     SUFFIX="${2?--suffix 需要一个值}";         shift 2 ;;
    --out)        OUT_DIR="${2?--out 需要一个值}";           shift 2 ;;
    --version)    VERSION="${2?--version 需要一个值}";       shift 2 ;;
    -h|--help)    sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "错误：未知参数 '$1'" >&2; exit 2 ;;
  esac
done

for required in PLATFORM ARCH TRIPLE BUNDLE_DIR GLOB EXT; do
  if [ -z "${!required}" ]; then
    echo "错误：缺少必填参数 --$(printf '%s' "$required" | tr '[:upper:]_' '[:lower:]-')" >&2
    exit 2
  fi
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "$REPO_ROOT"

# ---------------------------------------------------------------------------
# 版本号：显式参数 > $APP_VERSION > tauri.conf.json
# ---------------------------------------------------------------------------
if [ -z "$VERSION" ] && [ -n "${APP_VERSION:-}" ]; then
  VERSION="$APP_VERSION"
fi
if [ -z "$VERSION" ]; then
  CONF="src-tauri/tauri.conf.json"
  if [ -f "$CONF" ]; then
    if command -v node >/dev/null 2>&1; then
      VERSION="$(node -e '
        const fs = require("node:fs");
        const conf = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        process.stdout.write(String(conf.version || ""));
      ' "$CONF")"
    else
      VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$CONF" | head -1)"
    fi
  fi
fi
if [ -z "$VERSION" ]; then
  echo "错误：无法确定版本号，请传入 --version" >&2
  exit 2
fi

SRC_DIR="src-tauri/target/${TRIPLE}/release/bundle/${BUNDLE_DIR}"
if [ ! -d "$SRC_DIR" ]; then
  echo "错误：构建产物目录不存在：${SRC_DIR}" >&2
  echo "      请确认已执行 pnpm exec tauri build --target ${TRIPLE} --bundles ${BUNDLE_DIR}" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 匹配产物文件
# ---------------------------------------------------------------------------
MATCHED=()
shopt -s nullglob
for f in "${SRC_DIR}"/${GLOB}; do
  MATCHED+=("$f")
done
shopt -u nullglob

if [ ${#MATCHED[@]} -eq 0 ]; then
  echo "错误：${SRC_DIR} 下没有匹配 '${GLOB}' 的文件" >&2
  ls -la "$SRC_DIR" >&2 || true
  exit 1
fi
if [ ${#MATCHED[@]} -gt 1 ]; then
  echo "警告：${SRC_DIR} 下匹配到 ${#MATCHED[@]} 个文件，取最新修改的那个：" >&2
  printf '        %s\n' "${MATCHED[@]}" >&2
  # 按修改时间倒序取第一个（GNU/BSD 均支持 ls -t）
  MATCHED=("$(ls -t "${MATCHED[@]}" | head -1)")
fi

SRC_FILE="${MATCHED[0]}"
DEST_NAME="wocnb-${VERSION}-${PLATFORM}-${ARCH}${SUFFIX}.${EXT}"

mkdir -p "$OUT_DIR"
DEST_PATH="${OUT_DIR}/${DEST_NAME}"
cp -f "$SRC_FILE" "$DEST_PATH"

echo "==> 收集安装包：${SRC_FILE}"
echo "    -> ${DEST_PATH}（$(wc -c < "$DEST_PATH" | tr -d ' ') 字节）"
