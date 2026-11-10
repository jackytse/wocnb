#!/usr/bin/env bash
# =============================================================================
# WOCNB · 源码包打包脚本（P1 release-meta 使用；已实测）
#
# 用途：把仓库源码打成可分发的 `wocnb-<版本>-source.tar.gz`，并生成/更新 SHA256SUMS 校验文件。
#
# 用法：
#   scripts/ci/package-source.sh [选项]
#     --version <VER>      显式指定版本号（不含前缀 v），如 0.1.0
#     --tag <TAG>          用 tag 推导版本号（自动去掉前缀 v），如 v0.1.0
#     --ref <REF>          打包的 git 引用，默认 HEAD
#     --out <DIR>          产物输出目录，默认 release
#     --sums-name <NAME>   校验和文件名，默认 SHA256SUMS
#     -h, --help           显示本帮助
#
# 版本号推导顺序：--version > --tag > $APP_VERSION（上游 version-check 导出）
#                 > 当前提交精确匹配的 tag > $CNB_BRANCH（v 开头）> tauri.conf.json 的 version
#
# 【只允许 git archive，不做工作区遍历打包】
#   源码包的语义是「某个提交的源码快照」，因此只从 git 对象库导出：
#   未跟踪文件、被 .gitignore 忽略的生成物（node_modules / dist / src-tauri/target /
#   auto-imports.d.ts / components.d.ts / .env*）天然不会进包。
#   若当前目录不是 git 仓库、或引用无法解析（例如仓库还没有任何提交、HEAD 未出生），
#   脚本**明确报错退出**，绝不静默产出空包或退化成遍历工作区。
# =============================================================================
set -euo pipefail

# ---------------------------------------------------------------------------
# 参数解析
# ---------------------------------------------------------------------------
VERSION=""
TAG=""
REF="HEAD"
OUT_DIR="release"
SUMS_NAME="SHA256SUMS"

usage() {
  sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version)
      VERSION="${2:?--version 需要一个值}"
      shift 2
      ;;
    --tag)
      TAG="${2:?--tag 需要一个值}"
      shift 2
      ;;
    --ref)
      REF="${2:?--ref 需要一个值}"
      shift 2
      ;;
    --out)
      OUT_DIR="${2:?--out 需要一个值}"
      shift 2
      ;;
    --sums-name)
      SUMS_NAME="${2:?--sums-name 需要一个值}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "错误：未知参数 '$1'（用 --help 查看用法）" >&2
      exit 2
      ;;
  esac
done

# ---------------------------------------------------------------------------
# 小工具
# ---------------------------------------------------------------------------

# 输出去掉前缀 v 的版本号
strip_v() {
  local raw="$1"
  printf '%s' "${raw#v}"
}

# 计算文件的 sha256（优先 sha256sum，macOS 上用 shasum 兜底）
sha256_of() {
  local dir="$1"
  local name="$2"
  if command -v sha256sum >/dev/null 2>&1; then
    ( cd "$dir" && sha256sum "$name" )
  else
    ( cd "$dir" && shasum -a 256 "$name" )
  fi
}

# 向校验文件写入一条记录；同名文件已存在则先删掉旧行，避免重复执行时累积重复行
write_sum() {
  local dir="$1"
  local name="$2"
  local sums_path="$3"
  local line
  line="$(sha256_of "$dir" "$name")"
  touch "$sums_path"
  # sha256sum 输出格式为 "<hash>  <filename>"，第二列即文件名
  awk -v n="$name" '$2 != n' "$sums_path" > "${sums_path}.tmp"
  mv "${sums_path}.tmp" "$sums_path"
  printf '%s\n' "$line" >> "$sums_path"
}

# ---------------------------------------------------------------------------
# 0) 定位仓库根目录，并强制要求「可用的提交快照」
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "$REPO_ROOT"

if ! command -v git >/dev/null 2>&1; then
  echo "错误：缺少 git，无法生成源码包（源码包只从 git 对象库导出）" >&2
  exit 2
fi

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "错误：'${REPO_ROOT}' 不是 git 仓库，无法生成源码包。" >&2
  echo "      源码包必须是「某个提交的源码快照」，脚本刻意不做工作区遍历打包" >&2
  echo "      （那会把未跟踪文件、生成物、本地配置一起打进去，语义不符）。" >&2
  echo "      如果你只是想在临时目录做验证：先 git init 并提交一次再运行。" >&2
  exit 2
