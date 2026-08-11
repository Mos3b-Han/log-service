// loadgen/query.ts
//
// Query load generator for GET /logs. Produces the "query rate" and
// "query latency percentiles" the README is required to report, and --
// more importantly -- tests the one claim this project's pagination
// design stands or falls on.
//
// ---- Two phases, because one number would not prove the design ----
//
// PHASE 1: query shapes. Cycles through a representative set (no
// filter, indexed equality filters, JSONB containment, the deliberately
// unindexed message substring) and reports percentiles per shape, so a
// slow access path is visible instead of averaged away.
//
// PHASE 2: deep pagination walk. Starts at page 1 and follows
// next_cursor for N pages, recording latency at each depth.
//
// Phase 2 exists to test the central claim behind keyset pagination
// (CLAUDE.md §11 forbids OFFSET anywhere): page 1000 costs the same as
// page 1. OFFSET degrades linearly -- the database must read and
// discard every skipped row, so page 1000 at limit 100 reads 99,900
// rows before returning anything. A seek predicate on (timestamp, id)
// jumps straight to its position in the index regardless of depth.
//
// That is a testable prediction, not an opinion, so this phase tests
// it: if latency at depth is flat, the design is vindicated with
// evidence; if it climbs, something is wrong and the write-up needs to
// say so. Reporting shallow-vs-deep side by side makes either outcome
// impossible to hide.
//
// Configuration (all optional):
//   LOADGEN_URL           base URL                  default http://localhost:8080
//   LOADGEN_QUERY_RATE    shape queries per second  default 5
//   LOADGEN_DURATION_SEC  phase 1 seconds           default 60
//   LOADGEN_WARMUP_SEC    unrecorded warmup         default 5
//   LOADGEN_LIMIT         page size, 1..1000        default 100
//   LOADGEN_PAGES         phase 2 pages to walk     default 200
//   LOADGEN_WINDOW_HOURS  span of the widest query  default 24
//   LOADGEN_UNTIL         ISO upper bound           default newest row
//   LOADGEN_API_KEY       bearer token              default none
//
// Run: npx tsx loadgen/query.ts

import {
  summarizeLatencies,
  formatLatencyBlock,
  fmtInt,
  fmtNum,
  fmtMs,
} from './report.js';
import { discoverDataset, isoOf, type Dataset } from './discover.js';

// ---------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------

function envInt(name: string, dflt: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return dflt;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n <= 0) throw new Error(`Invalid ${name}: '${raw}'`);
  return n;
}

function envNum(name: string, dflt: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return dflt;
  const n = Number.parseFloat(raw);
  if (Number.isNaN(n) || n <= 0) throw new Error(`Invalid ${name}: '${raw}'`);
  return n;
}

const URL_BASE = (process.env['LOADGEN_URL'] ?? 'http://localhost:8080').replace(
  /\/$/,
  '',
);
const QUERY_RATE = envNum('LOADGEN_QUERY_RATE', 5);
const DURATION_SEC = envInt('LOADGEN_DURATION_SEC', 60);
const WARMUP_SEC = envInt('LOADGEN_WARMUP_SEC', 5);
const LIMIT = envInt('LOADGEN_LIMIT', 100);
const PAGES = envInt('LOADGEN_PAGES', 200);
const WINDOW_HOURS = envInt('LOADGEN_WINDOW_HOURS', 24);
const UNTIL_OVERRIDE = process.env['LOADGEN_UNTIL'];
const API_KEY = process.env['LOADGEN_API_KEY'];

const LOGS_URL = `${URL_BASE}/logs`;
const HEALTH_URL = `${URL_BASE}/health`;

const HEADERS: Record<string, string> = {};
if (API_KEY) HEADERS['authorization'] = `Bearer ${API_KEY}`;

// ---------------------------------------------------------------
// Query shapes (phase 1)
// ---------------------------------------------------------------

interface QueryShape {
  readonly name: string;
  readonly exercises: string;
  readonly query: string;
}

