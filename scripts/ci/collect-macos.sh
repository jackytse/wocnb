#!/usr/bin/env bash
# =============================================================================
# WOCNB · macOS 安装包整理（collect-artifacts.sh 的薄封装）
#
# ⚠️【未实测】属 P2 链路，从未在真实 macOS 自托管节点上执行过（只做过语法检查）。
#   启用前必须先空跑验证（见 .cnb.yml 文件末尾声明）。
#
# 用途：在自托管 macOS 构建节点上，把 `tauri build --target <triple> --bundles dmg`
#       产出的 .dmg 搬到 release/ 并重命名为 wocnb-<版本>-macos-<架构>.dmg。
#
# 用法：
#   scripts/ci/collect-macos.sh <rust target triple> <架构名>
#   scripts/ci/collect-macos.sh x86_64-apple-darwin x64
#   scripts/ci/collect-macos.sh aarch64-apple-darwin arm64
#
# 产物路径（Tauri 约定）：src-tauri/target/<triple>/release/bundle/dmg/*.dmg
# =============================================================================
set -euo pipefail

TRIPLE="${1:?用法：collect-macos.sh <rust target triple> <架构名>，如 x86_64-apple-darwin x64}"
ARCH="${2:?用法：collect-macos.sh <rust target triple> <架构名>，如 x86_64-apple-darwin x64}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

exec bash "${SCRIPT_DIR}/collect-artifacts.sh" \
  --platform macos \
  --arch "$ARCH" \
  --triple "$TRIPLE" \
  --bundle-dir dmg \
  --glob '*.dmg' \
  --ext dmg \
  --suffix '' \
  --out release
