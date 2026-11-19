#!/usr/bin/env bash
# =============================================================================
# wait-gate.sh · 发版流水线门禁等待脚本（release-macos / release-windows 用）
#
# # 解决什么问题
#
# tag_push 会同时触发 release-meta / release-macos / release-windows 三条
# **并行**流水线。CNB 平台不支持流水线间依赖编排（官方语法手册无 dependsOn
# / gate 之类字段），release-meta 的质量门禁（typecheck/lint/test）失败后，
# 两条构建流水线仍会继续跑——rc.46 实测门禁 2 分钟即失败，mac/windows 却
# 空跑了近 10 分钟才被平台取消，白白占用自托管节点。
#
# # 工作方式
#
# 本脚本作为 mac/windows 流水线的**第一个 stage**（在 install 之前跑，
# 门禁失败时连环境准备都省掉）：轮询同一构建（同 sn）里 release-meta
# 流水线的状态——
#   · success        → exit 0，本流水线继续往下跑（install/build/upload）
#   · error/cancel   → exit 1，本流水线**立即终止**（这正是"typecheck 失败
#                      直接终止流水线"的落地）
#   · pending/running/查不到 → 继续等
# 超时（默认 900s）仍未等到终态 → exit 1（宁可误杀也不挂死节点）。
#
# # 健壮性设计（rc.47 教训）
#
# rc.47 里 mac 侧脚本曾静默死等：curl/python3 任一环节失败（如 python3
# 不在 PATH）都只表现为"状态查不到"，脚本默默循环到超时，日志里毫无
# 线索。修复：
#   · 关键内置变量缺失 → 立即报错退出（拼出畸形 URL 死等毫无意义）；
#   · 每轮输出 curl 退出码与解析器选择，失败原因日志可见；
#   · 解析器优先 python3，回退 node（runner 上两者至少有一个，构建本身
#     依赖 node）；
#   · API 连续失败熔断（默认 30 次 ≈ 5 分钟）→ exit 1，不做无限重试。
#
# # 依赖
#
#   · CNB 内置变量：CNB_API_ENDPOINT / CNB_REPO_SLUG / CNB_BUILD_ID（= sn，
#     同一次 tag_push 的三条流水线共享同一构建）/ CNB_TOKEN（临时令牌，
#     可信事件含 repo-cnb-detail:r，够查构建状态）
#   · curl（macOS 自带）+ python3 或 node（解析 JSON）
#
# 用法：bash scripts/ci/wait-gate.sh [目标流水线名]（默认 release-meta）
# =============================================================================
set -eu

# 目标门禁流水线名（按 .cnb.yml 里 tag_push 数组的 name 字段匹配，
# 不依赖 "-001" 这类序号硬编码——数组顺序将来调整也不会失效）
TARGET="${1:-release-meta}"

# 超时与轮询间隔（秒）：release-meta 全程约 1 分钟（rc.45 实测 58s），
# 900s 已含 changelog 插件网络抖动的余量
TIMEOUT_SEC="${WAIT_GATE_TIMEOUT_SEC:-900}"
INTERVAL_SEC="${WAIT_GATE_INTERVAL_SEC:-10}"
# API 连续失败熔断阈值（次）：超过即认为 runner 侧网络/环境异常，
# 继续死等只会拖到整体超时，不如立刻失败暴露问题
MAX_API_FAILURES="${WAIT_GATE_MAX_API_FAILURES:-30}"

# —— 内置变量防御（缺失立即失败，绝不拼畸形 URL 死等）——
# 缺哪个直接在日志里点名，排障不用翻代码
MISSING=""
[ -z "${CNB_API_ENDPOINT:-}" ] && MISSING="$MISSING CNB_API_ENDPOINT"
[ -z "${CNB_REPO_SLUG:-}" ] && MISSING="$MISSING CNB_REPO_SLUG"
[ -z "${CNB_BUILD_ID:-}" ] && MISSING="$MISSING CNB_BUILD_ID"
[ -z "${CNB_TOKEN:-}" ] && MISSING="$MISSING CNB_TOKEN"
if [ -n "$MISSING" ]; then
    echo "[wait-gate] 缺少 CNB 内置变量:$MISSING —— 无法查询门禁状态，终止本流水线"
    exit 1
fi