function buildShapes(ds: Dataset): QueryShape[] {
  const until = new Date(ds.end.getTime() + 1000).toISOString();
  const since = isoOf(ds.end, WINDOW_HOURS);
  const shapes: QueryShape[] = [];

  const add = (
    name: string,
    exercises: string,
    params: Record<string, string>,
  ): void => {
    const qs = new URLSearchParams({ limit: String(LIMIT), ...params });
    shapes.push({ name, exercises, query: qs.toString() });
  };

  // The "tail the logs" case: newest N rows, no filter at all. Served
  // straight off the (timestamp, id) primary key.
  add('newest N, no filter', 'primary key reverse scan', {});

  // Time range only -- exercises partition pruning plus the PK.
  add(`time range ${WINDOW_HOURS}h`, 'partition pruning + PK range', {
    since,
    until,
  });

  // Leading column of the composite index.
  add('service filter', 'composite index, first column', { service: ds.service });

  // Both equality columns of the composite index.
  add('service + level', 'composite index, both equality columns', {
    service: ds.service,
    level: 'error',
  });

  // JSONB containment via the GIN jsonb_path_ops index.
  if (ds.attrKey !== undefined && ds.attrValue !== undefined) {
    add('attr filter', 'GIN jsonb_path_ops containment', {
      [`attr.${ds.attrKey}`]: ds.attrValue,
    });
  }

  // Combined: narrow by index first, then containment.
  if (ds.attrKey !== undefined && ds.attrValue !== undefined) {
    add('service + attr', 'composite index then containment', {
      service: ds.service,
      [`attr.${ds.attrKey}`]: ds.attrValue,
    });
  }

  // Deliberately unindexed (CLAUDE.md §9). Expected to be the slowest;
  // measuring it is the point, since the README must own that tradeoff.
  if (ds.word !== undefined) {
    add('q= substring', 'UNINDEXED message ILIKE scan', { q: ds.word });
  }

  // Maximum page size: same access path, ~10x the rows serialized.
  add('newest 1000 (max limit)', 'payload size at the limit ceiling', {
    limit: '1000',
  });

  return shapes;
}

// ---------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------

interface ShapeMetrics {
  readonly shape: QueryShape;
  latencies: number[];
  ok: number;
  failed: number;
  rowsReturned: number;
  errorSample: string | undefined;
}

function newShapeMetrics(shape: QueryShape): ShapeMetrics {
  return { shape, latencies: [], ok: 0, failed: 0, rowsReturned: 0, errorSample: undefined };
}

