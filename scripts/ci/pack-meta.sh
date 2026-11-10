#!/usr/bin/env bash
# =============================================================================
# WOCNB · 发布元数据制品打包（源码包 + Web 包 + 校验和）
#
# 用途：CNB 流水线 release-meta 的 pack 阶段入口。产出 Release 上「Linux 侧」的三个附件：
#         release/wocnb-<版本>-source.tar.gz     源码包（只含受版本控制的文件）
#         release/wocnb-<版本>-web.tar.gz        前端构建产物（dist/ 内容，可直接静态托管）
#         release/SHA256SUMS-meta.txt            上面两个包的 sha256（两列格式，可用 sha256sum -c 校验）
#
# 用法：
#   scripts/ci/pack-meta.sh [选项]
#     --version <VER>   显式指定版本号（不含 v）
#     --tag <TAG>       用 tag 推导版本号，如 v0.1.0
#     --out <DIR>       产物目录，默认 release
#     --dist <DIR>      前端构建产物目录，默认 dist
#     --ref <REF>       源码包打包的 git 引用，默认 HEAD
#
# 版本号推导顺序：--version > --tag > $APP_VERSION（上游 version-check 导出）>
#                 当前提交精确匹配的 tag > $CNB_BRANCH（v 开头）> 0.0.0-<短 SHA>
#
# 依赖：pnpm build 已执行（dist/ 存在）；git（可选，缺失时退回 tar --exclude）
# =============================================================================
set -euo pipefail

VERSION=""
TAG=""
OUT_DIR="release"
DIST_DIR="dist"
REF="HEAD"

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:?--version 需要一个值}"; shift 2 ;;
    --tag)     TAG="${2:?--tag 需要一个值}";         shift 2 ;;
    --out)     OUT_DIR="${2:?--out 需要一个值}";     shift 2 ;;
    --dist)    DIST_DIR="${2:?--dist 需要一个值}";   shift 2 ;;
    --ref)     REF="${2:?--ref 需要一个值}";         shift 2 ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "错误：未知参数 '$1'" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "$REPO_ROOT"

IS_GIT_REPO="false"
if git rev-parse --git-dir >/dev/null 2>&1; then
  IS_GIT_REPO="true"
fi

# ---------------------------------------------------------------------------
# 1) 解析版本号（与 package-source.sh 保持同一套推导顺序）
# ---------------------------------------------------------------------------
if [ -z "$VERSION" ] && [ -n "$TAG" ]; then
  VERSION="${TAG#v}"
fi
if [ -z "$VERSION" ] && [ -n "${APP_VERSION:-}" ]; then
  VERSION="${APP_VERSION}"
fi
if [ -z "$VERSION" ] && [ "$IS_GIT_REPO" = "true" ]; then
  EXACT_TAG="$(git describe --tags --exact-match "$REF" 2>/dev/null || true)"
  if [ -n "$EXACT_TAG" ]; then
    VERSION="${EXACT_TAG#v}"
  fi
fi
if [ -z "$VERSION" ] && [ -n "${CNB_BRANCH:-}" ]; then
  case "${CNB_BRANCH}" in
    v*) VERSION="${CNB_BRANCH#v}" ;;
  esac
fi
# 回退到 tauri.conf.json 的版本号（本地无 tag、非 CI 场景下的合理默认值）
if [ -z "$VERSION" ] && [ -f "src-tauri/tauri.conf.json" ]; then
  if command -v node >/dev/null 2>&1; then
    VERSION="$(node -e '
      const fs = require("node:fs");
      const conf = JSON.parse(fs.readFileSync("src-tauri/tauri.conf.json", "utf8"));
      process.stdout.write(String(conf.version || ""));
    ' 2>/dev/null || true)"
  else
    VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "src-tauri/tauri.conf.json" | head -1)"
  fi
fi
if [ -z "$VERSION" ] && [ "$IS_GIT_REPO" = "true" ]; then
  SHORT_SHA="$(git rev-parse --short "$REF" 2>/dev/null || true)"
  if [ -n "$SHORT_SHA" ]; then
    VERSION="0.0.0-${SHORT_SHA}"
  fi
fi
if [ -z "$VERSION" ]; then
  echo "错误：无法推导版本号，请显式传入 --version 或 --tag" >&2
  exit 2
fi

echo "==> 发布元数据打包：版本 ${VERSION}"

mkdir -p "$OUT_DIR"
OUT_ABS="$(cd "$OUT_DIR" && pwd)"
SUMS_PATH="${OUT_ABS}/SHA256SUMS-meta.txt"

# 每次重跑都从干净的校验文件开始，避免历史行残留
rm -f "$SUMS_PATH"

# ---------------------------------------------------------------------------
# 2) 源码包（复用 package-source.sh，校验和直接写入 SHA256SUMS-meta.txt）
# ---------------------------------------------------------------------------
bash "${SCRIPT_DIR}/package-source.sh" \
  --version "$VERSION" \
  --ref "$REF" \
  --out "$OUT_ABS" \
  --sums-name "SHA256SUMS-meta.txt"

# ---------------------------------------------------------------------------
# 3) Web 产物包
# ---------------------------------------------------------------------------
if [ ! -d "$DIST_DIR" ]; then
  echo "错误：前端构建产物目录 '${DIST_DIR}' 不存在，请先执行 pnpm build" >&2
  exit 1
fi
if [ ! -f "${DIST_DIR}/index.html" ]; then
  echo "错误：'${DIST_DIR}/index.html' 不存在，dist 目录不完整" >&2
  exit 1
fi

WEB_NAME="wocnb-${VERSION}-web.tar.gz"
WEB_PATH="${OUT_ABS}/${WEB_NAME}"
# 包内不带顶层目录：解压即得到可静态托管的 index.html + assets/
tar -czf "$WEB_PATH" -C "$DIST_DIR" .

if ! tar -tzf "$WEB_PATH" | grep -qE '^\./index\.html$'; then
  echo "错误：Web 包中未找到 ./index.html，打包结构异常" >&2
  rm -f "$WEB_PATH"
  exit 1
fi

# 追加校验和（复用 package-source.sh 的同一套格式：<hash>  <filename>）
if command -v sha256sum >/dev/null 2>&1; then
  ( cd "$OUT_ABS" && sha256sum "$WEB_NAME" ) >> "$SUMS_PATH"
else
  ( cd "$OUT_ABS" && shasum -a 256 "$WEB_NAME" ) >> "$SUMS_PATH"
fi

# ---------------------------------------------------------------------------
# 4) 汇总输出
# ---------------------------------------------------------------------------
echo "==> 产物清单（${OUT_ABS}）："
ls -lh "$OUT_ABS" | sed 's/^/    /'
echo "==> 校验和（${SUMS_PATH}）："
cat "$SUMS_PATH" | sed 's/^/    /'

# 自校验：确保校验文件本身可用
( cd "$OUT_ABS" && { command -v sha256sum >/dev/null 2>&1 && sha256sum -c "$SUMS_PATH" || shasum -a 256 -c "$SUMS_PATH"; } ) | sed 's/^/    /'
