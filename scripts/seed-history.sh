#!/usr/bin/env bash
#
# scripts/seed-history.sh -- create historical daily partitions for
# performance testing.
#
# WHY THIS EXISTS
#
# The application only ever provisions partitions forward in time
# (today .. today + PARTITION_LOOKAHEAD_DAYS), because that is all a
# production system needs: log data arrives at "now". A service that
# has genuinely been running for a month therefore also HAS the
# previous month's partitions -- each one was created back when it was
# "today".
#
# A freshly built test environment has no such history, so every
# load-generated row lands in a single partition. That makes partition
# pruning look useless (it correctly skips 16 empty partitions and
# still has to scan the one holding everything) and produces
# aggregation timings that reflect a data density roughly 450x higher
# than the ~1M-rows-over-a-month shape the spec describes.
#
# This script creates those historical partitions so a spec-shaped
# dataset can be generated. It is TEST INFRASTRUCTURE, deliberately
# kept out of src/ -- production code has no reason to create
# partitions in the past.
#
# Usage:
#   scripts/seed-history.sh [DAYS_BACK]      # default 30
#
# Idempotent: uses CREATE TABLE IF NOT EXISTS, so re-running is safe.

set -euo pipefail

DAYS_BACK="${1:-30}"
CONTAINER="${POSTGRES_CONTAINER:-log-service-postgres-1}"
PGUSER="${POSTGRES_USER:-logs}"
PGDB="${POSTGRES_DB:-logs}"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "Error: container '$CONTAINER' is not running." >&2
  echo "Start the stack first:  docker compose up -d --wait" >&2
  exit 1
fi

echo "Creating daily partitions for the last ${DAYS_BACK} days..."

# Build one SQL statement per day. Bounds are half-open [FROM, TO) at
# UTC midnight, matching migrations/003_partitions.sql and the naming
# contract (logs_YYYY_MM_DD) that src/db/retention.ts validates before
# it will ever DROP a partition.
SQL=""
for ((i = DAYS_BACK; i >= 1; i--)); do
  DAY=$(date -u -d "-${i} days" +%Y-%m-%d)
  NEXT=$(date -u -d "-$((i - 1)) days" +%Y-%m-%d)
  NAME="logs_$(echo "$DAY" | tr '-' '_')"
  SQL+="CREATE TABLE IF NOT EXISTS ${NAME} PARTITION OF logs "
  SQL+="FOR VALUES FROM ('${DAY} 00:00:00+00') TO ('${NEXT} 00:00:00+00');"$'\n'
done

echo "$SQL" | docker exec -i "$CONTAINER" psql -U "$PGUSER" -d "$PGDB" -q

TOTAL=$(docker exec "$CONTAINER" psql -U "$PGUSER" -d "$PGDB" -t -A \
  -c "SELECT count(*) FROM logs_partitions;")

echo "Done. Partition count is now: ${TOTAL}"
echo ""
echo "Next: generate a spec-shaped dataset spread across this history,"
echo "e.g. ~1M rows over ${DAYS_BACK} days:"
echo ""
echo "  LOADGEN_SPREAD_DAYS=${DAYS_BACK} LOADGEN_TOTAL_LOGS=1000000 \\"
echo "    npx tsx loadgen/ingest.ts"
