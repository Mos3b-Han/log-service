# CLAUDE.md — Log Ingestion and Query Service

This file is the persistent brief for Claude Code working on this project.
Read it in full before any task. Follow it strictly.

---

## 1. What This Project Is

A backend service that ingests structured log entries via HTTP, stores them
in PostgreSQL, and answers queries and time-bucketed aggregations. Think of
it as a simplified Datadog or Grafana Loki backend.

The project is a graded interview submission. The reviewer will:
- Run an automated load generator against the service
- Read the code and the README
- Interview the author about every decision
- Decide hiring based on the demo and the defense of decisions

The single most important rule for this project:

> **Code that cannot be explained by the author does not count as completed work.**

This shapes everything below.

---

## 2. How You (Claude Code) Must Behave

You are the executor, not the engineer. The author (the user talking to you)
is the engineer. Your job is to write code the author has decided on, at the
level of quality they specify, in the exact scope they specify.

### Rules you must follow

1. **Never expand scope.** If asked to create four files, create four files.
   Do not add "helpful" extras. Do not create `package.json` unless asked.
   Do not run `npm install` unless asked.

2. **Never scaffold destructively.** Before any command that creates or
   modifies files, verify `pwd` first. If the working directory is not
   `~/projects/log-service`, stop and ask.

3. **Never add dependencies silently.** If a task seems to require a new
   package, propose it with a one-line justification and wait for approval.

4. **Ask before assuming.** If the task is ambiguous, ask one specific
   clarifying question. Never invent behavior to fill a gap.

5. **Small commits, clear messages.** Use conventional commits format:
   `feat:`, `fix:`, `chore:`, `docs:`, `perf:`, `refactor:`, `test:`.
   Each commit should represent one coherent change.

6. **Never touch `.env` files or commit secrets.** All configuration is
   documented in `.env.example` with safe defaults.

7. **Explain your work when done.** After finishing a task, list what
   changed and why in three sentences maximum. The user will verify.

### Rules you must NOT violate

- Do not use `OFFSET` for pagination anywhere. Use keyset pagination only.
- Do not build SQL by string concatenation. Every value passes as a
  parameter. Every dynamic identifier is validated against an allow-list.
- Do not use `console.log` inside the ingest hot path (per-log logging).
- Do not throw exceptions inside per-entry validation loops. Return
  result objects instead.
- Do not add an ORM to the hot write path. Drizzle is used only for
  schema definition and migrations; hot-path SQL is raw via `pg`.
- Do not add authentication, rate limiting, multi-tenancy, dashboards,
  metrics exporters, or any optional feature unless the user requests it
  explicitly. The default posture is zero-configuration core service.

---

## 3. Hard Constraints from the Grading Spec

These are non-negotiable and set by the graders, not by us.

### Resource limits

| Container   | CPU   | RAM     |
| ----------- | ----- | ------- |
| Application | 0.5   | 256 MB  |
| PostgreSQL  | 1     | 1 GB    |

### Performance targets

| Metric                               | Target                |
| ------------------------------------ | --------------------- |
| Sustained ingestion                  | ≥ 15,000 logs/sec     |
| Aggregation p95                      | < 1 second            |
| Stored dataset                       | ~1,000,000 rows       |
| Data visibility after ingest         | ≤ 20 seconds          |
| Aggregation query rate under load    | 1/sec                 |
| Dropped requests during ingestion    | zero                  |

### Startup contract

- The complete system must start with `docker compose up`, no extra steps
- Service listens on port 8080 inside container, exposed as
  `localhost:8080` on the host
- `GET /health` must return 200 only after: DB connection established,
  migrations applied, service ready to accept logs
- Zero configuration by default — no env file required for the base
  contract to work

### Load generator behavior

The graders' load generator will:
- Poll `GET /health` until 200 before starting
- Always send `Authorization: Bearer <key>` on the three data endpoints
- Treat cursors as opaque values and pass them back unchanged
- Test both `AUTH_ENABLED=false` and `AUTH_ENABLED=true` configurations

When `AUTH_ENABLED=false` (the default), an unrecognized `Authorization`
header must be **ignored**, not rejected. This is a deliberate test.

---

## 4. Confirmed Architectural Decisions

Do not re-decide these. They are set.

### Language and runtime
- **Node.js** (LTS version) + **TypeScript** (strict mode)
- **Fastify** as the HTTP framework (chosen over Express for lower
  overhead per request on the hot path)

