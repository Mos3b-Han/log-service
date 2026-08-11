#!/usr/bin/env bash
#
# scripts/smoke.sh -- contract smoke test for the log service.
#
# Verifies the required API contract (spec §7/§8) against a running
# instance: the four endpoints, response shapes, status codes, keyset
# pagination, and the auth behavior in whichever mode the service runs.
# Prints PASS/FAIL per check and exits non-zero if any check fails, so
# it doubles as the CI smoke test.
#
# Usage:
#   scripts/smoke.sh                       # default http://localhost:8080, no auth
#   BASE_URL=http://host:8080 scripts/smoke.sh
#   API_KEY=secret scripts/smoke.sh        # auth-enabled mode
#
# Requires: curl, python3.

set -u

BASE_URL="${BASE_URL:-http://localhost:8080}"
API_KEY="${API_KEY:-}"

PASS=0
FAIL=0

# ---- helpers ---------------------------------------------------------

# Auth header args for the data endpoints (empty when no key).
AUTH_ARGS=()
if [ -n "$API_KEY" ]; then
  AUTH_ARGS=(-H "Authorization: Bearer ${API_KEY}")
fi

pass() { echo "  ✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL + 1)); }

# check_eq <desc> <expected> <actual>
check_eq() {
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi
}

# HTTP status of a GET, auth applied.
get_status() {
  curl -s -o /dev/null -w '%{http_code}' "${AUTH_ARGS[@]}" "$1"
}

# HTTP status of a POST with JSON body, auth applied.
post_status() {
  curl -s -o /dev/null -w '%{http_code}' -X POST "${AUTH_ARGS[@]}" \
    -H 'content-type: application/json' -d "$2" "$1"
}

# Body of a GET, auth applied.
get_body() {
  curl -s "${AUTH_ARGS[@]}" "$1"
}

# Body of a POST, auth applied.
post_body() {
  curl -s -X POST "${AUTH_ARGS[@]}" -H 'content-type: application/json' \
    -d "$2" "$1"
}

# Evaluate a python expression against JSON on stdin. `d` is the parsed
# body; print the result. Returns "<err>" on any parse failure.
pyj() {
  python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
    print(eval(sys.argv[1]))
except Exception:
    print("<err>")
' "$1"
}

echo "Contract smoke test"
echo "  target : ${BASE_URL}"
echo "  auth   : $([ -n "$API_KEY" ] && echo "bearer token" || echo "none")"

# Unique marker services so query assertions are deterministic even
# against a database that already holds other rows.
SVC="smoke-$(date -u +%s)-$$"
SVC2="${SVC}-x"

# Timestamps: three entries about an hour in the past, one minute apart.
NOW=$(date -u +%s)
TS1=$(date -u -d "@$((NOW - 3600))" +%Y-%m-%dT%H:%M:%SZ)
TS2=$(date -u -d "@$((NOW - 3540))" +%Y-%m-%dT%H:%M:%SZ)
TS3=$(date -u -d "@$((NOW - 3480))" +%Y-%m-%dT%H:%M:%SZ)
SINCE=$(date -u -d "@$((NOW - 7200))" +%Y-%m-%dT%H:%M:%SZ)
UNTIL=$(date -u -d "@$((NOW + 3600))" +%Y-%m-%dT%H:%M:%SZ)

# ---- 1. health -------------------------------------------------------
echo ""
echo "[1] GET /health"
check_eq "returns 200" "200" "$(get_status "${BASE_URL}/health")"
# Health is always unauthenticated, even in auth mode.
check_eq "unauthenticated even with auth on" "200" \
  "$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/health")"

# ---- 2. auth gate (mode-dependent) ----------------------------------
echo ""
echo "[2] Auth behavior"
if [ -n "$API_KEY" ]; then
  check_eq "data endpoint without token -> 401" "401" \
    "$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/logs?service=${SVC}")"
  check_eq "data endpoint with wrong token -> 401" "401" \
    "$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer nope' "${BASE_URL}/logs?service=${SVC}")"
  check_eq "data endpoint with correct token -> 200" "200" \
    "$(get_status "${BASE_URL}/logs?service=${SVC}")"
else
  # Auth off: an unrecognized Authorization header must be IGNORED.
  check_eq "unrecognized bearer ignored (not rejected) -> 200" "200" \
    "$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer bogus' "${BASE_URL}/logs?service=${SVC}")"
