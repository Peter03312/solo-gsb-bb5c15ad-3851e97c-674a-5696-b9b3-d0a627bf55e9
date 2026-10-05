#!/usr/bin/env bash
# 靠泊窗口预订 —— curl 调用示例
#
# 港口调度员依据【已留档的卸货审查】为某卸港预订靠泊窗口：提交审查 ID、审查内
# 卸港、泊位、带时区起止时刻和提交号。仅当该港在审查模拟中“有实际卸箱且无受阻箱”
# 才受理；受理时冻结清单修订号与该港卸箱数，后续调整/签发新清单不回写。
#
# 前置：无。本脚本自包含：登记航次 -> 配载 -> 签发清单 -> 提交卸货审查 -> 预订靠泊。
#
# 用法: BASE=http://localhost:3000 bash examples/berth-curl.sh
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
API="$BASE/api"

say() { printf '\n=== %s ===\n' "$1"; }
jq_or_cat() { command -v jq >/dev/null 2>&1 && jq . || cat; }

# 0. 准备：登记航次（4 箱各占独立 bay，均 tier0）-> 配载 rev1 -> 签发清单
say "0) 准备：登记航次 + 配载 + 签发清单（rev=1）"
TS=$(date +%s)
VID=$(curl -sS -X POST "$API/voyages" -H 'content-type: application/json' -d '{
  "voyageNo": "V-BERTH-'"$TS"'",
  "bays": 4, "rows": 1, "tiers": 1,
  "defaultColumnWeightLimit": "10000",
  "boxes": [
    { "boxNo": "BX-1", "weight": "500", "category": "1" },
    { "boxNo": "BX-2", "weight": "500", "category": "1" },
    { "boxNo": "BX-3", "weight": "500", "category": "1" },
    { "boxNo": "BX-4", "weight": "500", "category": "1" }
  ]
}' | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
echo "voyageId=$VID"

curl -sS -X POST "$API/voyages/$VID/moves" -H 'content-type: application/json' -d '{
  "baseRevision": 0,
  "moves": [
    { "boxNo": "BX-1", "position": { "bay": 1, "row": 1, "tier": 0 } },
    { "boxNo": "BX-2", "position": { "bay": 2, "row": 1, "tier": 0 } },
    { "boxNo": "BX-3", "position": { "bay": 3, "row": 1, "tier": 0 } },
    { "boxNo": "BX-4", "position": { "bay": 4, "row": 1, "tier": 0 } }
  ]
}' >/dev/null
curl -sS -X POST "$API/voyages/$VID/manifests" -H 'content-type: application/json' \
  -d '{ "expectedRevision": 1 }' >/dev/null
echo "已签发清单 rev=1"

# 1. 提交卸货审查：SHA 卸 BX-1/BX-2，SIN 卸 BX-3，HAM 卸 BX-4（全程可卸、无受阻）
say "1) 提交卸货审查（各箱独立列顶，逐港卸空无受阻）"
REVIEW_JSON=$(curl -sS -X POST "$API/voyages/$VID/manifests/1/discharge-reviews" \
  -H 'content-type: application/json' -d '{
  "ports": ["SHA", "SIN", "HAM"],
  "items": [
    { "boxNo": "BX-1", "dischargePort": "SHA" },
    { "boxNo": "BX-2", "dischargePort": "SHA" },
    { "boxNo": "BX-3", "dischargePort": "SIN" },
    { "boxNo": "BX-4", "dischargePort": "HAM" }
  ]
}')
RID=$(echo "$REVIEW_JSON" | sed -n 's/.*"reviewId":"\([^"]*\)".*/\1/p' | head -1)
echo "reviewId=$RID"
BOOK_URL="$API/discharge-reviews/$RID/berth-bookings"

# 2. 预订靠泊窗口：SHA / B-01 / 带时区起止 / 提交号 SUB-0001
#    startAt/endAt 必须显式带时区（Z 或 ±HH:MM），且起点严格早于终点。
say "2) 预订靠泊窗口（SHA，泊位 B-01，2026-10-10 08:00-12:00 UTC，提交号 SUB-0001）"
BOOK_JSON=$(curl -sS -X POST "$BOOK_URL" -H 'content-type: application/json' -d '{
  "dischargePort": "SHA",
  "berth": "B-01",
  "startAt": "2026-10-10T08:00:00Z",
  "endAt":   "2026-10-10T12:00:00Z",
  "submissionNo": "SUB-0001"
}')
echo "$BOOK_JSON" | jq_or_cat
BID=$(echo "$BOOK_JSON" | sed -n 's/.*"bookingId":"\([^"]*\)".*/\1/p' | head -1)
echo "bookingId=$BID（冻结清单修订号 manifestRevision=1、该港卸箱数 dischargedBoxCount=2）"

