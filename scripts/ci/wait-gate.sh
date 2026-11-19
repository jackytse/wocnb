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
# # 依赖
#
#   · CNB 内置变量：CNB_API_ENDPOINT / CNB_REPO_SLUG / CNB_BUILD_ID（= sn，
#     同一次 tag_push 的三条流水线共享同一构建）/ CNB_TOKEN（临时令牌，
#     可信事件含 repo-cnb-detail:r，够查构建状态）
#   · curl + python3（macOS 自带；runner 预装清单已含 python3）
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

API_URL="${CNB_API_ENDPOINT}/${CNB_REPO_SLUG}/-/build/status/${CNB_BUILD_ID}"
DEADLINE=$(( $(date +%s) + TIMEOUT_SEC ))

echo "[wait-gate] 等待门禁流水线「${TARGET}」出终态（构建 ${CNB_BUILD_ID}，上限 ${TIMEOUT_SEC}s）"

while :; do
    # curl -f：HTTP >=400 时非零退出（令牌失效/接口变更会被当成查询失败重试）
    # python3 按 name 匹配目标流水线的 status（pipelinesStatus 以 pipelineId
    # 为 key，序号可能与定义顺序不一致，按 name 找最稳）
    STATUS=$(curl -sSf \
        -H "Authorization: Bearer ${CNB_TOKEN}" \
        "$API_URL" 2>/dev/null | python3 -c '
import sys, json
try:
    data = json.load(sys.stdin)["data"]
    pipelines = data.get("pipelinesStatus") or {}
    for p in pipelines.values():
        if p.get("name") == sys.argv[1]:
            print(p.get("status", ""))
            break
    else:
        print("")
except Exception:
    # 响应结构异常按"查不到"处理，交给外层重试/超时兜底
    print("")
' "$TARGET" || echo "")

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
            # 查不到状态：构建刚触发时 pipelinesStatus 可能还没该流水线条目，继续等
            echo "[wait-gate] ${TARGET} 状态尚未上报，${INTERVAL_SEC}s 后重试……"
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