fi

if ! git rev-parse --verify --quiet "${REF}^{commit}" >/dev/null 2>&1; then
  echo "错误：无法解析引用 '${REF}'（仓库可能还没有任何提交，HEAD 未出生）。" >&2
  echo "      源码包必须基于提交快照：请先完成首次提交，或用 --ref 指定一个存在的引用。" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 1) 解析版本号
# ---------------------------------------------------------------------------
if [ -z "$VERSION" ] && [ -n "$TAG" ]; then
  VERSION="$(strip_v "$TAG")"
fi

if [ -z "$VERSION" ] && [ -n "${APP_VERSION:-}" ]; then
  VERSION="${APP_VERSION}"
fi

if [ -z "$VERSION" ]; then
  EXACT_TAG="$(git describe --tags --exact-match "$REF" 2>/dev/null || true)"
  if [ -n "$EXACT_TAG" ]; then
    VERSION="$(strip_v "$EXACT_TAG")"
  fi
fi

if [ -z "$VERSION" ] && [ -n "${CNB_BRANCH:-}" ]; then
  case "${CNB_BRANCH}" in
    v*) VERSION="$(strip_v "${CNB_BRANCH}")" ;;
  esac
fi

# 回退到 tauri.conf.json 的版本号（本地无 tag、非 CI 场景下最合理的默认值）
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

# 仍然没有版本号时用「0.0.0-<短 SHA>」，保证文件名可控且可追溯
if [ -z "$VERSION" ]; then
  SHORT_SHA="$(git rev-parse --short "$REF" 2>/dev/null || true)"
  VERSION="0.0.0-${SHORT_SHA:-unknown}"
fi

SRC_NAME="wocnb-${VERSION}-source.tar.gz"
PREFIX="wocnb-${VERSION}/"

mkdir -p "$OUT_DIR"
OUT_ABS="$(cd "$OUT_DIR" && pwd)"
ARCHIVE="${OUT_ABS}/${SRC_NAME}"

echo "==> 打包源码：版本 ${VERSION} / 引用 ${REF}"
echo "    输出：${ARCHIVE}"

# ---------------------------------------------------------------------------
# 2) 生成源码包（只从 git 对象库导出，天然排除未跟踪与忽略文件）
# ---------------------------------------------------------------------------
git archive --format=tar.gz --prefix="$PREFIX" "$REF" -o "$ARCHIVE"

# ---------------------------------------------------------------------------
# 3) 校验：包必须非空，且排除项一个都不许出现
# ---------------------------------------------------------------------------
LISTING="$(tar -tzf "$ARCHIVE")"
STRIPPED="$(printf '%s\n' "$LISTING" | sed -n "s|^${PREFIX}||p")"

if [ -z "$STRIPPED" ]; then
  echo "错误：源码包为空（引用 '${REF}' 下没有任何文件）" >&2
  rm -f "$ARCHIVE"
  exit 1
fi

if printf '%s\n' "$STRIPPED" | grep -Eq '^(node_modules/|dist/|dist-ssr/|src-tauri/target/|\.git/|\.env)'; then
  echo "错误：源码包中出现应为排除项的路径，打包失败：" >&2
  printf '%s\n' "$STRIPPED" | grep -E '^(node_modules/|dist/|dist-ssr/|src-tauri/target/|\.git/|\.env)' | head -20 >&2
  rm -f "$ARCHIVE"
  exit 1
fi

# ---------------------------------------------------------------------------
# 4) 生成 / 更新校验和
# ---------------------------------------------------------------------------
SUMS_PATH="${OUT_ABS}/${SUMS_NAME}"
write_sum "$OUT_ABS" "$SRC_NAME" "$SUMS_PATH"

SIZE_BYTES="$(wc -c < "$ARCHIVE" | tr -d ' ')"
echo "==> 完成：${SRC_NAME}（${SIZE_BYTES} 字节）"
echo "    条目数：$(printf '%s\n' "$LISTING" | wc -l | tr -d ' ')"
echo "    包内顶层内容（前 10 条）："
printf '%s\n' "$LISTING" | head -10 | sed 's/^/      /'
echo "    校验和：${SUMS_PATH}"
sed 's/^/      /' "$SUMS_PATH"