### Database
- **PostgreSQL 16** as the sole source of truth for reads and writes
- **Drizzle ORM** for schema definition and migrations only
- **Raw SQL** via `pg` for the hot path (write and query execution)
- **`pg-copy-streams`** for bulk writes via COPY protocol

### Architecture pattern
- **Layered architecture** with three layers: `http`, `core`, `db`
- The `core` layer imports from neither `http` nor `db`
- The `core` layer contains pure functions with no I/O
- All HTTP concerns live in `http/`, all SQL lives in `db/`

### Retention strategy
- **Range partitioning** on the timestamp column (daily partitions)
- Retention implemented by `DROP TABLE` on old partitions, never `DELETE`
- Partitions are created ahead of time by a scheduled task

### Attribute storage
- Attributes stored as `JSONB` column on the logs table
- **GIN index** using `jsonb_path_ops` operator class for `@>` queries
- All attribute values normalized to strings at ingest time (since the
  spec compares them as strings)

### Pagination
- **Keyset (seek) pagination** using `(timestamp, id)` composite key
- Cursor is opaque base64-encoded JSON with a version field
- Cursor decoding is defensive; invalid cursors return 400

---

## 5. Technology Stack (Exact Versions)

Package versions to be confirmed at scaffolding time. Baseline:

```
Node.js:          20.x LTS
TypeScript:       5.x
Fastify:          4.x
pg:               8.x
pg-copy-streams:  6.x
Drizzle ORM:      latest stable
Drizzle Kit:      latest stable
PostgreSQL:       16.x (in Docker)
```

**No frontend framework, no UI library, no state management, no ORM
beyond Drizzle for schema, no logging framework beyond a minimal
internal logger.**

Any additional dependency requires explicit user approval.

---

## 6. Project Structure

Create files only as they become needed. Do not create empty placeholder
files. The final tree looks like:

```
log-service/
├── docker-compose.yml
├── Dockerfile
├── .dockerignore
├── .env.example
├── .gitignore
├── .github/
│   └── workflows/
│       └── ci.yml
├── README.md
├── DESIGN.md
├── PERFORMANCE.md
├── CLAUDE.md                       ← this file
├── package.json
├── tsconfig.json
├── drizzle.config.ts
├── migrations/                     ← raw SQL migration files
│   ├── 001_init.sql
│   ├── 002_partitions.sql
│   └── 003_retention.sql
├── loadgen/                        ← author's own load generator
│   ├── ingest.ts
│   └── query.ts
├── tests/
│   ├── unit/
│   ├── integration/
│   └── contract/
└── src/
    ├── index.ts
    ├── config.ts
    ├── shutdown.ts
    ├── readiness.ts
    ├── http/
    │   ├── server.ts
    │   ├── errorHandler.ts
    │   ├── routes/
    │   │   ├── health.ts
    │   │   ├── ingest.ts
    │   │   ├── query.ts
    │   │   └── aggregate.ts
    │   └── middleware/
    │       ├── auth.ts
    │       └── requestLog.ts
    ├── core/                       ← pure, no I/O, no imports from http or db
    │   ├── types.ts
    │   ├── validation/
    │   │   ├── validateEntry.ts
    │   │   ├── validateBatch.ts
    │   │   └── validateFilters.ts
    │   ├── pagination/
    │   │   ├── cursor.ts
    │   │   └── keyset.ts
    │   └── time/
    │       └── buckets.ts
    ├── db/
    │   ├── schema.ts               ← Drizzle schema
    │   ├── pool.ts
    │   ├── migrate.ts
    │   ├── queryBuilder.ts
    │   ├── writer/
    │   │   ├── buffer.ts
    │   │   ├── batchWriter.ts
    │   │   └── backpressure.ts
    │   ├── queries/
    │   │   ├── list.ts
    │   │   └── aggregate.ts
    │   └── retention.ts
    └── observability/
        ├── metrics.ts
        └── logger.ts
```

---

## 7. API Contract (Verbatim from Spec)

Every endpoint below must match the spec exactly. Response shapes and
status codes are not negotiable.

### GET /health

- Returns 200 with any body once ready
- Ready means: DB connected + migrations applied + service accepting logs
- Always unauthenticated

### POST /logs

Request body:
```json
{
  "logs": [
    {
      "timestamp": "2026-07-20T14:32:01.123Z",
      "level": "error",
      "service": "checkout",
      "message": "payment declined",
      "attributes": {
        "user_id": "42",
        "region": "eu-west",
        "retries": 3
      }
    }
  ]
}
```

