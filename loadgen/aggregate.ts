

// Run: npx tsx loadgen/aggregate.ts

import {
  summarizeLatencies,
  formatLatencyBlock,
  fmtInt,
  fmtNum,
  fmtMs,
  type LatencySummary,
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
const RATE_PER_SEC = envNum('LOADGEN_AGG_RATE', 1);
const DURATION_SEC = envInt('LOADGEN_DURATION_SEC', 60);
const WARMUP_SEC = envInt('LOADGEN_WARMUP_SEC', 5, 0);
const WINDOW_HOURS = envInt('LOADGEN_WINDOW_HOURS', 24);
const API_KEY = envStr('LOADGEN_API_KEY');
const UNTIL_OVERRIDE = envStr('LOADGEN_UNTIL');

const AGG_URL = `${URL_BASE}/logs/aggregate`;
const LOGS_URL = `${URL_BASE}/logs`;

const P95_TARGET_MS = 1000;

const HEADERS: Record<string, string> = authHeaders();


interface QueryShape {
  readonly name: string;
 
  readonly exercises: string;
  readonly query: string;
}

function buildShapes(ds: Dataset): QueryShape[] {
 
  const until = new Date(ds.end.getTime() + 1000).toISOString();
  const shapes: QueryShape[] = [];

  const add = (
    name: string,
    exercises: string,
    params: Record<string, string>,
  ): void => {
    const qs = new URLSearchParams({ until, ...params });
    shapes.push({ name, exercises, query: qs.toString() });
  };

  add('1m / 1h / no group', 'date_bin at finest granularity', {
    since: isoOf(ds.end, 1),
    bucket: '1m',
  });

  add('1m / 1h / group=service', 'grouping multiplies bucket rows', {
    since: isoOf(ds.end, 1),
    bucket: '1m',
    group_by: 'service',
  });

  add('5m / 6h / group=service', 'wider scan, medium buckets', {
    since: isoOf(ds.end, 6),
    bucket: '5m',
    group_by: 'service',
  });

 

  add(`1h / ${WINDOW_HOURS}h / group=level`, 'widest scan, coarse buckets', {
    since: isoOf(ds.end, WINDOW_HOURS),
    bucket: '1h',
    group_by: 'level',
  });

 

  add(`1h / ${WINDOW_HOURS}h / service filter`, 'composite B-tree index', {
    since: isoOf(ds.end, WINDOW_HOURS),
    bucket: '1h',
    service: ds.service,
  });

  if (ds.attrKey !== undefined && ds.attrValue !== undefined) {
    add(`1h / ${WINDOW_HOURS}h / attr filter`, 'GIN jsonb_path_ops index', {
      since: isoOf(ds.end, WINDOW_HOURS),
      bucket: '1h',
      [`attr.${ds.attrKey}`]: ds.attrValue,
    });
  }

  
  if (ds.word !== undefined) {
    add(`1h / ${WINDOW_HOURS}h / q= substring`, 'UNINDEXED message ILIKE scan', {
      since: isoOf(ds.end, WINDOW_HOURS),
      bucket: '1h',
      q: ds.word,
    });
  }

  return shapes;
}


interface ShapeMetrics {
  readonly shape: QueryShape;
  latencies: number[];
  ok: number;
  badRequest: number;
  failed: number;
  bucketsReturned: number;

  networkFailures: number;
  errorSample: string | undefined;
}

function newShapeMetrics(shape: QueryShape): ShapeMetrics {
  return {
    shape,
    latencies: [],
    ok: 0,
    badRequest: 0,
    failed: 0,
    bucketsReturned: 0,
    networkFailures: 0,
    errorSample: undefined,
  };
}

/**
 * Issue one aggregation request and record the outcome.
 */
async function runOne(m: ShapeMetrics, record: boolean): Promise<void> {
  const res = await timedFetch(`${AGG_URL}?${m.shape.query}`, {
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
    m.bucketsReturned += parseJson<{ buckets: unknown[] }>(res)?.buckets.length ?? 0;
  } else {
    if (res.status === 400) m.badRequest++;
    else m.failed++;
    m.errorSample ??= `HTTP ${res.status}: ${res.text.slice(0, 140)}`;
  }
}

async function runPhase(
  metrics: ShapeMetrics[],
  durationSec: number,
  record: boolean,
  onTick?: (elapsedSec: number) => void,
): Promise<void> {
  const intervalMs = 1000 / RATE_PER_SEC;
  const start = Date.now();
  const endAt = start + durationSec * 1000;

  for (let k = 0; Date.now() < endAt; k++) {
    const due = start + k * intervalMs;
    const wait = due - Date.now();
    if (wait > 0) await sleep(wait);
    if (Date.now() >= endAt) break;

    const m = metrics[k % metrics.length]!;
    await runOne(m, record);

    if (record && onTick) onTick((Date.now() - start) / 1000);
  }
}


function printReport(
  metrics: ShapeMetrics[],
  ds: Dataset,
  wallSec: number,
): void {
  const line = '─'.repeat(72);
  const all: number[] = [];
  for (const m of metrics) all.push(...m.latencies);
  const overall = summarizeLatencies(all);

  const totalReq = metrics.reduce(
    (n, m) => n + m.ok + m.badRequest + m.failed,
    0,
  );
  const totalErrors = metrics.reduce((n, m) => n + m.badRequest + m.failed, 0);
  const totalNetworkFailures = metrics.reduce((n, m) => n + m.networkFailures, 0);

  console.log(`\n${line}`);
  console.log('  AGGREGATION LATENCY REPORT');
  console.log(line);
  console.log('  Config');
  console.log(`    url          : ${AGG_URL}`);
  console.log(`    rate         : ${fmtNum(RATE_PER_SEC)} req/s (spec: 1/s)`);
  console.log(`    duration     : ${fmtNum(wallSec)} s measured`);
  console.log(`    auth         : ${API_KEY ? 'bearer token' : 'none'}`);
  console.log(`    query shapes : ${metrics.length}`);
  console.log('');
  console.log('  Dataset window (discovered via GET /logs)');
  console.log(`    newest row   : ${ds.end.toISOString()}`);
  console.log(`    widest range : ${WINDOW_HOURS}h back from newest`);
  console.log(`    filters used : service='${ds.service}'` +
    `${ds.attrKey ? `, attr.${ds.attrKey}='${ds.attrValue}'` : ''}` +
    `${ds.word ? `, q='${ds.word}'` : ''}`);
  console.log('');
  console.log('  Per-shape latency (ms)');
  console.log(
    `    ${'shape'.padEnd(34)} ${'n'.padStart(5)} ${'p50'.padStart(8)} ` +
      `${'p95'.padStart(8)} ${'p99'.padStart(8)} ${'max'.padStart(8)}  buckets`,
  );
  for (const m of metrics) {
    const s = summarizeLatencies(m.latencies);
    const avgBuckets = m.ok > 0 ? m.bucketsReturned / m.ok : 0;
    const flag = s.p95 > P95_TARGET_MS ? ' <-- OVER TARGET' : '';
    console.log(
      `    ${m.shape.name.padEnd(34)} ${fmtInt(s.count).padStart(5)} ` +
        `${fmtNum(s.p50, 1).padStart(8)} ${fmtNum(s.p95, 1).padStart(8)} ` +
        `${fmtNum(s.p99, 1).padStart(8)} ${fmtNum(s.max, 1).padStart(8)}  ` +
        `${fmtInt(avgBuckets).padStart(7)}${flag}`,
    );
  }
  console.log('');
  console.log('  What each shape exercises');
  for (const m of metrics) {
    console.log(`    ${m.shape.name.padEnd(34)} ${m.shape.exercises}`);
  }
  console.log('');
  console.log('  Overall latency (all shapes pooled)');
  console.log(formatLatencyBlock(overall, totalNetworkFailures));
  console.log('');

  // The verdict uses the WORST shape, so the claim holds universally.
  let worst: { name: string; s: LatencySummary } | undefined;
  for (const m of metrics) {
    const s = summarizeLatencies(m.latencies);
    if (s.count === 0) continue;
    if (worst === undefined || s.p95 > worst.s.p95) {
      worst = { name: m.shape.name, s };
    }
  }

  console.log('  Verdict');
  console.log(`    target          : p95 < ${fmtInt(P95_TARGET_MS)} ms`);
  console.log(`    requests        : ${fmtInt(totalReq)} (${fmtInt(totalErrors)} non-200)`);
  console.log(`    overall p95     : ${fmtMs(overall.p95)}`);
  if (worst) {
    console.log(
      `    worst shape p95 : ${fmtMs(worst.s.p95)}  (${worst.name})`,
    );
  }
  const pass =
    worst !== undefined && worst.s.p95 < P95_TARGET_MS && totalErrors === 0;
  console.log(
    `    result          : ${pass ? 'PASS — every shape under target' : 'REVIEW — see flagged rows above'}`,
  );

  const withErrors = metrics.filter((m) => m.errorSample !== undefined);
  if (withErrors.length > 0) {
    console.log('');
    console.log('  Error samples');
    for (const m of withErrors) {
      console.log(`    ${m.shape.name}: ${m.errorSample}`);
    }
  }
  console.log(line + '\n');
}


async function main(): Promise<void> {
  console.log('Aggregation load generator');
  console.log(
    `  rate=${RATE_PER_SEC}/s duration=${DURATION_SEC}s ` +
      `window=${WINDOW_HOURS}h warmup=${WARMUP_SEC}s`,
  );

  await waitForHealth(URL_BASE);

  process.stdout.write('Discovering dataset window ... ');
  const ds = await discoverDataset(
    URL_BASE,
    HEADERS,
    WINDOW_HOURS,
    UNTIL_OVERRIDE,
  );
  console.log(`newest row ${ds.end.toISOString()}`);

  const shapes = buildShapes(ds);
  console.log(`Built ${shapes.length} query shapes.\n`);

  if (WARMUP_SEC > 0) {
    console.log(`Warmup ${WARMUP_SEC}s (not recorded — first run of each`);
    console.log('shape pays cold shared-buffer cost)...');
    const warm = shapes.map(newShapeMetrics);
    await runPhase(warm, WARMUP_SEC, false);
  }

  console.log('\nMeasuring...');
  const metrics = shapes.map(newShapeMetrics);
  const start = Date.now();

  let lastLogged = 0;
  await runPhase(metrics, DURATION_SEC, true, (elapsed) => {
    // One progress line every 10s so a 60s run stays readable.
    if (elapsed - lastLogged >= 10) {
      lastLogged = elapsed;
      const done = metrics.reduce((n, m) => n + m.latencies.length, 0);
      const pooled = summarizeLatencies(metrics.flatMap((m) => m.latencies));
      console.log(
        `  [${elapsed.toFixed(0).padStart(3)}s] requests=${fmtInt(done)}  ` +
          `p95=${fmtMs(pooled.p95)}`,
      );
    }
  });

  const wallSec = (Date.now() - start) / 1000;
  printReport(metrics, ds, wallSec);
}

main().catch((err) => {
  console.error('Aggregation load generator failed:', err.message ?? err);
  process.exit(1);
});