fi

# ---- 3. POST /logs ingest -------------------------------------------
echo ""
echo "[3] POST /logs"

SEED="{\"logs\":[
  {\"timestamp\":\"${TS1}\",\"level\":\"error\",\"service\":\"${SVC}\",\"message\":\"alpha declined\",\"attributes\":{\"region\":\"eu-west\"}},
  {\"timestamp\":\"${TS2}\",\"level\":\"error\",\"service\":\"${SVC}\",\"message\":\"beta declined\",\"attributes\":{\"region\":\"us-east\"}},
  {\"timestamp\":\"${TS3}\",\"level\":\"info\",\"service\":\"${SVC}\",\"message\":\"gamma ok\",\"attributes\":{\"region\":\"eu-west\"}}
]}"
BODY=$(post_body "${BASE_URL}/logs" "$SEED")
check_eq "valid batch -> 200 accepted=3" "3" "$(echo "$BODY" | pyj "d['accepted']")"
check_eq "response has rejected[] array" "True" "$(echo "$BODY" | pyj "isinstance(d['rejected'], list)")"

# Mixed batch: one valid (to SVC2), one invalid level. 200, index/reason.
MIXED="{\"logs\":[
  {\"timestamp\":\"${TS1}\",\"level\":\"warn\",\"service\":\"${SVC2}\",\"message\":\"ok\"},
  {\"timestamp\":\"${TS1}\",\"level\":\"critical\",\"service\":\"${SVC2}\",\"message\":\"bad\"}
]}"
BODY=$(post_body "${BASE_URL}/logs" "$MIXED")
check_eq "mixed batch -> accepted=1" "1" "$(echo "$BODY" | pyj "d['accepted']")"
check_eq "rejected[0].index = 1" "1" "$(echo "$BODY" | pyj "d['rejected'][0]['index']")"
check_eq "rejected[0].reason mentions level" "True" \
  "$(echo "$BODY" | pyj "'level' in d['rejected'][0]['reason']")"

# All invalid -> 400
check_eq "all-invalid batch -> 400" "400" \
  "$(post_status "${BASE_URL}/logs" '{"logs":[{"level":"info","service":"s","message":"m"}]}')"
# Empty logs -> 400
check_eq "empty logs -> 400" "400" "$(post_status "${BASE_URL}/logs" '{"logs":[]}')"
# Wrong top-level shape -> 400
check_eq "missing logs key -> 400" "400" "$(post_status "${BASE_URL}/logs" '{"foo":1}')"
# Malformed JSON -> 400
check_eq "malformed JSON -> 400" "400" "$(post_status "${BASE_URL}/logs" '{not json')"

# ---- 4. GET /logs query ---------------------------------------------
echo ""
echo "[4] GET /logs"
BODY=$(get_body "${BASE_URL}/logs?service=${SVC}")
check_eq "shape has logs[] and next_cursor" "True" \
  "$(echo "$BODY" | pyj "'logs' in d and 'next_cursor' in d")"
check_eq "service filter returns 3" "3" "$(echo "$BODY" | pyj "len(d['logs'])")"
check_eq "sorted by timestamp DESC" "True" \
  "$(echo "$BODY" | pyj "[l['timestamp'] for l in d['logs']] == sorted([l['timestamp'] for l in d['logs']], reverse=True)")"
check_eq "level filter (error) returns 2" "2" \
  "$(get_body "${BASE_URL}/logs?service=${SVC}&level=error" | pyj "len(d['logs'])")"
check_eq "attr filter (region=us-east) returns 1" "1" \
  "$(get_body "${BASE_URL}/logs?service=${SVC}&attr.region=us-east" | pyj "len(d['logs'])")"
check_eq "q substring (case-insensitive DECLINED) returns 2" "2" \
  "$(get_body "${BASE_URL}/logs?service=${SVC}&q=DECLINED" | pyj "len(d['logs'])")"

# Keyset pagination: page 1 (limit 2) then follow the cursor.
P1=$(get_body "${BASE_URL}/logs?service=${SVC}&limit=2")
check_eq "page 1 returns 2" "2" "$(echo "$P1" | pyj "len(d['logs'])")"
check_eq "page 1 has a next_cursor" "True" "$(echo "$P1" | pyj "d['next_cursor'] is not None")"
CURSOR=$(echo "$P1" | pyj "d['next_cursor']")
P2=$(get_body "${BASE_URL}/logs?service=${SVC}&limit=2&cursor=${CURSOR}")
check_eq "page 2 returns 1" "1" "$(echo "$P2" | pyj "len(d['logs'])")"
check_eq "page 2 next_cursor is null" "True" "$(echo "$P2" | pyj "d['next_cursor'] is None")"
# No overlap between pages. Values are passed as argv (never
# interpolated into source) so this stays robust if an earlier request
# failed and returned no ids.
IDS1=$(echo "$P1" | python3 -c "import sys,json; print(json.dumps([l['id'] for l in json.load(sys.stdin).get('logs',[])]))" 2>/dev/null || echo '[]')
ID2=$(echo "$P2" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['logs'][0]['id'] if d.get('logs') else '')" 2>/dev/null || echo '')
check_eq "no id overlap across pages" "True" \
  "$(python3 -c "import json,sys; print(bool(sys.argv[1]) and sys.argv[1] not in json.loads(sys.argv[2]))" "$ID2" "$IDS1" 2>/dev/null || echo False)"

# Invalid query params -> 400
check_eq "bad level -> 400" "400" "$(get_status "${BASE_URL}/logs?level=critical")"
check_eq "limit=0 -> 400" "400" "$(get_status "${BASE_URL}/logs?limit=0")"
check_eq "limit=5000 -> 400" "400" "$(get_status "${BASE_URL}/logs?limit=5000")"
check_eq "bad since -> 400" "400" "$(get_status "${BASE_URL}/logs?since=nope")"
check_eq "until<since -> 400" "400" \
  "$(get_status "${BASE_URL}/logs?since=${UNTIL}&until=${SINCE}")"
check_eq "garbage cursor -> 400" "400" "$(get_status "${BASE_URL}/logs?cursor=%%%")"

# ---- 5. GET /logs/aggregate -----------------------------------------
echo ""
echo "[5] GET /logs/aggregate"
AGG="${BASE_URL}/logs/aggregate?since=${SINCE}&until=${UNTIL}&bucket=1h&service=${SVC}"
BODY=$(get_body "$AGG")
check_eq "shape has buckets[]" "True" "$(echo "$BODY" | pyj "'buckets' in d")"
check_eq "counts sum to 3" "3" "$(echo "$BODY" | pyj "sum(b['count'] for b in d['buckets'])")"
check_eq "no group_by -> group is null" "True" \
  "$(echo "$BODY" | pyj "all(b['group'] is None for b in d['buckets'])")"

BODY=$(get_body "${AGG}&group_by=level")
check_eq "group_by=level uses names, error total=2" "2" \
  "$(echo "$BODY" | pyj "sum(b['count'] for b in d['buckets'] if b['group']=='error')")"

BODY=$(get_body "${AGG}&group_by=service")
check_eq "buckets ordered by (start, group)" "True" \
  "$(echo "$BODY" | pyj "d['buckets'] == sorted(d['buckets'], key=lambda b:(b['start'], b['group'] or ''))")"

# Required-param and validation errors -> 400
check_eq "missing since -> 400" "400" \
  "$(get_status "${BASE_URL}/logs/aggregate?until=${UNTIL}&bucket=1h")"
check_eq "missing until -> 400" "400" \
  "$(get_status "${BASE_URL}/logs/aggregate?since=${SINCE}&bucket=1h")"
check_eq "missing bucket -> 400" "400" \
  "$(get_status "${BASE_URL}/logs/aggregate?since=${SINCE}&until=${UNTIL}")"
check_eq "bad bucket -> 400" "400" \
  "$(get_status "${BASE_URL}/logs/aggregate?since=${SINCE}&until=${UNTIL}&bucket=2h")"
check_eq "bad group_by -> 400" "400" \
  "$(get_status "${BASE_URL}/logs/aggregate?since=${SINCE}&until=${UNTIL}&bucket=1h&group_by=message")"

# ---- summary ---------------------------------------------------------
echo ""
echo "────────────────────────────────────────────"
echo "  PASS: ${PASS}   FAIL: ${FAIL}"
echo "────────────────────────────────────────────"
[ "$FAIL" -eq 0 ] && echo "  RESULT: all contract checks passed ✅" \
  || echo "  RESULT: ${FAIL} check(s) failed ❌"
exit "$([ "$FAIL" -eq 0 ] && echo 0 || echo 1)"
