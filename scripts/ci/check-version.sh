#!/usr/bin/env bash
# =============================================================================
# WOCNB · 版本一致性校验
#
# 用途：校验「tag 名去掉前缀 v」严格等于 `src-tauri/tauri.conf.json` 的 `version`。
#       原因：Tauri 以 tauri.conf.json > version 为产物版本（写进 .dmg/.exe 的元数据与安装目录），
#       若 tag 是 v0.2.0 而配置还是 0.1.0，用户装到的就是 0.1.0 —— 这种「静默错版」
#       比构建失败危险得多，所以必须拦在创建 Release 之前。
#
# 用法：
#   scripts/ci/check-version.sh [TAG]
#   CNB_BRANCH=v0.1.0 scripts/ci/check-version.sh     # CI 内由内置变量提供
#
# 约定：
#   合法 semver：v1.2.3 / v1.2.3-rc.1 / v1.2.3-beta.2 / v1.2.3+build.7
#   预发布版本同样要求 tauri.conf.json 的 version 写成完整串，如 "1.2.3-rc.1"
#
# 输出：
#   stdout 只输出「干净」的版本号（不含 v、无换行），供 .cnb.yml 的 exports 捕获为 APP_VERSION
#   人类可读信息一律走 stderr，避免污染 stdout
#
# 退出码：0 = 一致；1 = 不一致或 tag 非法；2 = 用法/环境错误
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "$REPO_ROOT"

TAG="${1:-${CNB_BRANCH:-}}"
if [ -z "$TAG" ]; then
  echo "错误：未提供 tag（用法：check-version.sh v0.2.0，或在 CI 中设置 CNB_BRANCH）" >&2
  exit 2
fi

VERSION="${TAG#v}"

# --- 1) tag 必须是合法 semver ---
SEMVER_RE='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$'
if ! printf '%s' "$VERSION" | grep -Eq "$SEMVER_RE"; then
  echo "错误：tag '${TAG}' 不是合法 semver（应形如 v1.2.3 或 v1.2.3-rc.1）" >&2
  exit 1
fi

if [ "${TAG:0:1}" != "v" ]; then
  echo "警告：tag '${TAG}' 未以 v 开头；本项目约定发布 tag 必须形如 v1.2.3" >&2
fi

# --- 2) 读取 tauri.conf.json 的 version ---
CONF="src-tauri/tauri.conf.json"
if [ ! -f "$CONF" ]; then
  echo "错误：找不到 ${CONF}（脚本应在仓库根目录下执行）" >&2
  exit 2
fi

CONF_VERSION=""
if command -v node >/dev/null 2>&1; then
  CONF_VERSION="$(node -e '
    const fs = require("node:fs");
    const conf = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.stdout.write(String(conf.version || ""));
  ' "$CONF")"
else
  # 无 node 时退回文本解析（只取第一处 "version" 字段，tauri.conf.json 顶层即版本号）
  CONF_VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$CONF" | head -1)"
fi

if [ -z "$CONF_VERSION" ]; then
  echo "错误：${CONF} 中未解析到 version 字段" >&2
  exit 1
fi

# --- 3) 严格比较 ---
if [ "$CONF_VERSION" != "$VERSION" ]; then
  echo "错误：版本不一致，拒绝发布" >&2
  echo "       tag（去掉 v） : ${VERSION}" >&2
  echo "       ${CONF} : ${CONF_VERSION}" >&2
  echo "  修复方式：修改 ${CONF} 的 version 为 ${VERSION}，走 PR 合入 main 后重新打 tag" >&2
  exit 1
fi

echo "版本一致：tag ${TAG} ≡ ${CONF} 的 version ${CONF_VERSION}" >&2

# stdout 只给 exports 用，必须是「无换行、无杂音」的版本号
printf '%s' "$VERSION"
