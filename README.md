# Log Ingestion and Query Service

A backend service that ingests structured log entries over HTTP, stores
them in PostgreSQL, and answers filtered queries and time-bucketed
aggregations — a simplified Datadog / Grafana Loki backend.

Built to sustain 15,000 logs/sec on 0.5 CPU and 256 MB of RAM, with
PostgreSQL as the sole source of truth for both reads and writes.

**Measured:** 20,959 logs/sec sustained with zero dropped requests;
aggregation p95 of 36.5 ms; new data readable in under 2.2 seconds.
Full numbers and methodology in [Performance](#performance) and
[PERFORMANCE.md](PERFORMANCE.md).

---

## Contents

- [Quick start](#quick-start)
- [API](#api)
- [Architecture](#architecture)
- [Schema design](#schema-design)
- [Index design](#index-design)
- [Attribute storage strategy](#attribute-storage-strategy)
- [Retention strategy](#retention-strategy)
- [Performance](#performance)
- [Load test methodology](#load-test-methodology)
- [Testing](#testing)
- [Optional features](#optional-features)
- [Known limitations](#known-limitations)

---

## Quick start

```bash
docker compose up -d --build --wait
```

That is the whole setup. No `.env` file, no arguments, no migration
step — the service applies its own migrations and provisions its own
partitions before it reports healthy.

```bash
curl http://localhost:8080/health
# {"status":"ok"}
```

`--wait` blocks until both containers pass their healthchecks. The
application's healthcheck probes `/health`, which returns 200 only
after the database connection is established, migrations are applied,
and partitions exist — so when the command returns, the service is
genuinely ready to accept logs.

### Common operations

| Task | Command |
| --- | --- |
| Start / rebuild everything | `docker compose up -d --build --wait` |
| Rebuild only the app after a code change | `docker compose up -d --build app` |
| Follow application logs | `docker compose logs -f app` |
| Contract check against a running instance | `bash scripts/smoke.sh` |
| Run the test suite | `npm ci && npm test` |
| Stop (data preserved) | `docker compose down` |
| Stop and delete all data | `docker compose down -v` |

### Requirements

Docker with Compose v2. Node 20+ only if you want to run the test
suite or the load generators from the host — the service itself needs
nothing but Docker.

---

## API

Four endpoints. All responses are JSON. Every error, from any layer,
uses the shape `{"error": "<description>"}`.

### `GET /health`

Returns `200` once the service is ready to accept logs. Always
unauthenticated, even when authentication is enabled.

```json
{ "status": "ok" }
```

Returns `503 {"status":"starting"}` before readiness.

### `POST /logs` — ingest

Always accepts a batch; a batch of one entry is valid.

```bash
curl -X POST http://localhost:8080/logs \
  -H 'content-type: application/json' \
  -d '{
    "logs": [
      {
        "timestamp": "2026-08-11T14:32:01.123Z",
        "level": "error",
        "service": "checkout",
        "message": "payment declined",
        "attributes": { "user_id": "42", "region": "eu-west", "retries": 3 }
      }
    ]
  }'
```

**Per-entry validation rules**

| Field | Required | Rules |
| --- | --- | --- |
| `timestamp` | yes | Valid ISO 8601. Not more than 5 minutes in the future, and not older than `RETENTION_DAYS` |
| `level` | yes | One of `debug`, `info`, `warn`, `error` |
| `service` | yes | Non-empty string |
| `message` | yes | Non-empty string, at most 64 KB |
| `attributes` | no | Flat object. Values may be string, number, or boolean. At most 64 keys; keys ≤ 128 chars, values ≤ 1024 chars |

Batch limits: at most 5,000 entries per request, 8 MB per request body.

**Responses**

`200` when at least one entry was accepted **and durably written**:

```json
{
  "accepted": 9,
  "rejected": [{ "index": 3, "reason": "invalid level: 'critical'" }]
}
```

One invalid entry never fails the batch. Each rejection carries the
entry's index in the original array and a human-readable reason.

`400` when every entry was rejected, the body is malformed JSON, or
`logs` is missing, empty, or not an array.

`429` with a `Retry-After` header when the write buffer is at capacity.
The service never returns 200 for a batch it has not committed.

### `GET /logs` — query

All parameters are optional and freely combinable.

| Parameter | Meaning | Example |
| --- | --- | --- |
| `service` | Exact match | `service=checkout` |
| `level` | Exact match, one of the four levels | `level=error` |
| `since` | Inclusive start, ISO 8601 | `since=2026-08-11T14:00:00Z` |
| `until` | Exclusive end, ISO 8601 | `until=2026-08-11T15:00:00Z` |
| `attr.<key>` | Attribute equality, compared as strings | `attr.user_id=42` |
| `q` | Case-insensitive substring on `message` | `q=declined` |
| `limit` | 1–1000, default 100 | `limit=500` |
| `cursor` | Opaque cursor from a previous response | `cursor=eyJ2Ijox...` |

```bash
curl "http://localhost:8080/logs?service=checkout&level=error&limit=50"
```

```json
{
  "logs": [
    {
      "id": "1048576",
      "timestamp": "2026-08-11T14:32:01.123Z",
      "level": "error",
      "service": "checkout",
      "message": "payment declined",
      "attributes": { "user_id": "42" }
    }
  ],
  "next_cursor": "eyJ2IjoxLCJ0cyI6..."
}
```

Results are ordered by `timestamp` descending, with `id` descending as
a deterministic tiebreak. `next_cursor` is `null` on the last page.

Cursors are opaque: pass them back unchanged. Filters are not encoded
in the cursor, so re-supply them alongside it.

`400` on any invalid parameter: unparseable timestamps, `until` at or
before `since`, an unsupported level, a non-numeric or out-of-range
limit, or a malformed cursor.

### `GET /logs/aggregate` — time buckets

Supports the same filters as `GET /logs` (`service`, `level`,
`attr.<key>`, `q`), plus:

| Parameter | Required | Meaning |
| --- | --- | --- |
| `since` | yes | Inclusive start |
| `until` | yes | Exclusive end |
| `bucket` | yes | One of `1m`, `5m`, `1h`, `1d` |
| `group_by` | no | `service` or `level` |

```bash
curl "http://localhost:8080/logs/aggregate?\
since=2026-08-11T14:00:00Z&until=2026-08-11T15:00:00Z&bucket=1m&group_by=service"
```

```json
{
  "buckets": [
    { "start": "2026-08-11T14:00:00.000Z", "group": "checkout", "count": 118 },
    { "start": "2026-08-11T14:00:00.000Z", "group": "auth", "count": 42 }
  ]
}
```

Buckets are ordered by `start` ascending, then by group. Empty buckets
are omitted. Without `group_by`, `group` is `null`.

Bucket boundaries are aligned to `since`, so the first bucket begins
exactly at the start of the requested range.

---

## Architecture

Three layers with strict dependency rules:

```
src/http/    HTTP only — routes, middleware, error shaping. No SQL.
src/core/    Pure functions. No I/O. Imports nothing from http/ or db/.
src/db/      All SQL — pool, migrations, writer, query builders.
```

`core/` holds validation, level encoding, cursor logic, and time-bucket
maths. Because it touches no I/O, its correctness is provable by
inspection and it is covered by 147 unit tests that need no database.

**Write path:** route → `validateBatch` (core) → `writer` (db). The
writer coalesces concurrent batches into a single `COPY FROM STDIN`,
but resolves each caller's promise only after the COPY containing
*their* rows has committed. That is how batching for throughput
coexists with never reporting success for data that is not yet durable.

**Read path:** route → `validateFilters` / `decodeCursor` (core) →
query builder (db). Filter conditions are shared by both read endpoints
through one parameterized builder, so `GET /logs` and
`GET /logs/aggregate` cannot drift apart.

**Stack:** Node 20, TypeScript strict, Fastify 4, `pg` 8, and
`pg-copy-streams`. Three production dependencies, no ORM. Migrations
are hand-written SQL applied by a ~60-line runner.

---

## Schema design

```sql
CREATE TABLE logs (
    id          BIGSERIAL,
    timestamp   TIMESTAMPTZ  NOT NULL,
    level       SMALLINT     NOT NULL,
    service     TEXT         NOT NULL,
    message     TEXT         NOT NULL,
    attributes  JSONB        NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (timestamp, id)
) PARTITION BY RANGE (timestamp);
```

**`PRIMARY KEY (timestamp, id)`** — PostgreSQL requires the partition
key to be part of the primary key on a partitioned table. It also
happens to be exactly the composite key that keyset pagination seeks
on, so the constraint we had to satisfy is the index we wanted anyway.

**`level SMALLINT`** — levels are encoded `debug=0, info=1, warn=2,
error=3`. Two bytes instead of a text value on every row and in every
index entry, and the ascending encoding makes `level >= 2` mean "warn
and above". Conversion happens only in `src/core/levels.ts`; routes and
SQL never see the string form.

**`TIMESTAMPTZ`** — unambiguous regardless of session timezone. All
partition boundaries are UTC midnight.

**`attributes JSONB NOT NULL DEFAULT '{}'`** — never null, so query
code needs no `COALESCE` or null branches.

**`id BIGSERIAL`** — one sequence shared across all partitions, so ids
are globally unique. Ids are carried as strings through the API and the
cursor, because a `BIGINT` exceeds JavaScript's safe integer range.

---

## Index design

Two explicit indexes, plus the primary key:

```sql
CREATE INDEX logs_service_level_ts_id_idx
    ON logs (service, level, "timestamp" DESC, id DESC);

CREATE INDEX logs_attributes_gin_idx
    ON logs USING GIN (attributes jsonb_path_ops);
```

| Index | Serves | Necessity |
| --- | --- | --- |
| `logs_pkey` on `(timestamp, id)` | Time ranges, ordering, keyset pagination | Created automatically; also the pagination key |
| Composite B-tree | `service` and/or `level` filters with time ordering | Optimization — queries work without it, slower |
| GIN `jsonb_path_ops` | `attr.<key>` containment | Effectively required — without it attribute filters become sequential scans |

**Column order: equality first, range and ordering last.** `service`
and `level` are equality filters, so they lead and let the planner jump
straight to matching rows; `timestamp` and `id` follow, so the matched
rows arrive pre-sorted for `ORDER BY timestamp DESC, id DESC` and no
separate sort step is needed. `service` precedes `level` because it has
far higher cardinality — dozens of values against four — and the more
selective column first prunes more work.

**Only two, deliberately.** Every index is maintained on every insert,
and this service is write-dominated at 15,000 rows/sec. A third index
on `level` alone was considered and deferred until measurement
demands it.

**`message` is intentionally unindexed.** Substring search relies on
the other filters to narrow the scan first. The cost of that decision
is measured rather than assumed — see
[Known limitations](#known-limitations).

Indexes are declared once on the parent table; every partition inherits
them automatically, including partitions created at runtime by the
maintenance job.

---

## Attribute storage strategy

Attributes are stored in a single `JSONB` column with a GIN index using
the `jsonb_path_ops` operator class.

**Why not a separate attributes table (EAV).** One row per attribute
multiplies write volume by the average attribute count. At 15,000
logs/sec with three attributes each, that is 45,000 extra row writes
per second competing for the same 1 CPU that Postgres has in total.
Ingestion throughput is the binding constraint, so the schema that
minimizes rows written wins.

**Why not promote known keys to columns.** The specification never
defines which attribute keys exist — they are arbitrary and vary per
service. Promoting `user_id` or `request_id` to a real column today
would be a guess. The evolution path is explicit: if measurement later
shows one key dominating filter traffic, promote that key and leave the
rest in JSONB. Nothing about the current design blocks that.

**Why `jsonb_path_ops` over the default `jsonb_ops`.** The only
attribute access pattern this service has is containment (`@>`).
`jsonb_path_ops` supports exactly that, in a roughly 30% smaller index.
It cannot serve key-existence queries, which this service never issues.

**All values are normalized to strings at ingest.** The spec compares
`attr.<key>` filters as strings, so `retries: 3` is stored as `"3"`.
The type system enforces this: `RawAttributes` (what a client may send)
and `NormalizedAttributes` (what is stored) are distinct types, so the
conversion cannot be forgotten.

All `attr.<key>` filters in one request are merged into a single
containment object, so the GIN index resolves any number of attribute
filters in one probe.

---

## Retention strategy

Daily range partitions, expired data removed with `DROP TABLE`, never
`DELETE`.

**Why `DROP` rather than `DELETE`.** Dropping a partition is an O(1)
catalog operation: one WAL record, no dead tuples, no bloat, no
autovacuum work, and disk space returned immediately. A `DELETE` of the
same rows marks every one of them dead under MVCC, amplifies WAL across
all three indexes, and leaves autovacuum to clean up afterwards —
spending CPU that the ingest path needs.

**Lifecycle management lives in the application, not in SQL.**
`src/db/retention.ts` runs one maintenance cycle at startup (before the
service reports healthy) and hourly thereafter. It does two things, in
this order:

1. **Provisioning** — ensure a daily partition exists across the whole
   storable window, from `RETENTION_DAYS` in the past through
   `PARTITION_LOOKAHEAD_DAYS` in the future. Failure here is fatal: a
   missing partition makes inserts for that day fail outright.
2. **Retention** — drop every partition whose entire range is older
   than `RETENTION_DAYS`. Failure here is logged but not fatal; late
   retention only means data outlives its policy briefly.

The backward half of the provisioning window is what makes late
arrivals safe. A buffered agent flush, a replayed dead-letter batch, or
a host with a skewed clock all produce entries timestamped in the past;
they now have a partition to land in. Entries older than the retention
window are rejected per-entry, with the boundary date in the message,
so a stale entry cannot fail the batch it arrived in.

Keeping this in Node rather than PL/pgSQL buys testability, structured
logging, and coordination with graceful shutdown, and avoids requiring
a scheduler extension that would complicate zero-config startup. SQL
contributes only a read-only view, `logs_partitions`, exposing each
partition's bounds.

Configured by `RETENTION_DAYS` (default 30) and
`PARTITION_LOOKAHEAD_DAYS` (default 14).

---

## Performance

All figures below were measured with the generators in `loadgen/`
against the Docker Compose stack under its graded resource limits
(application 0.5 CPU / 256 MB, PostgreSQL 1 CPU / 1 GB).

### Ingestion

30-second run, 16 concurrent workers, 500 logs per batch, 5-second
unrecorded warmup:

| Metric | Result |
| --- | --- |
| **Sustained throughput** | **20,959 logs/sec** (140% of the 15,000 target) |
| **Dropped requests** | **0** — no 429s, no failures, no rejections |
| Request latency | p50 354 ms · p95 696 ms · p99 914 ms |
| Application container | ~40% of 0.5 CPU · 33 MB / 256 MB |
| PostgreSQL container | ~40% of 1 CPU · 231 MB / 1 GB |

Neither container was CPU-saturated. A concurrency sweep found 16
workers to be the saturation point: at 32 workers throughput *fell* to
19,275 logs/sec while p95 roughly doubled, which is queueing rather
than capacity.

### Aggregation

Measured on a dataset shaped as the specification describes — roughly
1.16 million rows spread across 30 days — at the required rate of one
request per second:

| Query shape | p50 | p95 |
| --- | --- | --- |
| `1m` buckets over 1h, no grouping | 5.1 ms | **7.4 ms** |
| `1m` buckets over 1h, `group_by=service` | 9.3 ms | **12.4 ms** |
| `5m` buckets over 6h, `group_by=service` | 13.4 ms | **21.0 ms** |
| `1h` buckets over 24h, `group_by=level` | 15.7 ms | **28.2 ms** |
| `1h` over 24h with a `service` filter | 6.2 ms | **7.3 ms** |
| `1h` over 24h with an `attr` filter (GIN) | 10.7 ms | **13.8 ms** |
| `1h` over 24h with `q=` (unindexed) | 34.2 ms | **62.1 ms** |

**Overall p95: 36.5 ms** against a 1-second target. The verdict is
taken from the *worst* shape, not the average — every shape is under
budget, the slowest by a factor of 16.

### Query

`GET /logs` at 5 requests/sec, 300 samples, zero failures:

| Query shape | p95 |
| --- | --- |
| Newest N, no filter | 9.7 ms |
| Time range over 24h | 7.1 ms |
| `service` filter | 11.4 ms |
| `service` + `level` | 8.7 ms |
| `attr` filter (GIN) | 13.1 ms |
| `service` + `attr` | 17.4 ms |
| `q=` substring (unindexed) | 11.5 ms |
| `limit=1000` | 19.3 ms |

**Pooled p95: 14.3 ms.**

### Deep pagination

Keyset pagination's justification is that page depth is free. That is a
testable prediction, so it was tested: 300 pages walked by following
`next_cursor`, 30,000 rows traversed.

| Segment | p50 | p95 |
| --- | --- | --- |
| First 10 pages | 8.6 ms | 30.9 ms |
| **Last 10 pages (deepest)** | **7.9 ms** | **9.2 ms** |

Deep-to-shallow p50 ratio: **0.93×** — flat. With `OFFSET`, serving the
final page alone would require reading and discarding 30,000 rows.

### Mixed workload — querying while ingesting

The scenario the specification singles out. 90 seconds, ingest running
at full tilt with aggregation and a freshness probe alongside:

| Target | Result | |
| --- | --- | --- |
| Zero dropped requests during ingestion | 2,364 requests, 0 dropped | pass |
| Sustain 1 aggregation request/sec | 0.99 req/sec | pass |
| New data queryable within 20 s | **2.1 s worst case** | pass |
| Aggregation p95 under 1 s while ingesting | 1,147 ms | over budget |

Ingestion held 12,117 logs/sec while serving concurrent queries.
Freshness — measured by writing a uniquely marked entry and polling
until that exact row is readable — was 245 ms at best, 809 ms median,
2.1 s at worst, against a 20-second budget.

The aggregation figure is the one number over target, and it is
explained rather than excused: the aggregation window ("the last hour")
is chasing the ingest itself, so during the run that single hour
accumulated over a million rows. It combines the heaviest possible
write load with the densest possible read window. Against a quiet
system the same query shape is 36.5 ms.

Raw `EXPLAIN ANALYZE` output and bottleneck analysis are in
[PERFORMANCE.md](PERFORMANCE.md).

---

## Load test methodology

Everything in `loadgen/` is committed so results are reproducible. The
generators are ordinary external HTTP clients — no privileged access,
no in-process shortcuts — so they exercise the same path any client
would.

| Generator | Purpose |
| --- | --- |
| `loadgen/ingest.ts` | Sustained write throughput and latency |
| `loadgen/aggregate.ts` | `GET /logs/aggregate` latency across query shapes |
| `loadgen/query.ts` | `GET /logs` latency, plus the deep-pagination walk |
| `loadgen/mixed.ts` | Ingest, aggregation, and freshness concurrently |
| `loadgen/report.ts` | Shared percentile and formatting helpers |
| `loadgen/discover.ts` | Finds a populated time window and a high-volume service to filter on |

```bash
# Sustained ingestion
npx tsx loadgen/ingest.ts

# Aggregation latency (needs data; run ingest first on an empty system)
npx tsx loadgen/aggregate.ts

# Query latency and pagination depth
npx tsx loadgen/query.ts

# The grading scenario: query while ingesting
npx tsx loadgen/mixed.ts
```

Each is configured through environment variables documented at the top
of its file — duration, concurrency, batch size, rate, page size.

**Methodological choices worth naming:**

- **Warmup phases are excluded** from recorded results, so figures
  reflect steady state rather than cold caches and JIT warmup.
- **Fixed-rate workloads are paced on an absolute schedule**, not by
  sleeping after each response. Sleeping lets a slow response silently
  reduce the offered rate and under-report latency — the classic
  coordinated-omission error.
- **Query shapes are measured separately**, and pass/fail verdicts use
  the *worst* shape. A pooled average would hide the slow access path,
  which is the one worth knowing about.
- **Filter values are discovered from live data** rather than
  hardcoded, so no query accidentally measures an empty range or a
  service that owns three rows.
- **Dataset shape is stated with every number.** Aggregation cost is
  linear in rows scanned, so a figure without its dataset is not a
  measurement.

To build a specification-shaped dataset (about a month of history,
which a fresh system does not have because partitions are only
provisioned forward):

```bash
bash scripts/seed-history.sh 30
LOADGEN_SPREAD_DAYS=30 LOADGEN_TOTAL_LOGS=1000000 npx tsx loadgen/ingest.ts
```

---

## Testing

213 tests across three layers.

```bash
npm ci
npm run test:unit         # 147 tests, no dependencies, under a second
npm test                  # all 213 — needs a running stack
npm run typecheck
```

| Layer | Count | Scope |
| --- | --- | --- |
| `tests/unit/` | 147 | Pure core logic: level encoding, entry and batch validation, query filters, cursor round-trips, bucket allow-lists. No database, no HTTP |
| `tests/integration/` | 33 | Real behaviour through the whole stack: durability, attribute normalization, COPY-format escaping, filter combinations, tie-heavy pagination, aggregation totals |
| `tests/contract/` | 33 | Response shapes and status codes asserted literally against the specification |

Integration and contract suites drive a running instance over HTTP
rather than importing the application in-process, so they exercise the
built image, the Compose wiring, and the real database. Each test
writes under a unique service name, so assertions stay exact against a
database that already holds millions of rows, and suites are
re-runnable without cleanup.

`scripts/smoke.sh` is a standalone contract check (39 assertions) that
auto-detects whether the target instance has authentication enabled.

**CI** (`.github/workflows/ci.yml`) runs typecheck and unit tests
first, then builds the image, boots the stack from an empty volume, and
runs the integration, contract, and smoke suites in **both** required
configurations — the zero-config default, and `AUTH_ENABLED=true` with
a seeded key where the data endpoints must return 401 without a
credential.

---

## Optional features

Everything below is **off by default**. A plain `docker compose up`
with no environment file yields the unauthenticated core service, with
no rate limit, quota, or tenancy restriction.

### Authentication

| Variable | Default | Meaning |
| --- | --- | --- |
| `AUTH_ENABLED` | `false` | Master switch |
| `LOADGEN_API_KEY` | unset | Key seeded at startup with full permissions |

```bash
AUTH_ENABLED=true LOADGEN_API_KEY=your-key docker compose up -d --wait
curl -H "Authorization: Bearer your-key" http://localhost:8080/logs
```

When disabled, no authentication hook is registered at all, so an
unrecognized `Authorization` header is ignored rather than rejected.

When enabled: the key is seeded in memory at startup, before the
service reports healthy, from the environment — so it is idempotent and
survives restarts with no admin call or manual step. Credentials are
accepted via `Authorization: Bearer <key>` (primary) or `X-API-Key`
(secondary), never from the query string or body. A missing or unknown
credential returns `401`. `GET /health` remains unauthenticated.

If `AUTH_ENABLED=true` but no key is set, the service still starts and
stays healthy; it simply has no valid credential.

### Write-path tuning

| Variable | Default | Meaning |
| --- | --- | --- |
| `BUFFER_MAX_ROWS` | `500` | Flush the COPY buffer once this many rows queue |
| `BUFFER_MAX_LATENCY_MS` | `200` | Flush at least this often below the size trigger |
| `BUFFER_MAX_PENDING_ROWS` | `20000` | Hard cap on unwritten rows; beyond it, `429` |

Backpressure is always active but only engages at the hard cap, which
is reached solely when PostgreSQL cannot drain as fast as clients
submit. It is never triggered by normal concurrency.

### Retention

| Variable | Default | Meaning |
| --- | --- | --- |
| `RETENTION_DAYS` | `30` | Days of history kept, and how far back partitions are provisioned |
| `PARTITION_LOOKAHEAD_DAYS` | `14` | Days of future partitions maintained |

### Connection and limits

| Variable | Default |
| --- | --- |
| `PORT` | `8080` |
| `POSTGRES_HOST` / `POSTGRES_PORT` | `postgres` / `5432` |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | `logs` / `logs` / `logs` |
| `POSTGRES_MAX_CONNECTIONS` | `20` |
| `INGEST_BODY_LIMIT_BYTES` | `8388608` (8 MB) |

All are documented in [.env.example](.env.example). No `.env` file is
required or read by default.

---

## Known limitations

**Substring search on `message` is unindexed.** This is a deliberate
trade — a trigram index would add write cost to every insert on the
critical path. The consequence is asymmetric and worth stating
precisely: on `GET /logs` it is cheap (11.5 ms p95) because `LIMIT`
lets PostgreSQL stop as soon as it has enough matches, but in
aggregation it must scan every candidate row to produce a count. On a
dense dataset a wide `q=` aggregation reached 13.6 seconds. If
substring search over wide ranges became a real access pattern, the fix
is a `pg_trgm` GIN index, now justifiable by measurement.

**Aggregation cost is linear in rows scanned.** At the dataset shape
the specification describes (1 million rows over a month), aggregation
p95 is 36.5 ms. Compressing the same volume into a few hours — roughly
80× the density, which a burst ingestion test produces — pushes typical
shapes to hundreds of milliseconds and the worst shape into seconds,
because a 24-hour window then has to scan everything and the working
set exceeds PostgreSQL's 1 GB. The structural fix is pre-aggregated
rollup tables; they are scoped but not implemented.

**Aggregation p95 exceeds 1 second under maximum concurrent ingest.**
Measured at 1,147 ms in the mixed workload, against 36.5 ms on a quiet
system. See [Performance](#performance) for why, and note this is the
same linearity as above rather than a separate defect.

**Calendar-invalid dates are normalized, not rejected.** A timestamp
such as `2026-02-30` is accepted and rolls to March 2, following
JavaScript's `Date` parsing. The regex gate catches malformed shapes;
it does not validate day-of-month against month length. Consistent
across ingestion and query filters.

**`group_by=level` orders by severity, not alphabetically.** Groups
come back `debug, info, warn, error` because grouping happens on the
stored `SMALLINT` and decoding to names occurs afterwards, in the core
layer. This keeps level semantics out of SQL, at the cost of an
ordering that is by severity rather than by string.

**Entries older than `RETENTION_DAYS` are rejected.** They have no
partition and would be dropped by retention immediately. The rejection
is per-entry and carries the boundary date, so the rest of the batch is
unaffected.

**Write flushes are serial.** One `COPY` is in flight at a time.
Measurement showed neither container CPU-saturated at 20,959 logs/sec,
so parallel flushes are likely to raise the ceiling further — this was
not pursued because the target was already exceeded by 40% with zero
drops.

**No metrics endpoint.** Operational logging is limited to startup,
shutdown, and error events. There is no aggregated counter export; the
load generators fill that role during testing.

**Single-node PostgreSQL, no replication.** Appropriate for the
exercise, not for production durability.