interface PageSample {
  readonly page: number;
  readonly ms: number;
  readonly rows: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------
// Phase 1: shape latency
// ---------------------------------------------------------------

async function runShape(m: ShapeMetrics, record: boolean): Promise<void> {
  const t0 = performance.now();
  try {
    const res = await fetch(`${LOGS_URL}?${m.shape.query}`, { headers: HEADERS });
    const elapsed = performance.now() - t0;
    if (res.status === 200) {
      const body = (await res.json()) as { logs: unknown[] };
      if (record) {
        m.ok++;
        m.rowsReturned += body.logs.length;
        m.latencies.push(elapsed);
      }
    } else {
      const text = await res.text();
      if (record) {
        m.failed++;
        m.latencies.push(elapsed);
        m.errorSample ??= `HTTP ${res.status}: ${text.slice(0, 140)}`;
      }
    }
  } catch (err) {
    if (record) {
      m.failed++;
      m.errorSample ??= `network: ${(err as Error).message}`;
    }
  }
}

/**
 * Paced on an absolute schedule so a slow response cannot silently
 * lower the offered rate (coordinated omission). Shapes are visited
 * round-robin so each accumulates an equal sample count.
 */
async function runShapePhase(
  metrics: ShapeMetrics[],
  seconds: number,
  record: boolean,
): Promise<number> {
  const intervalMs = 1000 / QUERY_RATE;
  const start = Date.now();
  const endAt = start + seconds * 1000;

  for (let k = 0; Date.now() < endAt; k++) {
    const due = start + k * intervalMs;
    const wait = due - Date.now();
    if (wait > 0) await sleep(wait);
    if (Date.now() >= endAt) break;
    await runShape(metrics[k % metrics.length]!, record);
  }
  return (Date.now() - start) / 1000;
}

// ---------------------------------------------------------------
// Phase 2: deep pagination walk
// ---------------------------------------------------------------

/**
 * Follow next_cursor from page 1 to page N, timing each request.
 *
 * Returns one sample per page. The caller compares the shallow pages
 * against the deep ones -- with keyset pagination the two should be
 * indistinguishable, whereas OFFSET would show a clear upward slope.
 */
async function paginationWalk(): Promise<PageSample[]> {
  const samples: PageSample[] = [];
  let cursor: string | null = null;

  for (let page = 1; page <= PAGES; page++) {
    const qs = new URLSearchParams({ limit: String(LIMIT) });
    if (cursor !== null) qs.set('cursor', cursor);

    const t0 = performance.now();
    const res = await fetch(`${LOGS_URL}?${qs.toString()}`, { headers: HEADERS });
    const elapsed = performance.now() - t0;

    if (res.status !== 200) {
      const text = await res.text();
      throw new Error(`Pagination failed at page ${page}: HTTP ${res.status} ${text.slice(0, 140)}`);
    }
    const body = (await res.json()) as {
      logs: unknown[];
      next_cursor: string | null;
    };
    samples.push({ page, ms: elapsed, rows: body.logs.length });

    if (body.next_cursor === null) break; // ran out of data
    cursor = body.next_cursor;
  }

  return samples;
}

// ---------------------------------------------------------------
// Health gate
// ---------------------------------------------------------------

async function waitForHealth(): Promise<void> {
  const deadline = Date.now() + 30_000;
  process.stdout.write(`Waiting for ${HEALTH_URL} ... `);
  while (Date.now() < deadline) {
    try {
      const res = await fetch(HEALTH_URL);
      if (res.status === 200) {
        await res.text();
        process.stdout.write('ready.\n');
        return;
      }
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error(`Service did not become healthy at ${HEALTH_URL}`);
}

// ---------------------------------------------------------------
// Report
// ---------------------------------------------------------------

function printReport(
  metrics: ShapeMetrics[],
  pages: PageSample[],
  ds: Dataset,
  phase1Sec: number,
): void {
  const line = '─'.repeat(74);
  const pooled: number[] = [];
  for (const m of metrics) pooled.push(...m.latencies);
  const overall = summarizeLatencies(pooled);
  const totalReq = metrics.reduce((n, m) => n + m.ok + m.failed, 0);
  const totalFailed = metrics.reduce((n, m) => n + m.failed, 0);

  console.log(`\n${line}`);
  console.log('  QUERY LATENCY REPORT — GET /logs');
  console.log(line);
  console.log('  Config');
  console.log(`    url          : ${LOGS_URL}`);
  console.log(`    rate         : ${fmtNum(QUERY_RATE)} req/s`);
  console.log(`    page size    : ${fmtInt(LIMIT)}`);
  console.log(`    auth         : ${API_KEY ? 'bearer token' : 'none'}`);
  console.log(`    filters used : service='${ds.service}'` +
    `${ds.attrKey ? `, attr.${ds.attrKey}='${ds.attrValue}'` : ''}` +
    `${ds.word ? `, q='${ds.word}'` : ''}`);
  console.log('');

  console.log('  Phase 1 — per-shape latency (ms)');
  console.log(
    `    ${'shape'.padEnd(28)} ${'n'.padStart(5)} ${'p50'.padStart(8)} ` +
      `${'p95'.padStart(8)} ${'p99'.padStart(8)} ${'max'.padStart(8)}  avg rows`,
  );
  for (const m of metrics) {
    const s = summarizeLatencies(m.latencies);
    const avgRows = m.ok > 0 ? m.rowsReturned / m.ok : 0;
    console.log(
      `    ${m.shape.name.padEnd(28)} ${fmtInt(s.count).padStart(5)} ` +
        `${fmtNum(s.p50, 1).padStart(8)} ${fmtNum(s.p95, 1).padStart(8)} ` +
        `${fmtNum(s.p99, 1).padStart(8)} ${fmtNum(s.max, 1).padStart(8)}  ` +
        `${fmtInt(avgRows).padStart(8)}`,
    );
  }
  console.log('');
  console.log('  What each shape exercises');
  for (const m of metrics) {
    console.log(`    ${m.shape.name.padEnd(28)} ${m.shape.exercises}`);
  }
  console.log('');
  console.log('  Phase 1 — pooled latency');
  console.log(formatLatencyBlock(overall));
  console.log(`  achieved rate : ${fmtNum(totalReq / phase1Sec)} req/s ` +
    `over ${fmtNum(phase1Sec)}s (${fmtInt(totalFailed)} failed)`);
  console.log('');

  // ---- Phase 2 ----
  console.log('  Phase 2 — deep pagination (keyset seek, never OFFSET)');
  if (pages.length === 0) {
    console.log('    no pages walked');
  } else {
    const depth = pages.length;
    const headCount = Math.min(10, Math.max(1, Math.floor(depth / 10)));
    const head = pages.slice(0, headCount);
    const tail = pages.slice(-headCount);
    const headStats = summarizeLatencies(head.map((p) => p.ms));
    const tailStats = summarizeLatencies(tail.map((p) => p.ms));
    const allStats = summarizeLatencies(pages.map((p) => p.ms));
    const rowsDeep = pages.reduce((n, p) => n + p.rows, 0);

    console.log(`    pages walked : ${fmtInt(depth)} (${fmtInt(rowsDeep)} rows traversed)`);
    console.log('');
    console.log(
      `    ${'segment'.padEnd(26)} ${'p50'.padStart(9)} ${'p95'.padStart(9)} ${'max'.padStart(9)}`,
    );
    console.log(
      `    ${`first ${headCount} pages`.padEnd(26)} ` +
        `${fmtNum(headStats.p50, 1).padStart(9)} ${fmtNum(headStats.p95, 1).padStart(9)} ` +
        `${fmtNum(headStats.max, 1).padStart(9)}`,
    );
    console.log(
      `    ${`last ${headCount} pages (deepest)`.padEnd(26)} ` +
        `${fmtNum(tailStats.p50, 1).padStart(9)} ${fmtNum(tailStats.p95, 1).padStart(9)} ` +
        `${fmtNum(tailStats.max, 1).padStart(9)}`,
    );
    console.log(
      `    ${'all pages'.padEnd(26)} ` +
        `${fmtNum(allStats.p50, 1).padStart(9)} ${fmtNum(allStats.p95, 1).padStart(9)} ` +
        `${fmtNum(allStats.max, 1).padStart(9)}`,
    );
    console.log('');

    // The verdict: with a seek predicate, depth should not matter.
    // OFFSET at this depth would read `depth * LIMIT` rows for the last
    // page alone, so any real degradation would be unmistakable.
    const ratio = headStats.p50 > 0 ? tailStats.p50 / headStats.p50 : NaN;
    const rowsSkippedByOffset = depth * LIMIT;
    console.log(`    deepest page starts at row ~${fmtInt(rowsSkippedByOffset)};`);
    console.log('    OFFSET would have to read and discard every one of them.');
    console.log(`    deep/shallow p50 ratio : ${fmtNum(ratio)}x`);
    const flat = Number.isFinite(ratio) && ratio < 2;
    console.log(
      `    verdict                : ${flat ? 'FLAT — depth does not cost anything' : 'DEGRADING — investigate'}`,
    );
  }

  console.log('');
  const errs = metrics.filter((m) => m.errorSample !== undefined);
  if (errs.length > 0) {
    console.log('  Error samples');
    for (const m of errs) console.log(`    ${m.shape.name}: ${m.errorSample}`);
    console.log('');
  }
  console.log(line + '\n');
}

// ---------------------------------------------------------------
// Main
// ---------------------------------------------------------------

async function main(): Promise<void> {
  console.log('Query load generator (GET /logs)');
  console.log(
    `  rate=${QUERY_RATE}/s duration=${DURATION_SEC}s limit=${LIMIT} ` +
      `pages=${PAGES} window=${WINDOW_HOURS}h`,
  );

  await waitForHealth();

  process.stdout.write('Discovering dataset ... ');
  const ds = await discoverDataset(URL_BASE, HEADERS, WINDOW_HOURS, UNTIL_OVERRIDE);
  console.log(`newest row ${ds.end.toISOString()}, busiest service '${ds.service}'`);

  const shapes = buildShapes(ds);
  console.log(`Built ${shapes.length} query shapes.\n`);

  if (WARMUP_SEC > 0) {
    console.log(`Warmup ${WARMUP_SEC}s (not recorded)...`);
    await runShapePhase(shapes.map(newShapeMetrics), WARMUP_SEC, false);
  }

  console.log('\nPhase 1: query shapes...');
  const metrics = shapes.map(newShapeMetrics);
  const phase1Sec = await runShapePhase(metrics, DURATION_SEC, true);

  console.log(`Phase 2: walking ${PAGES} pages via next_cursor...`);
  const pages = await paginationWalk();
  console.log(`  walked ${pages.length} pages.`);

  printReport(metrics, pages, ds, phase1Sec);
}

main().catch((err) => {
  console.error('Query load generator failed:', err.message ?? err);
  process.exit(1);
});
