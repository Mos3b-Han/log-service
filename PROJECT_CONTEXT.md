# PROJECT_CONTEXT.md

> **What this is.** A navigation and resumption brief for an engineer or
> AI picking this project up cold. It deliberately does **not** repeat
> the reasoning in the graded documents — it points at them, records the
> things that live nowhere else (a source map, environment gotchas,
> operational rules), and states what is verifiably true right now.
>
> **Read in this order:** [CLAUDE.md](CLAUDE.md) is the binding brief and
> its rules are still in force. [README.md](README.md) is the entry
> point: setup, API, and measured results. [DESIGN.md](DESIGN.md)
> defends the five architectural decisions.
> [PERFORMANCE.md](PERFORMANCE.md) holds the raw query plans and
> bottleneck analysis. This file is the connective tissue.
>
> **Last verified:** 2026-08-12 against commit `10d037e`, with the stack
> running. Re-verify with the commands in
> [Verifying this document](#verifying-this-document) before trusting any
> specific number below.

---

## Current state

| | |
| --- | --- |
| Branch / commits | `master`, 40 commits, no remote configured yet |
| Source | 26 TypeScript files under `src/` |
| Tests | **213 passing** — 147 unit, 33 integration, 33 contract |
| Contract smoke | **39/39** (auth off) · **41/41** (auth on) |
| Load generators | 6 files under `loadgen/` |
| Database | 3.97 M rows across 31 days, 45 daily partitions |
| Typecheck | clean (`npm run typecheck`) |

**Everything the specification requires is built.** Four endpoints,
optional auth, retention with provisioning, graceful shutdown, the load
generators, the test suite, CI, and all three documents.

### Targets

| Target | Status |
| --- | --- |
| ≥ 15,000 logs/sec sustained | **20,959/sec** |
| Zero dropped requests | **0** |
| ~1,000,000 rows | **1.16 M** measured on, 3.97 M currently held |
| Aggregation p95 < 1 s | **36.5 ms** (specification-shaped dataset) |
| 1 aggregation req/sec under load | **0.99/sec** |
| New data queryable ≤ 20 s | **2.1 s** worst case |
| Query performance while ingesting | **1,147 ms** — the one target over budget |

The last row is analysed in [PERFORMANCE.md](PERFORMANCE.md) under
Bottlenecks found; it is bounded and explained, not unexplained.

### Not built (deliberate, and documented)

Pre-aggregated rollup tables, a `pg_trgm` index for substring search,
an observability/metrics module, parallel COPY flushes. Each is
recorded with its reasoning in the README's Known limitations or
PERFORMANCE.md's Bottlenecks.

---

## Source map

Where to look, by responsibility. The layering rule is absolute:
`core/` imports from neither `http/` nor `db/`.

### Bootstrap

| File | Responsibility |
| --- | --- |
| `src/index.ts` | Boot order: shutdown handlers → config → verify Postgres → migrate → **provision partitions** → error handler → auth → routes → listen → `setReady()` → start hourly maintenance |
| `src/config.ts` | The only place `process.env` is read. Fail-fast on malformed values, documented defaults otherwise |
| `src/readiness.ts` | `starting → ready → shutting_down`; `/health` returns 200 only in `ready` |
| `src/shutdown.ts` | Ordered drain: fail readiness → stop maintenance → close HTTP (waits for in-flight writes) → flush writer → close pool; 8 s guard |

### `core/` — pure, no I/O, covered by 147 tests needing no database

| File | Responsibility |
| --- | --- |
| `core/types.ts` | All shared types. `RawAttributes` vs `NormalizedAttributes` are distinct so normalization cannot be skipped |
| `core/levels.ts` | `debug=0 … error=3`, guarded by a load-time invariant check |
| `core/validation/validateEntry.ts` | §8 rules per entry, including the retention-window lower bound. Returns results, never throws |
| `core/validation/validateBatch.ts` | Envelope shape vs per-entry verdicts. Computes `now` and the retention boundary **once** per batch |
| `core/validation/validateFilters.ts` | Shared filters for both read endpoints, plus `validateLimit`. Attribute-key allow-list lives here |
| `core/pagination/cursor.ts` | `base64url(JSON({v, ts, id}))`. `id` stays a string (BIGSERIAL exceeds JS safe integers) |
| `core/time/buckets.ts` | Bucket token → PostgreSQL interval; `group_by` allow-list |

### `db/` — all SQL

| File | Responsibility |
| --- | --- |
| `db/pool.ts` | Shared `pg.Pool`. The `on('error')` listener is mandatory — without it an idle-client error kills the process |
| `db/migrate.ts` | Applies `migrations/*.sql` transactionally, tracked in `schema_migrations`. Resolves the directory from `import.meta.url`, not CWD |
| `db/writer.ts` | The hot path. Micro-batched `COPY`, per-caller promise resolved only after commit, typed `BackpressureError` at the hard cap |
| `db/retention.ts` | Provisions `[today − RETENTION_DAYS, today + LOOKAHEAD]`, then drops expired partitions. Validates partition names before any `DROP` |
| `db/query/filters.ts` | **The security-critical file.** `ParamAccumulator` is the only way to add a value, and it returns a `$N` placeholder |
| `db/query/list.ts` | `LIMIT n+1` to detect a next page without a `COUNT`; encodes `next_cursor` from the last returned row |
| `db/query/aggregate.ts` | `date_bin` with `origin = since`; `GROUP BY` column from a closed allow-list; level decoded to a name in JS, never in SQL |

### `http/` — no SQL

| File | Responsibility |
| --- | --- |
| `http/server.ts` | Fastify instance. `logger: { level: 'error' }` — quiet on the hot path, but 5xx are recorded |
| `http/errorHandler.ts` | Forces `{"error": …}` everywhere. 5xx messages replaced with a generic string and logged server-side |
| `http/middleware/auth.ts` | Registers **no hook at all** when disabled — that is what makes a stray `Authorization` header ignored rather than rejected |
| `http/routes/*.ts` | Thin: validate (core) → execute (db) → shape. No SQL, no pagination maths |

### Tooling

| Path | Purpose |
| --- | --- |
| `loadgen/report.ts`, `discover.ts` | Shared percentile maths; dataset discovery over the public API |
| `loadgen/ingest.ts` | Write throughput. `LOADGEN_SPREAD_DAYS` builds historical datasets |
| `loadgen/aggregate.ts`, `query.ts`, `mixed.ts` | Aggregation latency, query latency + pagination walk, and the grading scenario |
| `scripts/smoke.sh` | 39-assertion contract check; auto-detects the auth mode |
| `scripts/seed-history.sh` | Creates historical partitions for testing. Test infrastructure — production never provisions the past |
| `tests/helpers/client.ts` | HTTP helper; `uniqueService()` is why suites stay exact against a populated database |

---

## Environment gotchas

Machine-specific traps that cost real time. They are here rather than
in the README because they are about this development environment, not
about the service.

**A route that exists returns 404 → check port ownership first.**

```bash
ss -tlnp | grep :8080
```

A stale `npx tsx` process from an earlier session can hold 8080 while
Docker's publish silently loses the race. Every `curl` then hits an
outdated in-memory server. Kill the host process and restart the
container.

**`password authentication failed` from the host is probably not a
password problem.** A native PostgreSQL installed on WSL2 (via systemd)
can own `127.0.0.1:5432` and win the bind against Docker. Connections
then reach the wrong database entirely. Diagnose the same way — with
`ss -tlnp | grep :5432` — not by changing credentials.

**Rule that follows from both:** anything touching Postgres is run via
`docker compose up`, never `npx tsx` against `localhost` from the host.
Postgres is not published to the host at all. `npx tsx` remains correct
for the load generators (they are HTTP clients) and for DB-free logic.

**Changing `POSTGRES_PASSWORD` has no effect on an existing volume.**
The image applies those variables only when initializing an empty data
directory. Use `docker compose down -v` for a genuine reset.

---

## Rules for continuing work

From [CLAUDE.md](CLAUDE.md), still binding: no `OFFSET`; no SQL built by
concatenation; no `console.log` in the per-entry hot path; no `throw`
inside per-entry validation; no ORM on the hot path; no `process.env`
outside `config.ts`; no empty catch blocks; no `new Date(x)` as
validation; no `Date.now()` inside a per-entry loop.

Established by practice here:

- **Verify with a command, not an assumption.** Every number in the
  three documents came from a run. Two published figures turned out to
  be the measurement tools lying rather than the service failing (see
  PERFORMANCE.md, Optimizations applied) — both were caught by checking
  whether the number was *arithmetically possible*.
- **`npm run typecheck` before every commit.** Note that `loadgen/` and
  `tests/` are excluded from `tsconfig.json`; check them explicitly with
  `npx tsc --noEmit --strict --module NodeNext --moduleResolution NodeNext --skipLibCheck <file>`.
- **Commits are small, conventional, and one coherent change each.** The
  40-commit history is the model to continue, not a one-off tidy-up.
- **Nothing is committed without being shown first.**

---

## What remains

1. **Push to GitHub.** No remote is configured, so `.github/workflows/ci.yml`
   has never actually executed — every step was verified locally with its
   literal command, but a real run is still owed.
   ```bash
   git remote add origin <url> && git push -u origin master
   ```
2. **The 5-minute demo video** — architecture, key decisions, live demo.
   The material is in DESIGN.md; the runnable demo is `docker compose up`
   plus `scripts/smoke.sh`.
3. **Optional, if time allows:** rollup tables would fix the one
   over-budget target, and are listed as a stretch goal in the
   specification.

---

## Verifying this document

Numbers above drift. Re-check them rather than trusting them:

```bash
git log --oneline | wc -l                       # commit count
docker compose ps                               # both healthy?
curl -s http://localhost:8080/health            # {"status":"ok"}
npm run typecheck && npm test                   # 213 passing
bash scripts/smoke.sh                           # 39/39
docker exec log-service-postgres-1 psql -U logs -d logs -t -A \
  -c "SELECT count(*) FROM logs;"               # row count
```

If the stack is not running: `docker compose up -d --build --wait`.
