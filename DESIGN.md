# DESIGN.md

The five decisions that shaped this service, each with what was chosen,
why, what was rejected, the evidence, and where it breaks.

They are the five where a different choice would have produced a
materially different system — not the five that were hardest to make.
Supporting measurements are in [PERFORMANCE.md](PERFORMANCE.md); this
document is the reasoning behind them.

---

## Contents

1. [Attribute storage: JSONB with a GIN `jsonb_path_ops` index](#1-attribute-storage-jsonb-with-a-gin-jsonb_path_ops-index)
2. [Daily range partitioning, with retention by `DROP TABLE`](#2-daily-range-partitioning-with-retention-by-drop-table)
3. [Keyset pagination, never `OFFSET`](#3-keyset-pagination-never-offset)
4. [Micro-batched `COPY` with a per-caller durability promise](#4-micro-batched-copy-with-a-per-caller-durability-promise)
5. [Partition lifecycle managed in the application, not in SQL](#5-partition-lifecycle-managed-in-the-application-not-in-sql)
- [Architecture overview](#architecture-overview)
- [Trade-offs accepted](#trade-offs-accepted)
- [Appendix: author's defence notes (Arabic)](#appendix-authors-defence-notes-arabic)

---

## 1. Attribute storage: JSONB with a GIN `jsonb_path_ops` index

### What

Arbitrary key/value attributes are stored in one `JSONB` column,
indexed with `GIN (attributes jsonb_path_ops)`. Every value is
normalized to a string at ingest. All `attr.<key>` filters in a request
are merged into a single containment (`@>`) predicate.

### Why

The reason is epistemic rather than architectural: **the specification
never says which attribute keys will exist.** They are described as
"arbitrary" and they vary per service. Any schema that names keys in
advance is a guess about data the author has not seen.

JSONB is the only option that stores an unknown key set without
schema changes and still supports indexed lookup. `jsonb_path_ops` is
chosen over the default `jsonb_ops` because containment is the *only*
attribute access pattern this service has — there are no key-existence
or key-listing queries — and it produces a roughly 30% smaller index
for exactly that operator.

Values are normalized to strings because the spec compares `attr.<key>`
filters as strings. The type system enforces it: `RawAttributes` (what
a client may send: string, number, boolean) and `NormalizedAttributes`
(what is stored: string only) are distinct types, so the conversion
cannot be skipped by accident.

### Alternatives rejected

**A separate attributes table (EAV).** One row per attribute multiplies
write volume by the average attribute count. At the 15,000 logs/sec
target with three attributes each, that is 45,000 additional row
inserts per second, competing for the same single CPU PostgreSQL has in
total. Ingestion throughput is the binding constraint of this project,
so the design that minimizes rows written wins before any query
consideration is reached.

**Promoting known keys to real columns (hybrid).** Faster for the
promoted keys, but it requires knowing which keys matter. Nothing in
the specification supports that guess, and a wrong guess costs a
migration plus a permanently misleading schema.

**JSONB with the default `jsonb_ops`.** Larger index, and its extra
capability — key-existence operators — is capability this service never
uses. Paying insert cost for an unused feature on the hot path.

### Evidence

Attribute filters resolve through the GIN index in **0.7 ms** on a
count over one day of history:

```
->  Bitmap Index Scan on logs_2026_08_09_attributes_idx
      Index Cond: (attributes @> '{"user_id": "42"}'::jsonb)
Execution Time: 0.711 ms
```

End-to-end, `attr` filters measure **13.1 ms p95** on `GET /logs` and
**13.8 ms p95** in aggregation — indistinguishable from indexed column
filters at the same scale. Ingestion sustains 20,959 logs/sec with the
GIN index live, so its write cost did not prevent meeting the target.

A useful secondary finding: the planner does **not** always choose the
GIN index, and is right not to. With `ORDER BY … LIMIT` over a narrow
time range it walks the primary key in order and applies containment as
a filter, because that avoids a sort. The GIN index earns its place on
the counting and aggregation paths, where no ordering shortcut exists.

### Where it breaks

If one key came to dominate filter traffic — say `request_id` appearing
in most queries for a sustained period — a dedicated column with a
B-tree index would beat containment for that key. The evolution path is
open: promote that key, leave everything else in JSONB, migrate in one
step. Nothing in the current design blocks it.

It also breaks if attributes grow large or deeply structured. Flatness
and the 64-key / 1024-character-per-value limits are enforced at
validation precisely so a single abusive entry cannot make one row's
JSONB dominate a data page.

---

## 2. Daily range partitioning, with retention by `DROP TABLE`

### What

`logs` is `PARTITION BY RANGE (timestamp)` with one partition per UTC
day, named `logs_YYYY_MM_DD`, half-open `[from, to)`. Expired data is
removed by dropping whole partitions. `DELETE` is never used for
retention.

### Why

Three reasons, in order of weight.

**Retention precision.** The spec requires a configurable retention
policy. Daily granularity means the policy can be honoured to the day.
Weekly partitions would force rounding — either keep up to six extra
days or delete data early — and the choice between those is not one a
retention policy should have to make.

**Retention becomes a metadata operation.** Dropping a partition is
O(1): PostgreSQL unlinks the file and removes catalog entries. A
partition holding one row and one holding a million take the same
time. `DELETE` is the opposite in every respect — see the rejected
alternative below.

**Partition pruning.** Queries in a log service are almost always
time-bounded, and the planner touches only the partitions a range can
intersect. With ~45 partitions in the storable window, planning
overhead is negligible.

### Alternatives rejected

**A flat table with `DELETE` for retention.** Under MVCC, `DELETE`
marks rows dead rather than removing them, producing table and index
bloat that autovacuum must later reclaim — spending the same CPU the
ingest path needs, on 1 CPU total. It writes a WAL record per row and
updates every index, including the GIN index, which is the most
expensive of the three to maintain. Disk space is not returned without
`VACUUM FULL`, which takes an exclusive lock. `DROP TABLE` writes one
metadata record and returns the space immediately.

**Weekly or monthly partitions.** Fewer partitions, coarser retention,
and larger units — a wide scan inside one partition loses the pruning
benefit that motivated partitioning.

**Hourly partitions.** Better pruning for dense data, but 24× the
partition count and 24× the index objects, for a scale this project
does not have.

### Evidence

Pruning selects exactly the partitions a range can touch:

| Query range | Partitions in the plan |
| --- | --- |
| One hour | 1 |
| Three days | 3 (`08_09`, `08_10`, `08_11`) |
| No time filter | all 45 |

Its value is quantified by comparing the two dataset shapes. The same
query, same indexes — only the spread differs:

| Aggregation shape | Spread over 30 days | Compressed into 4 hours |
| --- | --- | --- |
| `1h` buckets / 24 h / `group_by=level` | 28.2 ms | 2,087 ms |
| Overall p95 | **36.5 ms** | 2,686 ms |

A 74× difference produced entirely by whether pruning has anything
useful to prune.

Dropping a partition was also exercised live: `DROP TABLE
logs_2026_08_11` removing 2.4 M rows completed as a metadata operation,
and the application re-provisioned the partition automatically on
restart.

### Where it breaks

At tens of millions of rows per day a daily partition becomes large
enough that pruning to a single day no longer bounds the work
meaningfully — hourly partitions would be the next step. The dense
measurements above are effectively a preview of that regime: 2.4 M rows
in one partition is where 24-hour aggregations start costing seconds.

It also assumes data arrives roughly in time order. Wildly scattered
timestamps would spread writes across many partitions at once, hurting
cache locality — visible in the measurements: ingesting into 30 days at
once ran at 7,081 logs/sec against 20,959 for a live-stream shape.

---

## 3. Keyset pagination, never `OFFSET`

### What

Pages are fetched with a seek predicate on the composite key:

```sql
WHERE ("timestamp", id) < ($ts::timestamptz, $id::bigint)
ORDER BY "timestamp" DESC, id DESC
LIMIT $n
```

The cursor is `base64url(JSON({v, ts, id}))` — opaque to clients,
versioned, and defensively decoded.

### Why

`OFFSET n` requires PostgreSQL to produce and discard `n` rows before
returning anything. Cost grows linearly with depth, so page 1000 is
1000× the work of page 1 for the same payload. A log service is exactly
where deep pagination happens: an operator scrolling back through an
incident does not stop at page 3.

A seek predicate has no such term. It positions directly in the index
and reads forward, and its cost is independent of how far in it starts.

Two supporting details matter as much as the predicate:

- **The tiebreak is not optional.** Ordering by `timestamp` alone is
  not total — high-volume services produce many rows per millisecond.
  Without `id` as a tiebreak, rows sharing a timestamp can be repeated
  or skipped at page boundaries. `PRIMARY KEY (timestamp, id)` makes
  the ordering total and is the exact index the seek needs.
- **`id` is a string end to end.** It is a `BIGSERIAL`, which exceeds
  JavaScript's safe integer range; held as a number it would silently
  round at scale. It stays a string through the cursor, the API, and
  the query parameter.

### Alternatives rejected

**`OFFSET`/`LIMIT`.** Simple and wrong for this access pattern, per
above. Also unstable: rows inserted while a client pages shift the
offset window, so rows are seen twice or missed.

**A page-number API over `OFFSET`.** Same cost profile, and it promises
random access the storage cannot deliver cheaply.

**An opaque server-side cursor (a stored session).** Removes the
statelessness that makes the service trivially restartable, and adds
expiry semantics for no benefit here.

### Evidence

The claim "depth is free" is falsifiable, so `loadgen/query.ts` tests
it directly: 300 pages walked by following `next_cursor`, 30,000 rows
traversed.

| Segment | p50 | p95 |
| --- | --- | --- |
| First 10 pages | 8.6 ms | 30.9 ms |
| **Deepest 10 pages** | **7.9 ms** | **9.2 ms** |

Deep-to-shallow ratio **0.93×** — flat, with the deepest pages
marginally faster (noise). The plan shows why:

```
Limit  (actual time=0.264..0.892 rows=101 loops=1)
  Buffers: shared hit=136
  ->  Append
        ->  Index Scan Backward using logs_2026_08_10_pkey ... rows=101
              Index Cond: (ROW("timestamp", id) < ROW('2026-08-11 00:00:00+00', '9999999'))
        ->  Index Scan Backward using logs_2026_08_09_pkey ... (never executed)
```

The row-value comparison becomes an **`Index Cond`**, and the ordered
`Append` marks every older partition **`(never executed)`** once `LIMIT`
is satisfied. 136 buffers, 0.89 ms, regardless of depth.

Correctness under ties is covered by tests: 20 rows sharing one
timestamp, paged three at a time, yield 20 distinct ids with no
repetition.

### Where it breaks

Keyset pagination cannot jump to an arbitrary page number, and cannot
page backwards without a second cursor form. Neither is required here,
but a UI offering "jump to page 500" would need a different design.

Cursors also encode position only, not filters. A client that changes
filters while reusing a cursor gets a coherent but different result
set. The alternative — encoding filters in the cursor — was rejected
because it makes cursors large and turns a filter change into an opaque
failure instead of an obvious one.

---

## 4. Micro-batched `COPY` with a per-caller durability promise

### What

Accepted entries are buffered and written with `COPY … FROM STDIN`.
Concurrent HTTP batches merge into a single COPY, but **each caller's
promise resolves only after the COPY containing its own rows has
committed.** The route awaits that promise before answering 200.
Flushes trigger on size (500 rows) or age (200 ms), and a hard cap
(20,000 unwritten rows) sheds load with `429` plus `Retry-After`.

### Why

Two requirements pull in opposite directions. Throughput demands
batching: a COPY of 500 rows costs a fraction of 500 inserts. Honesty
forbids it: the spec says never to answer 200 for a batch that is not
durably accepted, and a buffer that acknowledges on receipt loses data
on any crash between acknowledgement and flush.

The per-caller promise resolves the conflict rather than choosing a
side. Batching is invisible to correctness — several requests share one
COPY, and each is told the truth about *its* rows. A 200 from this
service means the data is committed, not queued.

`COPY` over `INSERT` is not a close call: it is a single protocol
stream with one parse and one plan for the whole batch, against
per-statement overhead multiplied by row count.

Flushes are serial — one COPY in flight at a time. Parallel COPYs into
the same partition contend for the same relation lock, so parallelism
buys little at this scale, and a serial pipeline makes shutdown
ordering trivial to reason about.

### Alternatives rejected

**Multi-row `INSERT … VALUES`.** Simpler, and fast enough at hundreds
of rows/sec. At 15,000/sec the per-statement overhead is the dominant
cost, and it is avoidable.

**Fire-and-forget buffering (respond 200 on receipt).** Higher apparent
throughput and a direct violation of the durability rule. It also makes
the "data queryable within 20 seconds" target unverifiable, because
acknowledgement would no longer mean anything.

**One COPY per HTTP request, no buffering.** Honest and slower: it
gives up all cross-request batching, which is exactly where the
throughput comes from when many clients each send modest batches.

**An external queue (Kafka, Redis) in front of Postgres.** Real
engineering for a real fan-in problem, and out of scope here: the spec
requires PostgreSQL to remain the source of truth, and a queue would
add a component whose failure modes must also be defended.

### Evidence

**20,959 logs/sec sustained** over 30 seconds — 140% of target — with
**zero** dropped requests, and `logs sent` exactly equal to `logs
accepted`. The application container used ~40% of its 0.5 CPU and
**33 MB of its 256 MB**.

Durability is asserted rather than assumed: integration tests read
every accepted entry back immediately after the response, and eight
concurrent batches of 25 entries each produce exactly 200 readable
rows — proving the coalescing does not lose a caller's rows.

The backpressure threshold was itself corrected by measurement. The
original cap (`BUFFER_MAX_ROWS × 10` = 5,000) rejected ordinary
concurrency: 16 workers × 500 rows = 8,000 rows in flight produced 429s
while throughput was above target and no container was CPU-saturated.
Split into `BUFFER_MAX_PENDING_ROWS` at 20,000 (~6 MB); re-measured at
zero 429s, same throughput.

### Where it breaks

A crash between COPY commit and the HTTP response leaves the client
believing the write failed when it succeeded — at-least-once delivery,
so clients that retry may duplicate. Idempotency keys would be the fix
and are not implemented.

Under sustained overload the buffer fills and the service sheds with
429. That is the intended behaviour, but the shed requests count
against throughput, so the cap is a real ceiling rather than an
infinite absorber.

Serial flushing sets the write ceiling. Since neither container was
CPU-bound at 20,959 logs/sec, parallel flushes across distinct
partitions would likely raise it — deliberately not pursued, because
the target was met with 40% margin and added concurrency would
complicate the durability contract above.

---

## 5. Partition lifecycle managed in the application, not in SQL

### What

`src/db/retention.ts` runs one maintenance cycle at startup — awaited,
and fatal on failure, before `/health` reports ready — and hourly
after. It provisions daily partitions across the whole storable window
(`RETENTION_DAYS` back through `PARTITION_LOOKAHEAD_DAYS` forward),
then drops partitions older than the retention window. SQL contributes
only a read-only view, `logs_partitions`, exposing partition bounds.

### Why

Retention is an operational concern, not a schema concern. It has a
schedule, it can fail partially, it needs to be observable, and it must
stop cleanly on shutdown. Those are application properties.

Placing it in the application also means it is testable with the rest
of the code, logs through the same path, and takes its configuration
from the same `config.ts` that everything else does.

**Provisioning runs first and is fatal; retention runs second and is
not.** The asymmetry is deliberate and reflects real consequence: a
missing partition makes every insert for that day fail outright, while
late retention only means data outlives its policy briefly. Ranking
them wrongly would trade an outage for a policy delay.

**Provisioning reaches backwards as well as forwards** — this was the
subtlest part of the design, and it was wrong at first. Log delivery is
neither ordered nor instantaneous: a buffered agent flush, a replayed
dead-letter batch, or a skewed clock all produce entries timestamped in
the past. Those entries pass validation, because the spec bounds only
the future. If no partition covers their day, the COPY fails.

### Alternatives rejected

**PL/pgSQL functions plus `pg_cron`.** Keeps the logic next to the
data, at the cost of testability, structured logging, metrics, and
graceful-shutdown coordination. It also requires an extension, which
complicates the zero-configuration startup contract the spec demands.

**Migrations that create partitions.** This is what the project
originally did — 15 hardcoded daily partitions in
`003_partitions.sql`. Migrations must be deterministic, so the dates
had to be literals, which meant the file was only useful while the
deployment date sat inside its range. Deployed later, it created
partitions that retention dropped seconds afterwards. That migration is
now inert, with the reasoning recorded in the file.

**Lazy creation on the write path** (catch the error, create the
partition, retry). Attractive because it handles any timestamp, but it
puts a failure path and a DDL statement on a hot path running at 15,000
rows/sec, and DDL takes locks that block concurrent writes.

**Rejecting all past timestamps.** Simple, and wrong for a logging
service — late delivery is normal, not exceptional.

### Evidence

The gap was found by testing, not by reading: a log timestamped 45 days
in the past returned **`HTTP 500`**, and — worse — took the whole batch
with it, violating the rule that one bad entry must not fail a batch.

After extending provisioning backwards and rejecting older entries
per-entry:

| Case | Before | After |
| --- | --- | --- |
| Entry 25 days old (inside retention) | worked only if a partition happened to exist | `200 accepted:1` |
| Entry 45 days old (outside retention) | **500**, batch destroyed | `400` with the boundary date in the reason |
| **2 valid + 1 stale in one batch** | **all three lost** | `200 accepted:2`, one indexed rejection |

Self-healing was verified directly: dropping `logs_2026_08_11` by hand
and restarting produced `Partition maintenance: +1 provisioned` and
ingestion resumed with no intervention. New partitions inherit the
parent's composite and GIN indexes automatically, confirmed by
inspecting a partition the job created.

### Where it breaks

If the application stops for longer than `PARTITION_LOOKAHEAD_DAYS`
(14), the future runs out and ingestion fails for uncovered days. The
lookahead is the tolerance window, chosen to survive a two-week outage;
it is a bound, not a guarantee.

Provisioning the full window means 45 partitions on a fresh start
rather than 15. Each is a catalog entry with three inherited indexes —
cheap, but not free, and the count grows with `RETENTION_DAYS`.

The hourly cycle also means retention lags by up to an hour past the
policy boundary. Deliberate: dropping precisely on the second buys
nothing and would require a tighter loop.

---

## Architecture overview

```
                    HTTP (port 8080, the only published port)
                                  │
┌─────────────────────────────────┼─────────────────────────────────┐
│  src/http/          routes, auth hook, error shaping.  NO SQL     │
│      │                                                            │
│      ├──────────────► src/core/    pure functions, NO I/O         │
│      │                validation · levels · cursor · buckets      │
│      │                imports nothing from http/ or db/           │
│      │                                                            │
│      └──────────────► src/db/      ALL SQL lives here             │
│                       pool · migrate · writer(COPY) · queries     │
│                       retention                                   │
└───────────────────────────────────┼───────────────────────────────┘
                                    │ internal Compose network
                            PostgreSQL 16 (not published)
```

**Write path.** `POST /logs` → `validateBatch` (core) → `write` (db) →
buffer → `COPY` → commit → respond 200.

**Read path.** `GET /logs` → `validateFilters` + `decodeCursor` (core)
→ shared parameterized `WHERE` builder → keyset query (db) → shape
response.

Both read endpoints compose the *same* filter builder, so `GET /logs`
and `GET /logs/aggregate` cannot drift apart in what a filter means.

**Why `core/` is separated this strictly.** It is the layer whose
correctness is provable without infrastructure. 147 unit tests cover it
with no database and run in under a second, which is only possible
because it imports nothing that performs I/O.

**Security posture.** Every value reaching SQL is a bound parameter,
mechanically — the `ParamAccumulator` is the only way to add one, and
it returns a placeholder. The sole dynamic identifiers are the
`GROUP BY` column (a closed two-value allow-list) and partition names
in `DROP TABLE` (regex-validated against `^logs_\d{4}_\d{2}_\d{2}$`).
Attribute keys look like identifiers but never reach SQL as one: they
travel inside a JSONB parameter, and are regex-validated first as
defence in depth.

---

## Trade-offs accepted

| Trade-off | Given up | Gained |
| --- | --- | --- |
| No index on `message` | Fast substring aggregation | No trigram index maintenance on every insert |
| Serial COPY flushes | Some write headroom | A simple, honest durability contract |
| Raw SQL, no ORM | Compile-time query typing, less boilerplate | `COPY` access, and every query defensible line by line |
| Daily (not hourly) partitions | Pruning precision on dense data | 24× fewer partitions and index objects |
| JSONB for all attributes | Per-key column performance | No guessing at keys the spec never defined |
| At-least-once ingest | Exactly-once semantics | No idempotency-key bookkeeping on the hot path |
| Entries older than retention rejected | Accepting arbitrary history | No partition explosion, no writes that retention would immediately undo |

The recurring shape: **capability the specification does not require was
traded for throughput on the path it does require, and each trade is
measured rather than assumed.**

---

## Appendix: author's defence notes (Arabic)

Working notes kept from the design sessions, preserved verbatim. They
cover the same ground as sections 1 and 2 above, in the author's own
words.

### ليش اخترت التقسيم يومي

> "اخترت range partitioning يومي على الـ timestamp لثلاث أسباب.
>
> الأول والأهم: retention configurability. الـ spec بتطلب retention قابل للتخصيص، ومع partitioning يومي أقدر أحذف بدقة يوم واحد. الأسبوعي كان بيجبرني على تقريب — إما احتفظ بأسبوع زيادة أو أحذف قبل الوقت.
>
> الثاني: الـ retention يصير عملية metadata. DROP TABLE partition عملية فورية بلا locks طويلة ولا bloat ولا autovacuum overhead. لو كنت أستخدم DELETE، على 33,000 صف يومياً كنت بولّد dead tuples بمعدل ثابت وبخسر CPU على vacuum.
>
> الثالث: partition pruning. الاستعلامات بتكون على نطاق زمني محدد عادة، والـ planner بيلمس بس الـ partitions اللي فيها البيانات المطلوبة. مع ~30 partition بس، الـ planning overhead ضئيل.
>
> وين بينكسر؟ لو صار حجم البيانات أكبر بكثير — عشرات ملايين الصفوف يومياً — الـ partition اليومي يصير كبير جداً، ويمكن أفكر بـ partition ساعي. بس على مقياس المشروع الحالي، اليومي هو النقطة المثلى."

### ليش اخترت JSONB

> "خزّنت الـ attributes كـ JSONB لسبب معرفي، مش تصميمي: الـ spec ما بتعرّف المفاتيح المستقبلية، فأي عمود مخصص كنت أعمله لـ user_id أو region كان رح يكون تخمين. مع JSONB، الشكل موحّد لأي مفتاح جاي.
>
> بستخدم GIN index مع jsonb_path_ops operator class، لأنه أصغر وأسرع من الـ default operator class للـ @> queries — واللي هي بالضبط شكل الاستعلامات عندي.
>
> الثمن معترف فيه: GIN بيكلف حوالي 30% إضافية على الـ INSERT مقارنة ببدون index. قبلت الثمن لأن ميزانية الـ CPU عندي في الـ application container، مش في Postgres.
>
> وين بينكسر؟ لو مفتاح معين — نقل request_id مثلاً — أظهر بالقياس إنه بيمثل نسبة عالية من الفلاتر لفترة مستمرة، بروّجه لعمود مخصص وأترك الباقي JSONB. هاي الـ evolution path، مش قرار أضطر ياخده اليوم."

### ليش DROP partition بدل DELETE

> "الاختيار مبني على ثلاث اختلافات جوهرية بين العمليتين على مقياس المشروع.
>
> الأول: DROP هي عملية metadata بـ O(1). Postgres تحذف الملف من نظام الملفات وتشيل الإدخالات من الـ system catalogs. سواء الـ partition فيه ألف صف أو مليون، الوقت نفسه — ملي ثانية.
>
> الثاني: DELETE بتنتج dead tuples لأن Postgres تستخدم MVCC. كل صف بيتم علامته كمحذوف بس ما ينمسح فعلياً. النتيجة هي table bloat و index bloat، بيستهلكوا CPU لاحقاً عبر autovacuum، ومساحة قرص لا ترجع للنظام إلا مع VACUUM FULL — واللي بتقفل الجدول بـ exclusive lock.
>
> الثالث: DELETE على 33,000 صف يومياً تنتج ~33,000 سجل WAL إضافي و 33,000 تحديث فهرس. مع فهرس GIN على JSONB، هالتكلفة عالية جداً. DROP partition تنتج سجل WAL واحد للـ metadata.
>
> على 1 CPU لـ Postgres و 0.5 CPU للتطبيق، الـ CPU المستهلك من DELETE مباشرة يخصم من ميزانية الـ ingest. لهذا اخترت partitioning يومي مع DROP، مش DELETE على جدول مسطّح."
