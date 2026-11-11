#!/usr/bin/env bash
# =============================================================================
# WOCNB · Release 附件上传（Linux / macOS 通用，纯 curl + OPENAPI）
#
# ⚠️【未实测】本脚本供 P2（macOS 自托管节点）使用，从未在真实自托管节点上执行过；
#   只验证过参数守卫与语法。P1 用的是官方节点 + cnbcool/attachments 插件，不经过本脚本。
#   三段式上传（asset-upload-url → PUT → verify）的字段名依据的是 cnbcool/attachments
#   插件的公开实现与 OPENAPI 文档，**真机首跑前请先用一个小文件试传**。
#   启用前必须先空跑验证（见 .cnb.yml 文件末尾声明）。
#
# 用途：把安装包上传到「同一次构建里由 P1 release-meta 创建的那个 Release」。
#       仅做「上传附件」三件事，绝不创建/删除 Release —— 创建职责唯一化在 P1，
#       否则多条流水线并发时任何一次「先删后建」都会把别人已上传的附件清空。
#
# 关键行为：
#   1) 上传前先轮询 `GET /{repo}/-/releases/tags/{tag}`，等到 Release 出现（默认最长 20 分钟，间隔 10 秒）；
#      拿不到就失败退出，绝不自己建 Release。
#   2) 每个文件走三步：POST asset-upload-url → PUT 上传地址 → POST verify_url 确认。
#   3) overwrite: true 只覆盖「自己同名的附件」，不会影响其他平台的包。
#
# 用法：
#   scripts/ci/release-upload.sh <文件或目录> [...]
#   scripts/ci/release-upload.sh ./release
#
# 必需环境变量（CNB 流水线内置，无需手工配置）：
#   CNB_TOKEN                 需具备 repo-release 读写权限（tag_push 属可信事件，默认具备）
#   CNB_BRANCH                tag_push 事件下即 tag 名
#   CNB_REPO_SLUG_LOWERCASE   仓库路径（小写），缺失时回退 CNB_REPO_SLUG
#   CNB_API_ENDPOINT          API 地址，默认 https://api.cnb.cool
# =============================================================================
set -euo pipefail

POLL_TIMES="${POLL_TIMES:-120}"   # 轮询次数
POLL_INTERVAL="${POLL_INTERVAL:-10}" # 轮询间隔（秒）→ 默认 120*10 = 20 分钟

