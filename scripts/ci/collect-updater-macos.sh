#!/usr/bin/env bash
# =============================================================================
# WOCNB · 热更新产物收集 + 更新清单生成（macOS 专用）
#
# 用途：在 release-macos 的 build-arm64 阶段、collect-macos.sh 之后执行：
#   1) 把 tauri build 生成的**热更新产物**（<App>.app.tar.gz + .sig 签名文件）
#      从 bundle 目录搬到 release/ 并按统一命名规范重命名 ——
#      wocnb-<版本>-macos-<架构>.app.tar.gz[.sig]，随后由 release-upload.sh
#      一起传到本次版本的 Release；
#   2) 生成热更新清单 latest.json（Tauri updater v2 格式）到 release/，
#      由 publish-manifest 阶段上传到固定 tag「updater-manifest」的 Release
#      —— 客户端 updater 端点是**静态 URL**（tauri.conf.json plugins.updater），
#      每次发版覆盖该 Release 上的同名附件即可让旧客户端永远拿到最新清单。
#
# 清单格式（tauri-plugin-updater v2）：
#   {
#     "version":   "0.1.0-rc.35",                      ← 目标版本（semver）
#     "notes":     "WOCNB v0.1.0-rc.35",
#     "pub_date":  "2026-11-19T03:00:00Z",             ← RFC 3339 UTC
#     "platforms": {
#       "darwin-aarch64": {
#         "signature": "<.sig 文件内容（minisign 签名）>",
#         "url": "https://cnb.cool/.../wocnb-...-macos-arm64.app.tar.gz"
#       }
#     }
#   }
#
# 用法：scripts/ci/collect-updater-macos.sh <triple> <arch>
#   scripts/ci/collect-updater-macos.sh aarch64-apple-darwin arm64
#
# 失败策略：找不到 .app.tar.gz / .sig 直接退出非零 —— 签名缺失时宁可失败，
# 绝不发无签名的更新包（客户端验签必失败，等于把热更新链路打断）。
# =============================================================================
set -euo pipefail

TRIPLE="${1:?用法: collect-updater-macos.sh <triple> <arch>，如 aarch64-apple-darwin arm64}"
ARCH="${2:?用法: collect-updater-macos.sh <triple> <arch>，如 aarch64-apple-darwin arm64}"
OUT_DIR="release"
# 平台键：清单 platforms 键与 Rust target triple 对应。当前只有 Mac arm64
# 自托管节点，下面生成清单时固定写 darwin-aarch64（接入 x64 节点后需参数化）

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "$REPO_ROOT"

# ---------------------------------------------------------------------------
# 版本号：与 collect-artifacts.sh 同口径（$APP_VERSION > tauri.conf.json）
# ---------------------------------------------------------------------------
VERSION="${APP_VERSION:-}"
if [ -z "$VERSION" ]; then
  CONF="src-tauri/tauri.conf.json"
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
if [ -z "$VERSION" ]; then
  echo "错误：无法确定版本号（APP_VERSION / tauri.conf.json 都没有）" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 匹配热更新产物：bundle/macos/<App>.app.tar.gz（+.sig）
#
# 为什么不在 bundle/dmg 目录找：createUpdaterArtifacts=true 时 macOS 的
# 更新包是 **.app 目录的 tar.gz**，落在 bundle/macos/（dmg 在 bundle/dmg/），
# 两者互不影响、缺一不可（dmg 给首次安装用户，tar.gz 给热更新）。
# ---------------------------------------------------------------------------
SRC_DIR="src-tauri/target/${TRIPLE}/release/bundle/macos"
if [ ! -d "$SRC_DIR" ]; then
  echo "错误：构建产物目录不存在：${SRC_DIR}" >&2
  exit 1
fi

TAR_FILE=""
shopt -s nullglob
matched=()
for f in "${SRC_DIR}"/*.app.tar.gz; do
  matched+=("$f")
done
shopt -u nullglob
if [ ${#matched[@]} -eq 0 ]; then
  echo "错误：${SRC_DIR} 下没有 *.app.tar.gz（热更新产物）" >&2
  echo "      请确认 build 用了 --config src-tauri/tauri.updater.conf.json（createUpdaterArtifacts）" >&2
  exit 1
fi
# 多个匹配取最新修改的（Tauri 有时残留旧产物）
TAR_FILE="$(ls -t "${matched[@]}" | head -1)"
SIG_FILE="${TAR_FILE}.sig"
if [ ! -f "$SIG_FILE" ]; then
  echo "错误：更新包签名缺失：${SIG_FILE}" >&2
  echo "      请确认构建机已注入 TAURI_SIGNING_PRIVATE_KEY（密钥仓库 imports）" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 搬运 + 重命名（与 collect-artifacts.sh 的命名规范对齐）
# ---------------------------------------------------------------------------
DEST_TAR_NAME="wocnb-${VERSION}-macos-${ARCH}.app.tar.gz"
mkdir -p "$OUT_DIR"
cp -f "$TAR_FILE" "${OUT_DIR}/${DEST_TAR_NAME}"
cp -f "$SIG_FILE" "${OUT_DIR}/${DEST_TAR_NAME}.sig"
echo "==> 收集热更新包：${TAR_FILE}"
echo "    -> ${OUT_DIR}/${DEST_TAR_NAME}（$(wc -c < "${OUT_DIR}/${DEST_TAR_NAME}" | tr -d ' ') 字节）"
echo "    -> ${OUT_DIR}/${DEST_TAR_NAME}.sig"

# ---------------------------------------------------------------------------
# 生成 latest.json
#
# notes 用 tag/版本号（不写 changelog：版本说明在 Release 页，清单里保持
# 精简，避免 CI 侧再维护一份文案）；pub_date 用 UTC RFC 3339（updater 用它
# 排序/展示）。signature 用 .sig 文件原文（JSON 字符串转义由 python3 处理）。
# ---------------------------------------------------------------------------
PUB_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
ASSET_URL="https://cnb.cool/jackytse/wocnb/-/releases/download/v${VERSION}/${DEST_TAR_NAME}"

python3 - "$VERSION" "$PUB_DATE" "$ASSET_URL" "$SIG_FILE" "${OUT_DIR}/latest.json" <<'PY'
import json, sys

version, pub_date, url, sig_path, out_path = sys.argv[1:6]
with open(sig_path, 'r', encoding='utf-8') as f:
    signature = f.read().strip()

manifest = {
    "version": version,
    "notes": f"WOCNB v{version}",
    "pub_date": pub_date,
    "platforms": {
        "darwin-aarch64": {
            "signature": signature,
            "url": url,
        },
    },
}
with open(out_path, 'w', encoding='utf-8') as f:
    json.dump(manifest, f, ensure_ascii=False, indent=2)
    f.write('\n')
print(f"==> 生成更新清单：{out_path}")
print(f"    version={version} platform=darwin-aarch64")
PY