# 3. 同提交号、同内容重试 -> 200 replay:true，返回原预订当前状态
say "3) 同提交号同内容重试 -> 200 replay:true（下面用 +08:00 书写同一绝对时刻）"
curl -sS -X POST "$BOOK_URL" -H 'content-type: application/json' -d '{
  "dischargePort": "SHA",
  "berth": "B-01",
  "startAt": "2026-10-10T16:00:00+08:00",
  "endAt":   "2026-10-10T20:00:00+08:00",
  "submissionNo": "SUB-0001"
}' | jq_or_cat

# 4. 同提交号改内容 -> 409 submission_no_conflict
say "4) 同提交号改内容 -> 409 submission_no_conflict"
curl -sS -X POST "$BOOK_URL" -H 'content-type: application/json' -d '{
  "dischargePort": "SIN",
  "berth": "B-01",
  "startAt": "2026-10-10T08:00:00Z",
  "endAt":   "2026-10-10T12:00:00Z",
  "submissionNo": "SUB-0001"
}' | jq_or_cat

# 5. 同一审查同一卸港的第二个有效预订（新提交号、新泊位）-> 409 active_booking_exists
say "5) 同审查同卸港再订 -> 409 active_booking_exists"
curl -sS -X POST "$BOOK_URL" -H 'content-type: application/json' -d '{
  "dischargePort": "SHA", "berth": "B-09",
  "startAt": "2026-11-01T00:00:00Z", "endAt": "2026-11-01T04:00:00Z",
  "submissionNo": "SUB-0002"
}' | jq_or_cat

# 6. 非法时刻：起点 >= 终点 -> 409 invalid_time_range；裸时间（无时区）-> 400
say "6a) 起点不早于终点 -> 409 invalid_time_range"
curl -sS -X POST "$BOOK_URL" -H 'content-type: application/json' -d '{
  "dischargePort": "HAM", "berth": "B-03",
  "startAt": "2026-10-12T10:00:00Z", "endAt": "2026-10-12T10:00:00Z",
  "submissionNo": "SUB-0003"
}' | jq_or_cat
say "6b) 时刻不带时区 -> 400 invalid_request_body"
curl -sS -X POST "$BOOK_URL" -H 'content-type: application/json' -d '{
  "dischargePort": "HAM", "berth": "B-03",
  "startAt": "2026-10-12T08:00:00", "endAt": "2026-10-12T10:00:00",
  "submissionNo": "SUB-0003"
}' | jq_or_cat

# 7. 未知卸港 -> 404 unknown_discharge_port
say "7) 卸港不在审查港序列表 -> 404 unknown_discharge_port"
curl -sS -X POST "$BOOK_URL" -H 'content-type: application/json' -d '{
  "dischargePort": "XXX", "berth": "B-01",
  "startAt": "2026-12-01T00:00:00Z", "endAt": "2026-12-01T02:00:00Z",
  "submissionNo": "SUB-0004"
}' | jq_or_cat

# 8. 另一卸港 SIN 可预订；与 SHA 同泊位同时间段也不冲突（卸港不同）
say "8) 同审查另一卸港 SIN 预订（泊位 B-02，提交号 SUB-0005）"
curl -sS -X POST "$BOOK_URL" -H 'content-type: application/json' -d '{
  "dischargePort": "SIN", "berth": "B-02",
  "startAt": "2026-10-11T08:00:00Z", "endAt": "2026-10-11T10:00:00Z",
  "submissionNo": "SUB-0005"
}' | jq_or_cat

# 9. 取消预订 -> 200 status=cancelled；重复取消 -> 200 replay:true
say "9a) 取消预订（保留记录、释放占用）"
curl -sS -X POST "$API/berth-bookings/$BID/cancel" | jq_or_cat
say "9b) 重复取消 -> 200 replay:true（已取消状态）"
curl -sS -X POST "$API/berth-bookings/$BID/cancel" | jq_or_cat

# 10. 取消后重新预订：同港同泊位重叠时段恢复可用，但必须用新提交号
say "10) 取消后重新预订（新提交号 SUB-0006，与原时段重叠也允许）"
curl -sS -X POST "$BOOK_URL" -H 'content-type: application/json' -d '{
  "dischargePort": "SHA", "berth": "B-01",
  "startAt": "2026-10-10T09:00:00Z", "endAt": "2026-10-10T11:00:00Z",
  "submissionNo": "SUB-0006"
}' | jq_or_cat

# 11. 查询：按审查列出全部预订（含已取消）、单条 GET
say "11a) 按审查列出预订与状态（含已取消记录）"
curl -sS "$BOOK_URL" | jq_or_cat
say "11b) 取单条预订（GET /api/berth-bookings/:id）"
curl -sS "$API/berth-bookings/$BID" | jq_or_cat