Response (200):
```json
{
  "accepted": 9,
  "rejected": [
    { "index": 3, "reason": "invalid level: 'critical'" }
  ]
}
```

Status codes:
- **200**: at least one entry accepted
- **400**: all entries rejected, malformed JSON, or wrong top-level shape

Error body always: `{"error": "<description>"}`

### GET /logs

Query parameters (all optional, freely combinable):

| Param        | Meaning                                       |
| ------------ | --------------------------------------------- |
| `service`    | exact match                                   |
| `level`      | exact match, one of debug/info/warn/error     |
| `since`      | ISO 8601, inclusive start                     |
| `until`      | ISO 8601, exclusive end                       |
| `attr.<key>` | attribute equality, compared as strings       |
| `q`          | case-insensitive substring on `message`       |
| `limit`      | default 100, max 1000                         |
| `cursor`     | opaque, from previous response                |

Response (200):
```json
{
  "logs": [
    {
      "id": "any-unique-id",
      "timestamp": "2026-07-20T14:32:01.123Z",
      "level": "error",
      "service": "checkout",
      "message": "payment declined",
      "attributes": { "user_id": "42" }
    }
  ],
  "next_cursor": "eyJpZCI6..."
}
```

- `next_cursor` is `null` when no more results
- Results sorted by timestamp DESC with deterministic tiebreak by id DESC

Status codes:
- **200**: normal response (may be empty logs array)
- **400**: invalid parameters (bad timestamp, until < since, invalid
  level, non-numeric limit, out-of-range limit, invalid cursor)

### GET /logs/aggregate

Query parameters:

| Param        | Required | Meaning                          |
| ------------ | -------- | -------------------------------- |
| `since`      | yes      | ISO 8601, inclusive start        |
| `until`      | yes      | ISO 8601, exclusive end          |
| `bucket`     | yes      | one of `1m`, `5m`, `1h`, `1d`    |
| `group_by`   | no       | `service` or `level`             |
| `service`    | no       | filter                           |
| `level`      | no       | filter                           |
| `attr.<key>` | no       | filter                           |
| `q`          | no       | filter                           |

Response (200):
```json
{
  "buckets": [
    { "start": "2026-07-20T14:00:00Z", "group": "checkout", "count": 118 },
    { "start": "2026-07-20T14:00:00Z", "group": "auth",     "count": 42  }
  ]
}
```

- Ordered by `start` ASC, then `group` ASC
- Empty buckets may be omitted
- When no `group_by`, `group` field is `null`

---

## 8. Validation Rules (Verbatim from Spec)

### Per log entry

| Field        | Required | Rules                                              |
| ------------ | -------- | -------------------------------------------------- |
| `timestamp`  | yes      | valid ISO 8601, ≤ 5 minutes in the future          |
| `level`      | yes      | one of: `debug`, `info`, `warn`, `error`           |
| `service`    | yes      | non-empty string                                   |
| `message`    | yes      | non-empty string                                   |
| `attributes` | no       | flat object; values: string, number, or boolean    |

### Batch behavior

- One invalid entry does NOT fail the batch
- Return `{ index, reason }` for each rejected entry
- If `logs` is empty or missing, return 400
- Enforce a maximum batch size (recommended: 5,000 entries)
- Enforce a maximum message length (recommended: 64 KB)
- Enforce a maximum attribute count and value length per entry

### Query parameter validation

- `since`, `until`: must parse as ISO 8601
- `until` must be after `since` (return 400 otherwise)
- `level`: must be one of the four allowed values
- `limit`: integer, 1 ≤ limit ≤ 1000, default 100
- `cursor`: base64 decode + JSON parse + version check; any failure = 400
- `bucket`: exactly one of `1m`, `5m`, `1h`, `1d`
- `group_by`: exactly `service` or `level`

---

## 9. Schema Design

Base table (in migration `001_init.sql`):

```sql
CREATE TABLE logs (
    id           BIGSERIAL,
    timestamp    TIMESTAMPTZ  NOT NULL,
    level        SMALLINT     NOT NULL,    -- enum-encoded, see below
    service      TEXT         NOT NULL,
    message      TEXT         NOT NULL,
    attributes   JSONB        NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (timestamp, id)             -- required for partitioning
) PARTITION BY RANGE (timestamp);
```

### Level encoding

Store level as `SMALLINT` for compactness and index efficiency:
- `0` = debug
- `1` = info
- `2` = warn
- `3` = error

