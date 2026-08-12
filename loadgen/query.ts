
// Run: npx tsx loadgen/query.ts

import {
  summarizeLatencies,
  formatLatencyBlock,
  fmtInt,
  fmtNum,
  fmtMs,
} from './report.js';
import { discoverDataset, isoOf, type Dataset } from './discover.js';
import {
  authHeaders,
  baseUrl,
  envInt,
  envNum,
  envStr,
  parseJson,
  sleep,
  timedFetch,
  waitForHealth,
} from './util.js';

const URL_BASE = baseUrl();
const QUERY_RATE = envNum('LOADGEN_QUERY_RATE', 5);
const DURATION_SEC = envInt('LOADGEN_DURATION_SEC', 60);
const WARMUP_SEC = envInt('LOADGEN_WARMUP_SEC', 5, 0);
const LIMIT = envInt('LOADGEN_LIMIT', 100);
const PAGES = envInt('LOADGEN_PAGES', 200);
const WINDOW_HOURS = envInt('LOADGEN_WINDOW_HOURS', 24);
const UNTIL_OVERRIDE = envStr('LOADGEN_UNTIL');
const API_KEY = envStr('LOADGEN_API_KEY');

const LOGS_URL = `${URL_BASE}/logs`;

const HEADERS: Record<string, string> = authHeaders();


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

  
  if (ds.word !== undefined) {
    add('q= substring', 'UNINDEXED message ILIKE scan', { q: ds.word });
  }

  // Maximum page size: same access path, ~10x the rows serialized.
  add('newest 1000 (max limit)', 'payload size at the limit ceiling', {
    limit: '1000',
  });

  return shapes;
}


interface ShapeMetrics {
  readonly shape: QueryShape;
  latencies: number[];
  ok: number;
  failed: number;
  rowsReturned: number;
  
  networkFailures: number;
  errorSample: string | undefined;
}

function newShapeMetrics(shape: QueryShape): ShapeMetrics {
  return {
    shape,
    latencies: [],
    ok: 0,
    failed: 0,
    rowsReturned: 0,
    networkFailures: 0,
    errorSample: undefined,
  };
}

interface PageSample {
  readonly page: number;
  readonly ms: number;
  readonly rows: number;
}


async function runShape(m: ShapeMetrics, record: boolean): Promise<void> {
  const res = await timedFetch(`${LOGS_URL}?${m.shape.query}`, {
    headers: HEADERS,
  });
  if (!record) return;

  if (!res.ok) {
    m.failed++;
    m.networkFailures++;
    m.errorSample ??= `network: ${res.error}`;
    return;
  }

  m.latencies.push(res.elapsedMs);
  if (res.status === 200) {
    m.ok++;
    m.rowsReturned += parseJson<{ logs: unknown[] }>(res)?.logs.length ?? 0;
  } else {
    m.failed++;
    m.errorSample ??= `HTTP ${res.status}: ${res.text.slice(0, 140)}`;
  }
}

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

async function paginationWalk(): Promise<PageSample[]> {
  const samples: PageSample[] = [];
  let cursor: string | null = null;

  for (let page = 1; page <= PAGES; page++) {
    const qs = new URLSearchParams({ limit: String(LIMIT) });
    if (cursor !== null) qs.set('cursor', cursor);

    const res = await timedFetch(`${LOGS_URL}?${qs.toString()}`, {
      headers: HEADERS,
    });
    if (!res.ok || res.status !== 200) {
      throw new Error(
        `Pagination failed at page ${page}: ` +
          (res.ok ? `HTTP ${res.status} ${res.text.slice(0, 140)}` : res.error),
      );
    }
    const body = parseJson<{ logs: unknown[]; next_cursor: string | null }>(res);
    if (body === undefined) {
      throw new Error(`Pagination page ${page} returned unparseable JSON`);
    }
    samples.push({ page, ms: res.elapsedMs, rows: body.logs.length });

    if (body.next_cursor === null) break; // ran out of data
    cursor = body.next_cursor;
  }

  return samples;
}


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
  const totalNetworkFailures = metrics.reduce((n, m) => n + m.networkFailures, 0);

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
  console.log(formatLatencyBlock(overall, totalNetworkFailures));
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


async function main(): Promise<void> {
  console.log('Query load generator (GET /logs)');
  console.log(
    `  rate=${QUERY_RATE}/s duration=${DURATION_SEC}s limit=${LIMIT} ` +
      `pages=${PAGES} window=${WINDOW_HOURS}h`,
  );

  await waitForHealth(URL_BASE);

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
