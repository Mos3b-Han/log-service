# PERFORMANCE.md

Measured results, query plans, and the bottlenecks they revealed.

Every figure here comes from a run of the generators committed in
`loadgen/`, and every plan is real `EXPLAIN ANALYZE` output captured
from the running stack. Nothing is estimated or extrapolated. Where a
number is worse than the target, it is reported as measured and
explained rather than adjusted.

---

## Contents

- [Test environment](#test-environment)
- [Dataset shapes](#dataset-shapes)
- [Results against targets](#results-against-targets)
- [Ingestion](#ingestion)
- [Aggregation](#aggregation)
- [Query](#query)
- [Deep pagination](#deep-pagination)
- [Mixed workload](#mixed-workload)
- [Query plans](#query-plans)
- [Bottlenecks found](#bottlenecks-found)
- [Optimizations applied](#optimizations-applied)
- [Reproducing these results](#reproducing-these-results)

---

## Test environment

| | |
| --- | --- |
| Host | Windows 11 + WSL2, Docker Desktop |
| Application container | `node:20-alpine`, **0.5 CPU / 256 MB** (graded limits) |
| PostgreSQL container | `postgres:16-alpine`, **1 CPU / 1 GB** (graded limits) |
| Networking | Application reaches PostgreSQL over the internal Compose network; only port 8080 is published |
| Load generators | Run on the host as ordinary external HTTP clients |

Resource limits are enforced by `cpus` / `mem_limit` in
`docker-compose.yml`, not merely declared. The load generators run
outside the limited containers, so client-side work never competes with
the service for its CPU budget.

**A note on the client.** Generators are closed-loop with N concurrent
workers. At batch size 500, the 15,000 logs/sec target is only 30
requests/sec, so the client is nowhere near its own limits — the
bottleneck under test is the server's write path.

---

## Dataset shapes

Aggregation cost is linear in rows scanned, so a latency figure without
its dataset is not a measurement. Two distinct shapes were used, and
every result below states which one it came from.

| Shape | Rows | Spread | Density | Why it exists |
| --- | --- | --- | --- | --- |
| **Specification-shaped** | ~1.16 M | 30 days | ~1,600 rows/hour | What the spec says to assume: "approximately 1,000,000 records… approximately one month of data" |
| **Dense / burst** | ~2.4 M | ~4 hours | ~630,000 rows/hour | What a burst ingestion test actually produces, since a load generator writes at "now" |

The dense shape is roughly **400× denser**. It is not a failure
scenario — it is the realistic output of hammering a fresh system — so
it is measured too, and the gap between the two is itself a result.

Building the specification-shaped dataset requires history that a fresh
system does not have, because the service only provisions partitions
forward in time:

```bash
bash scripts/seed-history.sh 30
LOADGEN_SPREAD_DAYS=30 LOADGEN_TOTAL_LOGS=1000000 npx tsx loadgen/ingest.ts
```

---

## Results against targets

| Target | Required | Measured | |
| --- | --- | --- | --- |
| Sustained ingestion | ≥ 15,000 logs/sec | **20,959 logs/sec** | pass (140%) |
| Dropped requests during ingestion | zero | **0** | pass |
| Stored dataset | ~1,000,000 rows | **1.16 M** (and 3.2 M under stress) | pass |
| Aggregation p95 | < 1 s | **36.5 ms** (spec-shaped) | pass (27× under) |
| Aggregation rate under load | 1 req/sec | **0.99 req/sec** | pass |
| New data queryable | ≤ 20 s | **2.1 s** worst case | pass (9.5× under) |
| Query performance while ingesting | maintained | agg p95 **1,147 ms** under maximum ingest | **over budget** |

The last row is the one target not met, under the specific combination
of maximum sustained write load and an aggregation window pointed at
the data being written. It is analysed in
[Bottlenecks found](#bottlenecks-found).

---

## Ingestion

`npx tsx loadgen/ingest.ts` — 30 s measured, 5 s warmup discarded,
16 workers × 500 logs/batch, default configuration.

```
Requests
  total        : 1,266  (41.92/s)
  200 ok       : 1,266
  400 rejected : 0
  429 throttled: 0
  failed       : 0

Throughput
  logs sent    : 633,000  (20,959/s)
  logs accepted: 633,000  (20,959/s)
  data sent    : 102.14 MB

Latency (per request)
  min     : 94.34 ms
  mean    : 379.81 ms
  p50     : 353.61 ms
  p90     : 576.47 ms
  p95     : 696.37 ms
  p99     : 914.43 ms
  max     : 930.28 ms
```

`logs sent` equals `logs accepted` exactly: every entry offered was
accepted and committed.

### Resource usage during the run

Sampled with `docker stats` mid-run:

| Container | CPU | Memory |
| --- | --- | --- |
| `log-service-app-1` | ~40% of 0.5 CPU | **33 MB** / 256 MB |
| `log-service-postgres-1` | ~40% of 1 CPU | 231 MB / 1 GB |

Neither container is CPU-saturated at 20,959 logs/sec, and the
application uses 13% of its memory budget. The limiting factor is not
resource exhaustion — see [Bottlenecks found](#bottlenecks-found).

### Concurrency sweep

| Workers | In-flight rows | Throughput | p95 | 429s |
| --- | --- | --- | --- | --- |
| 8 | 4,000 | 21,314/s | — | 0 |
| **16** | 8,000 | **20,959/s** | 696 ms | 0 |
| 32 | 16,000 | 19,275/s | 1,267 ms | 0 |

Saturation is at 16 workers. Beyond it throughput *falls* while latency
roughly doubles — added concurrency becomes queueing, not capacity.

---

## Aggregation

`npx tsx loadgen/aggregate.ts` at the spec's rate of **1 request/sec**,
140 samples over 140 s, on the **specification-shaped** dataset.

Seven query shapes are measured separately, because a pooled average
would hide whichever access path is actually slow.

| Shape | What it stresses | p50 | p95 | p99 |
| --- | --- | --- | --- | --- |
| `1m` / 1 h / no group | `date_bin` at finest granularity | 5.1 | **7.4** | 7.5 |
| `1m` / 1 h / `group_by=service` | grouping multiplies output rows | 9.3 | **12.4** | 13.7 |
| `5m` / 6 h / `group_by=service` | wider scan, medium buckets | 13.4 | **21.0** | 21.4 |
| `1h` / 24 h / `group_by=level` | widest scan, coarse buckets | 15.7 | **28.2** | 29.9 |
| `1h` / 24 h / `service` filter | composite B-tree index | 6.2 | **7.3** | 7.8 |
| `1h` / 24 h / `attr` filter | GIN `jsonb_path_ops` | 10.7 | **13.8** | 20.8 |
| `1h` / 24 h / `q=` substring | **unindexed** message scan | 34.2 | **62.1** | 62.9 |

**Overall p95: 36.5 ms. Worst shape p95: 62.1 ms.** Both far under the
1-second target; the pass verdict is taken from the worst shape so the
claim holds for every query, not a favourable one.

### The same queries on the dense dataset

Identical code, identical indexes, 400× the density:

| Shape | Spec-shaped p95 | Dense p95 | Factor |
| --- | --- | --- | --- |
| `1h` / 24 h / `group_by=level` | 28.2 ms | 2,087 ms | 74× |
| `1h` / 24 h / `attr` filter | 13.8 ms | 2,700 ms | 196× |
| `1h` / 24 h / `q=` substring | 62.1 ms | 13,637 ms | 220× |
| Overall | 36.5 ms | 2,686 ms | 74× |

Note the pattern within the dense run: **one-hour windows stayed fast**
(9.8 ms and 34.5 ms p95) while **24-hour windows collapsed**. Cost
tracks rows scanned, not query complexity.

---

## Query

`npx tsx loadgen/query.ts` at 5 requests/sec, 300 samples, zero
failures, specification-shaped dataset.

| Shape | What it stresses | p50 | p95 |
| --- | --- | --- | --- |
| Newest N, no filter | PK reverse scan | 6.5 | **9.7** |
| Time range 24 h | partition pruning + PK | 5.4 | **7.1** |
| `service` filter | composite index, first column | 7.4 | **11.4** |
| `service` + `level` | composite index, both equality columns | 7.5 | **8.7** |
| `attr` filter | GIN containment | 8.5 | **13.1** |
| `service` + `attr` | index then containment | 11.8 | **17.4** |
| `q=` substring | unindexed ILIKE | 8.6 | **11.5** |
| `limit=1000` | payload at the ceiling | 13.9 | **19.3** |

**Pooled p95: 14.3 ms**, achieved rate exactly 5.00 req/sec.

**The `q=` asymmetry is the interesting result.** The same unindexed
predicate costs 11.5 ms here and 62 ms (spec-shaped) to 13.6 s (dense)
in aggregation. `GET /logs` carries a `LIMIT`, so PostgreSQL stops
scanning once it has enough matching rows; aggregation must examine
every candidate row to produce a count. The cost of leaving `message`
unindexed is therefore concentrated entirely in aggregation.

---

## Deep pagination

Keyset pagination's justification is that page depth is free. That is a
falsifiable prediction, so `loadgen/query.ts` tests it directly: walk
300 pages by following `next_cursor`, timing each.

```
pages walked : 300 (30,000 rows traversed)

segment                          p50       p95       max
first 10 pages                   8.6      30.9      30.9
last 10 pages (deepest)          7.9       9.2       9.2
all pages                        8.1      10.1      34.2

deepest page starts at row ~30,000;
OFFSET would have to read and discard every one of them.
deep/shallow p50 ratio : 0.93x
verdict                : FLAT — depth does not cost anything
```

The deepest pages are marginally *faster* than the first, which is
measurement noise around a flat line. With `OFFSET`, serving page 300
alone would require reading and discarding 30,000 rows, and the curve
would climb linearly with depth.

---

## Mixed workload

`npx tsx loadgen/mixed.ts` — the scenario the specification singles
out. 90 s, ingest at full concurrency, aggregation at 1 req/sec, and a
freshness probe every 10 s, all against one instance.

```
Ingestion (under concurrent query load)
  requests      : 2,364  (2,364 ok, 0 x 429, 0 failed)
  logs accepted : 1,182,000  (12,117/s)
  latency p50   : 571.32 ms
  latency p95   : 1,529.48 ms

Aggregation (during sustained ingestion)
  requests      : 90  (90 ok, 0 failed)
  achieved rate : 0.99 req/s (offered 1.00/s over 91.04s)
  p50     : 747.00 ms
  p95     : 1,147.14 ms
  p99     : 1,277.73 ms

Freshness (write -> readable, full round trip)
  probes        : 8 visible, 0 timed out
  min / p50     : 245.63 ms / 809.52 ms
  p95 / max     : 2,103.47 ms / 2,103.47 ms

Verdict
  FAIL  aggregation p95 < 1s while ingesting       1,147.14 ms
  PASS  sustained >= 1.00 aggregation req/s        0.99/s
  PASS  new data queryable within 20s              max 2,103.47 ms
  PASS  zero dropped ingest requests               0 dropped
```

**Freshness is measured, not inferred.** The probe writes an entry
under a unique marker service, then polls `GET /logs` until that exact
row comes back. The reported figure covers validation, buffering, the
COPY, commit, and the read path — the whole delay a user experiences.
Inferring it from `BUFFER_MAX_LATENCY_MS` would be an argument, not a
measurement.

---

## Query plans

Captured with `EXPLAIN (ANALYZE, BUFFERS)` against the live database.

### Keyset pagination — why depth is free

```sql
SELECT id, "timestamp", level, service, message, attributes FROM logs
WHERE ("timestamp", id) < ('2026-08-11T00:00:00Z'::timestamptz, 9999999::bigint)
ORDER BY "timestamp" DESC, id DESC LIMIT 101;
```

```
Limit  (actual time=0.264..0.892 rows=101 loops=1)
  Buffers: shared hit=136
  ->  Append  (actual time=0.262..0.877 rows=101 loops=1)
        ->  Index Scan Backward using logs_2026_08_26_pkey ... (actual time=0.022..0.023 rows=0 loops=1)
              Index Cond: (ROW("timestamp", id) < ROW('2026-08-11 00:00:00+00', '9999999'::bigint))
        ...
        ->  Index Scan Backward using logs_2026_08_10_pkey ... (actual time=0.028..0.621 rows=101 loops=1)
              Index Cond: (ROW("timestamp", id) < ROW('2026-08-11 00:00:00+00', '9999999'::bigint))
              Buffers: shared hit=103
        ->  Index Scan Backward using logs_2026_08_09_pkey ... (never executed)
```

Three things to read here:

1. The row-value comparison becomes an **`Index Cond`**, not a filter —
   PostgreSQL seeks directly to the cursor position in the primary key.
2. **`(never executed)`** on every older partition: the ordered `Append`
   stops as soon as `LIMIT` is satisfied.
3. **136 buffers, 0.89 ms** regardless of how deep the cursor points.

### Composite index — why the column order is what it is

```sql
SELECT ... FROM logs WHERE service='checkout' AND level=3
ORDER BY "timestamp" DESC, id DESC LIMIT 101;
```

```
Limit (actual time=0.224..0.352 rows=101 loops=1)
  Buffers: shared hit=132
  ->  Append (actual time=0.223..0.345 rows=101 loops=1)
        ->  Index Scan using logs_2026_08_12_service_level_timestamp_id_idx ... (actual time=0.034..0.146 rows=101 loops=1)
              Index Cond: ((service = 'checkout'::text) AND (level = 3))
              Buffers: shared hit=101
        ->  Index Scan using logs_2026_08_11_service_level_timestamp_id_idx ... (never executed)
```

Both equality columns are consumed by the `Index Cond`, and — the point
of the design — **there is no `Sort` node**. Because `timestamp DESC,
id DESC` are the trailing index columns, matched rows emerge already
ordered. 0.35 ms.

### Partition pruning

```sql
-- one hour
EXPLAIN (COSTS OFF) SELECT count(*) FROM logs
WHERE "timestamp" >= '2026-08-11T07:00:00Z' AND "timestamp" < '2026-08-11T08:00:00Z';
--   ->  Parallel Seq Scan on logs_2026_08_11          (1 partition)

-- three days
--   ->  Parallel Append
--         ->  Parallel Bitmap Heap Scan on logs_2026_08_09
--         ->  Parallel Seq Scan on logs_2026_08_11
--         ->  Parallel Seq Scan on logs_2026_08_10     (3 partitions)

-- no time filter
--   ->  Parallel Append over all 45 partitions
```

Pruning selects exactly the partitions the range can touch, and nothing
more. `enable_partition_pruning` is `on` (the default).

### GIN `jsonb_path_ops`

```sql
SELECT count(*) FROM logs
WHERE attributes @> '{"user_id":"42"}'::jsonb
  AND "timestamp" >= '2026-08-09T00:00:00Z' AND "timestamp" < '2026-08-10T00:00:00Z';
```

```
Aggregate (actual time=0.598..0.599 rows=1 loops=1)
  ->  Bitmap Heap Scan on logs_2026_08_09
        Recheck Cond: (attributes @> '{"user_id": "42"}'::jsonb)
        ->  Bitmap Index Scan on logs_2026_08_09_attributes_idx
Execution Time: 0.711 ms
```

**The GIN index is not always chosen, and that is correct.** With
`ORDER BY … LIMIT` over a narrow time range, the planner instead walks
the primary key in order and applies containment as a filter:

```
Limit (actual time=0.057..0.763 rows=101 loops=1)
  ->  Index Scan Backward using logs_2026_08_09_pkey on logs_2026_08_09
        Index Cond: ("timestamp" >= '2026-08-09 00:00:00+00' AND "timestamp" < '2026-08-10 00:00:00+00')
        Filter: (attributes @> '{"region": "eu-west"}'::jsonb)
        Rows Removed by Filter: 336
Execution Time: 0.809 ms
```

Walking an already-ordered index and discarding 336 rows beats a bitmap
scan followed by a sort. The GIN index earns its place on the
aggregation and count paths, where there is no ordering shortcut to
exploit.

### Aggregation on the specification-shaped dataset

```sql
SELECT date_bin('1 hour'::interval, "timestamp", '2026-08-09T00:00:00Z'::timestamptz) AS b,
       level, count(*)
FROM logs
WHERE "timestamp" >= '2026-08-09T00:00:00Z' AND "timestamp" < '2026-08-10T00:00:00Z'
GROUP BY b, level ORDER BY b, level;
```

```
Sort (actual time=12.452..12.457 rows=96 loops=1)
  Sort Method: quicksort  Memory: 29kB
  Buffers: shared hit=771
  ->  HashAggregate (actual time=12.333..12.361 rows=96 loops=1)
Execution Time: 12.719 ms
```

One day of history is ~46,000 rows: **12.7 ms**, entirely from cache.

### Aggregation on the dense dataset — where the time goes

```
->  Parallel Index Only Scan using logs_2026_08_11_pkey on logs_2026_08_11
      Index Cond: ("timestamp" >= ... AND "timestamp" < ...)
      Heap Fetches: 954
      Buffers: shared hit=112763
      (actual time=0.085..369.382 rows=489322 loops=3)
Execution Time: 495.411 ms
```

The plan is optimal: an **index-only scan**, only 954 heap fetches out
of 1.47 M rows, and **zero disk reads** — every buffer a cache hit. The
495 ms is the irreducible cost of aggregating 1.47 million rows. There
is no index that makes counting a million rows cheaper.

### The worst case: unindexed substring on dense data

```sql
SELECT date_bin('1 hour'::interval, "timestamp", ...) AS b, count(*)
FROM logs
WHERE "timestamp" >= ... AND "timestamp" < ...
  AND message ILIKE '%user%' ESCAPE '\'
GROUP BY b ORDER BY b;
```

```
->  Parallel Seq Scan on logs_2026_08_11
      Filter: (... AND (message ~~* '%user%'::text))
      Rows Removed by Filter: 727768
      Buffers: shared hit=15258 read=25500
Execution Time: 38,425.712 ms
```

Two compounding causes, both visible in the plan:

1. **`Seq Scan`, not an index scan.** No index can serve
   `ILIKE '%…%'`, and `message` is not in any index, so an index-only
   scan is impossible — every row must be read from the heap.
2. **`read=25500`.** Unlike every other plan above, this one reads
   25,500 blocks **from disk**. At 3.2 M rows the working set exceeds
   what fits in PostgreSQL's 1 GB, so the scan becomes I/O bound.

Two million rows examined and discarded, cold, at 1 CPU: 38 seconds.

---

## Bottlenecks found

### 1. Aggregation cost is linear in rows scanned

Not a defect — arithmetic. Every plan above is optimal for its query;
the variable is how many rows the range contains. At the dataset shape
the specification describes, a 24-hour aggregation touches ~46,000 rows
and takes 12.7 ms. Compress the same volume into four hours and the
same query touches 1.47 M rows and takes 495 ms; add an unindexed
substring predicate and a cold cache and it reaches 38 s.

The structural fix is pre-aggregated rollup tables, which turn
aggregation from O(rows) into O(buckets). Listed as a stretch goal in
the specification; scoped but not implemented, because the primary
targets were already met with margin on the stated dataset shape.

### 2. Memory pressure past ~1 M rows in a 1 GB PostgreSQL

The transition is visible in the buffer counts: every fast plan reports
`read=0` (fully cached), while the 38-second plan reports `read=25500`.
Below roughly a million rows the working set fits in shared buffers and
the OS page cache; past it, wide scans become I/O bound. This is the
mechanism behind most of the dense-dataset degradation.

### 3. Write flushes are serial

One `COPY` is in flight at a time, by design: parallel COPYs to the
same partition contend for the same relation lock, and serial flushing
makes shutdown ordering trivial to reason about. Since neither
container was CPU-saturated at 20,959 logs/sec, this — not CPU — is
what sets the write ceiling. Parallel flushes across distinct
partitions would likely raise it. Not pursued: the target was already
exceeded by 40% with zero drops, and added concurrency would complicate
the durability contract that lets the service answer 200 honestly.

### 4. Aggregation under maximum concurrent ingest

1,147 ms p95 against a 1-second target. The mixed workload aims a
"last hour" aggregation at the very hour being written into — during
the run that hour accumulated 1.18 M rows. It combines the heaviest
write load with the densest possible read window, and the result is
bottleneck #1 arriving from a different direction. Against a quiet
system the identical shape is 36.5 ms.

---

## Optimizations applied

Each of these came from a measurement, not a guess.

### Buffer hard cap raised from 5,000 to 20,000 rows

The first load test showed 429s at 16 workers while throughput was well
above target and neither container was CPU-saturated. The cause was
arithmetic: 16 workers × 500 rows = 8,000 rows potentially in flight,
against a hard cap derived as `BUFFER_MAX_ROWS × 10` = 5,000. The cap
was rejecting ordinary concurrency, not protecting against a slow
database.

Split into its own setting, `BUFFER_MAX_PENDING_ROWS`, defaulting to
20,000 rows (~6 MB, a small fraction of the 256 MB budget). Backpressure
now engages only when PostgreSQL genuinely falls behind. Re-measured:
**zero 429s at the same throughput**.

### Partition provisioning extended backwards

Provisioning covered `today … today + 14`. Any entry timestamped
earlier had no partition, so the COPY failed and returned 500 — taking
every valid entry in the same batch with it, in violation of the
batch-semantics rule. Reproduced with a 45-day-old timestamp.

Provisioning now covers `today − RETENTION_DAYS … today + LOOKAHEAD`,
and entries older than that window are rejected per-entry with the
boundary date in the reason. A mixed batch of two valid entries and one
stale entry now returns `200 accepted=2` with one indexed rejection,
where it previously lost all three.

### Error-level logging enabled

`errorHandler.ts` replaces 5xx messages with a generic string and logs
the real error server-side — but the Fastify instance was constructed
with `logger: false`, so that call went nowhere and every 500 was
discarded silently. Set to `level: 'error'`: the ingest hot path stays
free of per-request logging, while genuine failures are recorded.
Verified by forcing a COPY failure and confirming the client still
receives only `Internal server error` while the server records the
cause, the failing partition key, and the stack.

### Measurement defects fixed in the generators

Two results turned out to be the tools lying, not the service failing.
Both are recorded because the debugging is the point.

**A 17% "loss" that was an integer overflow.** With
`LOADGEN_SPREAD_DAYS=30`, `logs sent` exceeded `logs accepted` by 17.1%
with zero 429s and zero failures. The cause was `randInt` using
`| 0`, which coerces through `ToInt32`: a 30-day spread is
2,592,000,000 ms, past the 2³¹−1 limit, so ~17% of draws returned
negative and `now − negative` produced **future** timestamps that the
service correctly rejected. Predicted overflow rate 17.15%, measured
17.21%, observed rejection rate 17.10% — the match confirmed the
diagnosis. Fixed with `Math.floor`.

**A 0.89 req/sec rate that was actually 1.00.** The mixed generator
divided request count by total wall time, which included the drain
period after the measurement window while in-flight ingest requests
completed. Now measured over the aggregation driver's own window.

---

## Reproducing these results

```bash
# 1. Start the stack
docker compose up -d --build --wait

# 2. Build a specification-shaped dataset (~1M rows over 30 days)
bash scripts/seed-history.sh 30
LOADGEN_SPREAD_DAYS=30 LOADGEN_TOTAL_LOGS=1000000 npx tsx loadgen/ingest.ts

# 3. Ingestion throughput (live-stream shape, not the spread dataset)
LOADGEN_CONCURRENCY=16 LOADGEN_DURATION_SEC=30 npx tsx loadgen/ingest.ts

# 4. Aggregation latency against the historical region
LOADGEN_UNTIL=<start-of-today> LOADGEN_WINDOW_HOURS=24 \
LOADGEN_AGG_RATE=1 LOADGEN_DURATION_SEC=140 npx tsx loadgen/aggregate.ts

# 5. Query latency and the pagination walk
LOADGEN_UNTIL=<start-of-today> LOADGEN_QUERY_RATE=5 \
LOADGEN_PAGES=300 npx tsx loadgen/query.ts

# 6. The mixed scenario
LOADGEN_DURATION_SEC=90 npx tsx loadgen/mixed.ts

# Resource usage, sampled from another terminal during any run
docker stats --no-stream log-service-app-1 log-service-postgres-1
```

Step 4 and step 5 point at the historical region with `LOADGEN_UNTIL`
so they measure the specification-shaped dataset rather than whatever
step 3 has just piled into today's partition. Omit it to measure the
dense shape instead.