Conversion happens in the `core/` layer, never inside routes or SQL.

### Indexes

Create in `001_init.sql` on each partition (or on the parent using
partition-aware indexes in Postgres 12+):

```sql
-- Primary query pattern: filter by service+level, order by timestamp DESC
CREATE INDEX ON logs (service, level, timestamp DESC, id DESC);

-- Attribute equality filters
CREATE INDEX ON logs USING GIN (attributes jsonb_path_ops);

-- Substring search on message (accept slowness; do not add pg_trgm yet)
-- No index — relies on other filters to reduce scan size
```

### Partitioning

- Range partition by day on `timestamp`
- Partitions created ahead of time (7 days ahead) by a background task
- Retention drops partitions older than `RETENTION_DAYS` (default 30)
- No indexes on the parent table alone; use partition-aware indexes

### What NOT to store

- Never store the full request body as-is
- Never store or log stack traces (unless the sender explicitly sends
  them in `message`)
- Never store client IP addresses

---

## 10. Performance Strategy

### Write path

1. HTTP handler validates entries in a single pass (no `.filter().map()`)
2. Accepted entries pushed to an in-memory buffer
3. Buffer flushes on size (e.g., 500 rows) or time (e.g., 200ms)
4. Flush uses `COPY FROM STDIN` via `pg-copy-streams`
5. Buffer full → return 429 with `Retry-After`

### Read path

- Every query goes through `db/queryBuilder.ts` with parameterized values
- Dynamic identifiers (attribute keys) validated against a regex allow-list
- `ORDER BY timestamp DESC, id DESC LIMIT $n` for deterministic paging
- Aggregation uses `date_bin()` (Postgres 14+)

### Config defaults

```
POSTGRES_MAX_CONNECTIONS   = 20 (in the app pool)
BUFFER_MAX_ROWS            = 500
BUFFER_MAX_LATENCY_MS      = 200
INGEST_BODY_LIMIT_BYTES    = 8 MB
RETENTION_DAYS             = 30
PARTITION_LOOKAHEAD_DAYS   = 7
```

All configurable via env vars, all documented in `.env.example`.

---

## 11. Anti-Patterns (Never Do)

| Anti-pattern                                | Do instead                            |
| ------------------------------------------- | ------------------------------------- |
| `OFFSET n LIMIT m`                          | keyset seek: `WHERE (ts,id) < ...`    |
| SQL by string concatenation                 | parameterized placeholders            |
| `console.log` per log entry                 | counters + aggregate log every 5s     |
| `throw` per invalid entry                   | return `{ok:false, reason}` object    |
| `filter().map().map()` in hot path          | single-pass loop                      |
| `new Date(x)` as validation                 | explicit regex + parse + NaN check    |
| `Date.now()` inside a per-entry loop        | compute once before the loop          |
| Reading `process.env` outside `config.ts`   | route through the config module       |
| Empty catch blocks                          | log and rethrow, or handle explicitly |
| Committing `.env`                           | only `.env.example` is committed      |
| Silent dependency additions                 | propose + wait for approval           |
| Wide global type imports                    | import specific types                 |

---

## 12. Deliverables Checklist

Every submission must produce:

1. **Working `docker compose up`** — one command, zero configuration
2. **All four required endpoints** implemented per contract
3. **CI pipeline** that runs the required-contract smoke test in both
   `AUTH_ENABLED=false` and `AUTH_ENABLED=true` configurations
4. **README.md** with:
   - Overview and setup instructions
   - Full API documentation
   - Schema and index design with reasoning
   - Attribute storage strategy
   - Retention strategy
   - Measured performance results (real numbers from real runs)
   - Known limitations, owned honestly
   - Optional features enabled and how to configure them
5. **DESIGN.md** with the top 5 architectural decisions, each defended
   with: what, why, alternatives rejected, evidence, failure mode
6. **PERFORMANCE.md** with raw `EXPLAIN ANALYZE` output for the key
   queries, load test results, and identified bottlenecks
7. **Load generator** committed to `loadgen/` so results are reproducible
8. **Clean git history** with conventional commits

---

## 13. Working Method

The project is built in four focused days. Each day has defined outputs.
You will be given tasks one at a time by the user. Complete each task in
its declared scope, show results, and wait for the next task.

Do not attempt to build multiple days in one session. Do not skip ahead.
The order is deliberate: correctness first, then performance, then polish.

When in doubt, choose the simpler option and ask.

---

End of brief.