if [ $# -lt 1 ]; then
  echo "用法：$0 <文件或目录> [...]" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# 0) 收集待上传文件
# ---------------------------------------------------------------------------
FILES=()
for arg in "$@"; do
  if [ -d "$arg" ]; then
    shopt -s nullglob
    for f in "$arg"/*; do
      FILES+=("$f")
    done
    shopt -u nullglob
  elif [ -f "$arg" ]; then
    FILES+=("$arg")
  else
    echo "错误：找不到 '${arg}'" >&2
    exit 2
  fi
done

if [ ${#FILES[@]} -eq 0 ]; then
  echo "错误：没有待上传的文件" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# 1) 环境与依赖检查
# ---------------------------------------------------------------------------
: "${CNB_TOKEN:?缺少 CNB_TOKEN（仅可用于 CNB 流水线内，或本地手工导出后再试）}"
: "${CNB_BRANCH:?缺少 CNB_BRANCH（tag_push 事件下应等于 tag 名）}"

API_ENDPOINT="${CNB_API_ENDPOINT:-https://api.cnb.cool}"
REPO_SLUG="${CNB_REPO_SLUG_LOWERCASE:-${CNB_REPO_SLUG:-}}"
if [ -z "$REPO_SLUG" ]; then
  echo "错误：缺少 CNB_REPO_SLUG_LOWERCASE / CNB_REPO_SLUG" >&2
  exit 2
fi
# 统一转小写，避免大小写不一致导致 404
REPO_SLUG="$(printf '%s' "$REPO_SLUG" | tr '[:upper:]' '[:lower:]')"
API="${API_ENDPOINT}/${REPO_SLUG}"
TAG="${CNB_BRANCH}"

if ! command -v curl >/dev/null 2>&1; then
  echo "错误：缺少 curl" >&2
  exit 2
fi

# 用 node 或 python3 解析 JSON（两者任一即可）；都没有时用 sed 兜底
json_field() {
  local field="$1"
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "import sys, json; print(json.load(sys.stdin).get('${field}', ''))"
  elif command -v node >/dev/null 2>&1; then
    node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);process.stdout.write(String(o['${field}'] ?? ''))})"
  else
    sed -n "s/.*\"${field}\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -1
  fi
}

H=(-H "Authorization: Bearer ${CNB_TOKEN}" -H "Accept: application/vnd.cnb.api+json")

echo "==> 目标仓库：${REPO_SLUG}"
echo "==> 目标 Tag ：${TAG}"
echo "==> API      ：${API}"

# ---------------------------------------------------------------------------
# 2) 轮询等待 P1 创建 Release（纯 HTTP，不依赖任何平台内部机制）
# ---------------------------------------------------------------------------
REL_ID=""
RESP_FILE="$(mktemp)"
trap 'rm -f "$RESP_FILE"' EXIT

for i in $(seq 1 "$POLL_TIMES"); do
  HTTP_CODE="$(curl -sS -o "$RESP_FILE" -w '%{http_code}' "${H[@]}" \
    "${API}/-/releases/tags/${TAG}" || true)"
  if [ "$HTTP_CODE" = "200" ]; then
    REL_ID="$(json_field id < "$RESP_FILE" || true)"
    if [ -n "$REL_ID" ]; then
      echo "==> 已找到 Release（id=${REL_ID}），第 ${i} 次轮询"
      break
    fi
  fi
  if [ $((i % 6)) -eq 0 ]; then
    echo "    等待 Release 出现…（第 ${i}/${POLL_TIMES} 次，HTTP ${HTTP_CODE}）"
  fi
  sleep "$POLL_INTERVAL"
done

if [ -z "$REL_ID" ]; then
  echo "错误：等待 ${POLL_TIMES}*${POLL_INTERVAL}s 后仍未找到 tag ${TAG} 的 Release" >&2
  echo "      通常意味着 P1 release-meta 失败（门禁/版本校验不通过时不会创建 Release）" >&2
  echo "      最后一次响应：" >&2
  head -c 2000 "$RESP_FILE" >&2 || true
  exit 1
fi

# ---------------------------------------------------------------------------
# 3) 逐个文件上传：取上传地址 → PUT 字节 → 确认
#
# rc.11 实测：自托管节点上传大文件时偶发 TLS 断链（curl 56, sslv3 alert
# bad record mac）。所以每个文件整体最多重试 3 次，且每次重试都重新申请
# 上传地址——上传地址只该用一次，断链后复用旧地址行为不可预期。
# ---------------------------------------------------------------------------
MAX_ATTEMPTS=3
FAILED=0
for f in "${FILES[@]}"; do
  NAME="$(basename "$f")"
  SIZE="$(wc -c < "$f" | tr -d ' ')"

  OK=0
  for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
    [ "$attempt" -gt 1 ] && echo "    第 ${attempt}/${MAX_ATTEMPTS} 次重试上传 ${NAME}…"
    echo "==> 上传 ${NAME}（${SIZE} 字节）"

    BODY="{\"asset_name\":\"${NAME}\",\"size\":${SIZE},\"overwrite\":true}"
    CODE="$(curl -sS -o "$RESP_FILE" -w '%{http_code}' -X POST "${H[@]}" \
      -H "Content-Type: application/json" -d "$BODY" \
      "${API}/-/releases/${REL_ID}/asset-upload-url" || true)"

    if [ "$CODE" != "200" ] && [ "$CODE" != "201" ]; then
      echo "    错误：申请上传地址失败（HTTP ${CODE}）" >&2
      head -c 2000 "$RESP_FILE" >&2 || true
      echo >&2
      continue    # 申请地址失败 → 直接进入下一次重试
    fi

    UPLOAD_URL="$(json_field upload_url < "$RESP_FILE" || true)"
    VERIFY_URL="$(json_field verify_url < "$RESP_FILE" || true)"
    if [ -z "$UPLOAD_URL" ] || [ -z "$VERIFY_URL" ]; then
      echo "    错误：响应中缺少 upload_url / verify_url" >&2
      head -c 2000 "$RESP_FILE" >&2 || true
      echo >&2
      continue
    fi

    # PUT 字节流：偶发 TLS 断链在这步最多见，curl 自身先做快速重试
    # （--retry-all-errors 让网络类错误也参与重试；curl < 7.71 不认识该
    #  参数，节点 curl 过旧时会报参数错误 → 这里用 || true 兜底降级为单发）
    PUT_CODE="$(curl -sS --retry 3 --retry-delay 2 --retry-all-errors \
      -o /dev/null -w '%{http_code}' -X PUT \
      -H "Content-Type: application/octet-stream" --data-binary "@${f}" "$UPLOAD_URL" 2>/dev/null \
      || curl -sS -o /dev/null -w '%{http_code}' -X PUT \
      -H "Content-Type: application/octet-stream" --data-binary "@${f}" "$UPLOAD_URL" || true)"
    if [ "$PUT_CODE" != "200" ] && [ "$PUT_CODE" != "201" ] && [ "$PUT_CODE" != "204" ]; then
      echo "    错误：上传字节失败（HTTP ${PUT_CODE}）" >&2
      continue
    fi

    VERIFY_CODE="$(curl -sS -o "$RESP_FILE" -w '%{http_code}' -X POST "${H[@]}" "$VERIFY_URL" || true)"
    if [ "$VERIFY_CODE" != "200" ] && [ "$VERIFY_CODE" != "201" ] && [ "$VERIFY_CODE" != "204" ]; then
      echo "    错误：确认上传失败（HTTP ${VERIFY_CODE}）" >&2
      head -c 2000 "$RESP_FILE" >&2 || true
      echo >&2
      continue
    fi

    echo "    完成"
    OK=1
    break
  done

  [ "$OK" -ne 1 ] && FAILED=$((FAILED + 1))
done

if [ "$FAILED" -ne 0 ]; then
  echo "错误：${FAILED} 个附件上传失败" >&2
  exit 1
fi

echo "==> 全部 ${#FILES[@]} 个附件上传成功"