API_URL="${CNB_API_ENDPOINT}/${CNB_REPO_SLUG}/-/build/status/${CNB_BUILD_ID}"
DEADLINE=$(( $(date +%s) + TIMEOUT_SEC ))

# —— 解析器探测：python3 优先，node 回退（构建链路必有 node）——
# 输出 JSON 文本 + 目标流水线名，stdout 打印状态串（空串 = 未找到）
PARSER=""
if command -v python3 >/dev/null 2>&1; then
    PARSER="python3"
elif command -v node >/dev/null 2>&1; then
    PARSER="node"
else
    echo "[wait-gate] runner 上既无 python3 也无 node，无法解析 API 响应，终止本流水线"
    exit 1
fi
echo "[wait-gate] 等待门禁流水线「${TARGET}」出终态（构建 ${CNB_BUILD_ID}，上限 ${TIMEOUT_SEC}s，解析器 ${PARSER}）"

# 解析函数：从状态 JSON 提取目标流水线的 status
# python3 版（sys.argv[1] 传目标名；任何异常输出空串交由外层计数熔断）
parse_python3() {
    python3 -c '
import sys, json
try:
    raw = json.load(sys.stdin)
    data = raw.get("data") or raw
    pipelines = data.get("pipelinesStatus") or {}
    for p in pipelines.values():
        if p.get("name") == sys.argv[1]:
            print(p.get("status", ""))
            break
    else:
        print("")
except Exception:
    print("")
' "$TARGET"
}
# node 版（argv[2] 传目标名；同样吞异常输出空串）
parse_node() {
    node -e '
let raw = "";
process.stdin.on("data", (c) => { raw += c });
process.stdin.on("end", () => {
  try {
    const parsed = JSON.parse(raw);
    const body = parsed.data || parsed;
    const pipelines = body.pipelinesStatus || {};
    const hit = Object.values(pipelines).find((p) => p.name === process.argv[1]);
    process.stdout.write(hit ? String(hit.status || "") : "");
  } catch { process.stdout.write(""); }
  process.exit(0);
});
' "$TARGET"
}

API_FAILURES=0
while :; do
    # curl -f：HTTP >=400 时非零退出；退出码记入日志便于诊断
    HTTP_BODY=$(curl -sSf -H "Authorization: Bearer ${CNB_TOKEN}" "$API_URL" 2>&1) || {
        CURL_CODE=$?
        API_FAILURES=$((API_FAILURES + 1))
        echo "[wait-gate] API 查询失败（curl 退出码 ${CURL_CODE}，连续第 ${API_FAILURES}/${MAX_API_FAILURES} 次）：${HTTP_BODY}"
        if [ "$API_FAILURES" -ge "$MAX_API_FAILURES" ]; then
            echo "[wait-gate] API 连续失败达熔断阈值，终止本流水线（请检查 runner 出网与 CNB_TOKEN）"
            exit 1
        fi
        sleep "$INTERVAL_SEC"
        continue
    }

    if [ "$PARSER" = "python3" ]; then
        STATUS=$(printf '%s' "$HTTP_BODY" | parse_python3)
    else
        STATUS=$(printf '%s' "$HTTP_BODY" | parse_node)
    fi
    # 查询成功即清零失败计数（网络抖动后恢复正常不应累计触发熔断）
    API_FAILURES=0

    case "${STATUS}" in
        success)
            echo "[wait-gate] 门禁通过（${TARGET}: success），继续执行本流水线"
            exit 0
            ;;
        error|fail|failure|cancel|canceled|skipped)
            echo "[wait-gate] 门禁失败（${TARGET}: ${STATUS}），本流水线立即终止，不再空跑构建"
            exit 1
            ;;
        "")
            # 查到了响应但目标流水线还没上报状态：正常等待
            echo "[wait-gate] ${TARGET} 状态尚未上报，${INTERVAL_SEC}s 后复查……"
            ;;
        *)
            echo "[wait-gate] ${TARGET}: ${STATUS}（运行中），${INTERVAL_SEC}s 后复查……"
            ;;
    esac

    if [ "$(date +%s)" -ge "$DEADLINE" ]; then
        echo "[wait-gate] 等待超时（${TIMEOUT_SEC}s）仍未等到 ${TARGET} 终态，按失败终止本流水线"
        exit 1
    fi
    sleep "$INTERVAL_SEC"
done
