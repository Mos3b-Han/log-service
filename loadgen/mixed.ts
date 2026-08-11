// loadgen/mixed.ts
//
// The grading scenario: query while ingesting. Runs three workloads
// concurrently against the same instance and reports whether the read
// path holds up while the write path is saturated.
//
//   1. Ingest    -- N concurrent workers POSTing batches, as fast as
//                   the service accepts them.
//   2. Aggregate -- one GET /logs/aggregate per second, the rate the
//                   spec explicitly asks the service to sustain during
//                   the ingestion test.
//   3. Freshness -- periodically writes a uniquely-marked entry, then
//                   polls GET /logs until that exact entry is visible,
//                   measuring the write-to-readable delay.
//
// It exists because the three targets it covers cannot be proven by
// running the ingest and aggregate generators separately:
//
//   - "Maintain query performance while ingestion is active"
//   - "Support one aggregation request per second during the
//      ingestion test"
//   - "Make newly ingested data queryable within 20 seconds"
//
// The last one is the reason the freshness probe writes a marker rather
// than inferring from counters: the only honest proof that a specific
// accepted write became readable is to read that specific write back.
//
// Interpreting the output: compare the aggregation percentiles here
// against a quiet-system baseline from `npx tsx loadgen/aggregate.ts`.
// The delta is the real answer to "does ingestion hurt queries", and a
// number that barely moves is worth far more in the write-up than a
// good absolute figure with nothing to compare it to.
//
// Configuration (all optional):
//   LOADGEN_URL              base URL              default http://localhost:8080
//   LOADGEN_DURATION_SEC     measured seconds      default 60
//   LOADGEN_WARMUP_SEC       unrecorded warmup     default 5
//   LOADGEN_BATCH_SIZE       logs per POST         default 500
//   LOADGEN_CONCURRENCY      ingest workers        default 16
//   LOADGEN_AGG_RATE         aggregations/sec      default 1  (spec rate)
//   LOADGEN_WINDOW_HOURS     aggregation span      default 1
//   LOADGEN_FRESHNESS_EVERY_SEC  freshness probes  default 10
//   LOADGEN_API_KEY          bearer token          default none
//
// Run: npx tsx loadgen/mixed.ts

import {
  summarizeLatencies,
  formatLatencyBlock,
  fmtInt,
  fmtNum,
  fmtMs,
} from './report.js';

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
const DURATION_SEC = envInt('LOADGEN_DURATION_SEC', 60);
const WARMUP_SEC = envInt('LOADGEN_WARMUP_SEC', 5);
const BATCH_SIZE = envInt('LOADGEN_BATCH_SIZE', 500);
const CONCURRENCY = envInt('LOADGEN_CONCURRENCY', 16);
const AGG_RATE = envNum('LOADGEN_AGG_RATE', 1);
const WINDOW_HOURS = envInt('LOADGEN_WINDOW_HOURS', 1);
const FRESHNESS_EVERY_SEC = envInt('LOADGEN_FRESHNESS_EVERY_SEC', 10);
const API_KEY = process.env['LOADGEN_API_KEY'];

const INGEST_URL = `${URL_BASE}/logs`;
const QUERY_URL = `${URL_BASE}/logs`;
const AGG_URL = `${URL_BASE}/logs/aggregate`;
const HEALTH_URL = `${URL_BASE}/health`;

// Spec targets this run is judged against.
const AGG_P95_TARGET_MS = 1000;
const FRESHNESS_TARGET_MS = 20_000;

const JSON_HEADERS: Record<string, string> = {
  'content-type': 'application/json',
};
const GET_HEADERS: Record<string, string> = {};
if (API_KEY) {
  JSON_HEADERS['authorization'] = `Bearer ${API_KEY}`;
  GET_HEADERS['authorization'] = `Bearer ${API_KEY}`;
}

// ---------------------------------------------------------------
// Synthetic data
// ---------------------------------------------------------------

const SERVICES = [
  'checkout', 'auth', 'api', 'payments', 'search',
  'cart', 'inventory', 'notifications',
];
const LEVELS = ['debug', 'info', 'warn', 'error'];
const REGIONS = ['us-east', 'us-west', 'eu-west', 'eu-central', 'ap-south'];
const MESSAGES = [
  'request completed', 'payment declined', 'user login succeeded',
  'cache miss', 'database timeout', 'rate limited', 'validation failed',
  'connection reset', 'order placed', 'token refreshed',
];

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function randInt(maxExclusive: number): number {
  return Math.floor(Math.random() * maxExclusive);
}

function makeBatchBody(nowMs: number): string {
  const logs = new Array(BATCH_SIZE);
  for (let i = 0; i < BATCH_SIZE; i++) {
    logs[i] = {
      // Recent timestamps only: this workload models a live stream, and
      // the aggregation window below looks at the same recent period.
      timestamp: new Date(nowMs - randInt(60_000)).toISOString(),
      level: pick(LEVELS),
      service: pick(SERVICES),
      message: pick(MESSAGES),
      attributes: {
        user_id: String(randInt(100_000)),
        region: pick(REGIONS),
        retries: randInt(5),
      },
    };
  }
  return JSON.stringify({ logs });
}

// ---------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------

interface Metrics {
  // ingest
  ingestRequests: number;
  ingestOk: number;
  ingestThrottled: number;
  ingestFailed: number;
  logsAccepted: number;
  ingestLatencies: number[];
  // aggregate
  aggRequests: number;
  aggOk: number;
  aggFailed: number;
  aggLatencies: number[];
  // The aggregation driver's own active window. The achieved rate must
  // be computed against THIS, not the run's total wall time: Promise.all
  // keeps the phase alive until every ingest worker drains its in-flight
  // request, which inflates wall time by a second or two and would make
  // a perfectly paced 1.00 req/s report as ~0.89 req/s.
  aggStartMs: number;
  aggEndMs: number;
  // freshness
  freshnessSamples: number[];
  freshnessTimeouts: number;
  // diagnostics
  errorSamples: string[];
}

function newMetrics(): Metrics {
  return {
    ingestRequests: 0, ingestOk: 0, ingestThrottled: 0, ingestFailed: 0,
    logsAccepted: 0, ingestLatencies: [],
    aggRequests: 0, aggOk: 0, aggFailed: 0, aggLatencies: [],
    aggStartMs: 0, aggEndMs: 0,
    freshnessSamples: [], freshnessTimeouts: 0,
    errorSamples: [],
  };
}

function noteError(m: Metrics, msg: string): void {
  if (m.errorSamples.length < 8) m.errorSamples.push(msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------
// Workload 1: ingest
// ---------------------------------------------------------------

async function ingestWorker(
  m: Metrics,
  record: boolean,
  done: () => boolean,
): Promise<void> {
  while (!done()) {
    const body = makeBatchBody(Date.now());
    const t0 = performance.now();
    try {
      const res = await fetch(INGEST_URL, {
        method: 'POST',
        headers: JSON_HEADERS,
        body,
      });
      const elapsed = performance.now() - t0;

      if (res.status === 200) {
        const json = (await res.json()) as { accepted?: number };
        if (record) {
          m.ingestOk++;
          m.logsAccepted += json.accepted ?? 0;
        }
      } else {
        const text = await res.text();
        if (record) {
          if (res.status === 429) m.ingestThrottled++;
          else m.ingestFailed++;
          noteError(m, `ingest HTTP ${res.status}: ${text.slice(0, 120)}`);
        }
      }
      if (record) {
        m.ingestRequests++;
        m.ingestLatencies.push(elapsed);
      }
    } catch (err) {
      if (record) {
        m.ingestRequests++;
        m.ingestFailed++;
        noteError(m, `ingest network: ${(err as Error).message}`);
      }
    }
  }
}

// ---------------------------------------------------------------
// Workload 2: aggregation at a fixed rate
// ---------------------------------------------------------------

/**
 * Paced on an absolute schedule so a slow response does not silently
 * reduce the offered rate (coordinated omission). The query window
 * tracks "now" on every request, matching how a live dashboard polls.
 */
async function aggregateDriver(
  m: Metrics,
  record: boolean,
  done: () => boolean,
): Promise<void> {
  const intervalMs = 1000 / AGG_RATE;
  const start = Date.now();
  if (record) m.aggStartMs = start;

  for (let k = 0; !done(); k++) {
    const due = start + k * intervalMs;
    const wait = due - Date.now();
    if (wait > 0) await sleep(wait);
    if (done()) break;

    const until = new Date(Date.now() + 1000).toISOString();
    const since = new Date(
      Date.now() - WINDOW_HOURS * 3_600_000,
    ).toISOString();
    const qs = new URLSearchParams({
      since,
      until,
      bucket: '1m',
      group_by: 'service',
    });

    const t0 = performance.now();
    try {
      const res = await fetch(`${AGG_URL}?${qs.toString()}`, {
        headers: GET_HEADERS,
      });
      const elapsed = performance.now() - t0;
      if (res.status === 200) {
        await res.json();
        if (record) m.aggOk++;
      } else {
        const text = await res.text();
        if (record) {
          m.aggFailed++;
          noteError(m, `aggregate HTTP ${res.status}: ${text.slice(0, 120)}`);
        }
      }
      if (record) {
        m.aggRequests++;
        m.aggLatencies.push(elapsed);
      }
    } catch (err) {
      if (record) {
        m.aggRequests++;
        m.aggFailed++;
        noteError(m, `aggregate network: ${(err as Error).message}`);
      }
    }
  }

  if (record) m.aggEndMs = Date.now();
}

// ---------------------------------------------------------------
// Workload 3: freshness probe
// ---------------------------------------------------------------

/**
 * Write one uniquely-marked entry, then poll GET /logs until that exact
 * entry comes back, and record how long it took.
 *
 * This is the only honest way to measure the spec's "newly ingested
 * data is queryable within 20 seconds": inferring it from buffer
 * settings or row counts would be an argument, not a measurement. The
 * marker service name makes the query exact -- it matches this probe's
 * entry and nothing else, even while thousands of other rows per second
 * are landing.
 *
 * The clock starts before the POST, so the reported number includes
 * validation, buffering, the COPY, commit, and the read path -- the
 * full path a user actually waits on.
 */
async function freshnessDriver(
  m: Metrics,
  record: boolean,
  done: () => boolean,
): Promise<void> {
  let probe = 0;
  while (!done()) {
    await sleep(FRESHNESS_EVERY_SEC * 1000);
    if (done()) break;

    const marker = `freshness-${Date.now()}-${probe++}`;
    const t0 = performance.now();

    try {
      const res = await fetch(INGEST_URL, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          logs: [
            {
              timestamp: new Date().toISOString(),
              level: 'info',
              service: marker,
              message: 'freshness probe',
            },
          ],
        }),
      });
      if (res.status !== 200) {
        await res.text();
        if (record) noteError(m, `freshness write HTTP ${res.status}`);
        continue;
      }
      await res.json();

      // Poll until visible or the target elapses. A 250ms interval is
      // fine-grained enough to resolve a sub-second result without
      // adding meaningful load next to the ingest workers.
      let visible = false;
      while (performance.now() - t0 < FRESHNESS_TARGET_MS) {
        const q = await fetch(
          `${QUERY_URL}?service=${encodeURIComponent(marker)}&limit=1`,
          { headers: GET_HEADERS },
        );
        if (q.status === 200) {
          const body = (await q.json()) as { logs: unknown[] };
          if (body.logs.length > 0) {
            visible = true;
            break;
          }
        } else {
          await q.text();
        }
        await sleep(250);
      }

      const elapsed = performance.now() - t0;
      if (record) {
        if (visible) m.freshnessSamples.push(elapsed);
        else {
          m.freshnessTimeouts++;
          noteError(m, `freshness probe not visible within ${FRESHNESS_TARGET_MS}ms`);
        }
      }
    } catch (err) {
      if (record) noteError(m, `freshness: ${(err as Error).message}`);
    }
  }
}

// ---------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------

async function runPhase(
  m: Metrics,
  seconds: number,
  record: boolean,
): Promise<void> {
  const endAt = Date.now() + seconds * 1000;
  const done = (): boolean => Date.now() >= endAt;

  const tasks: Promise<void>[] = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    tasks.push(ingestWorker(m, record, done));
  }
  tasks.push(aggregateDriver(m, record, done));
  if (record) tasks.push(freshnessDriver(m, record, done));

  await Promise.all(tasks);
}

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

function printReport(m: Metrics, wallSec: number): void {
  const line = '─'.repeat(68);
  const ing = summarizeLatencies(m.ingestLatencies);
  const agg = summarizeLatencies(m.aggLatencies);
  const fresh = summarizeLatencies(m.freshnessSamples);

  const acceptedPerSec = m.logsAccepted / wallSec;
  // Rate is measured over the aggregation driver's own window; see the
  // comment on aggStartMs.
  const aggWindowSec =
    m.aggEndMs > m.aggStartMs ? (m.aggEndMs - m.aggStartMs) / 1000 : wallSec;
  const aggRateAchieved = m.aggRequests / aggWindowSec;
  const ingestDropped = m.ingestThrottled + m.ingestFailed;

  console.log(`\n${line}`);
  console.log('  MIXED WORKLOAD REPORT — querying while ingesting');
  console.log(line);
  console.log('  Config');
  console.log(`    duration        : ${fmtNum(wallSec)} s measured`);
  console.log(`    ingest          : ${CONCURRENCY} workers x ${fmtInt(BATCH_SIZE)} logs/batch`);
  console.log(`    aggregation     : ${fmtNum(AGG_RATE)} req/s over a ${WINDOW_HOURS}h window`);
  console.log(`    freshness probe : every ${FRESHNESS_EVERY_SEC}s`);
  console.log(`    auth            : ${API_KEY ? 'bearer token' : 'none'}`);
  console.log('');

  console.log('  Ingestion (under concurrent query load)');
  console.log(`    requests      : ${fmtInt(m.ingestRequests)}  ` +
    `(${fmtInt(m.ingestOk)} ok, ${fmtInt(m.ingestThrottled)} x 429, ${fmtInt(m.ingestFailed)} failed)`);
  console.log(`    logs accepted : ${fmtInt(m.logsAccepted)}  (${fmtInt(acceptedPerSec)}/s)`);
  console.log(`    latency p50   : ${fmtMs(ing.p50)}`);
  console.log(`    latency p95   : ${fmtMs(ing.p95)}`);
  console.log('');

  console.log('  Aggregation (during sustained ingestion)  <-- the grading scenario');
  console.log(`    requests      : ${fmtInt(m.aggRequests)}  ` +
    `(${fmtInt(m.aggOk)} ok, ${fmtInt(m.aggFailed)} failed)`);
  console.log(`    achieved rate : ${fmtNum(aggRateAchieved)} req/s ` +
    `(offered ${fmtNum(AGG_RATE)}/s over ${fmtNum(aggWindowSec)}s)`);
  console.log(formatLatencyBlock(agg));
  console.log('');

  console.log('  Freshness (write -> readable, full round trip)');
  if (fresh.count > 0) {
    console.log(`    probes        : ${fmtInt(fresh.count)} visible, ` +
      `${fmtInt(m.freshnessTimeouts)} timed out`);
    console.log(`    min / p50     : ${fmtMs(fresh.min)} / ${fmtMs(fresh.p50)}`);
    console.log(`    p95 / max     : ${fmtMs(fresh.p95)} / ${fmtMs(fresh.max)}`);
  } else {
    console.log(`    no successful probes (${fmtInt(m.freshnessTimeouts)} timed out)`);
  }
  console.log('');

  console.log('  Verdict');
  const aggPass = agg.count > 0 && agg.p95 < AGG_P95_TARGET_MS && m.aggFailed === 0;
  const freshPass = fresh.count > 0 && fresh.max < FRESHNESS_TARGET_MS && m.freshnessTimeouts === 0;
  const dropPass = ingestDropped === 0;
  const ratePass = aggRateAchieved >= AGG_RATE * 0.95;

  const row = (label: string, ok: boolean, detail: string): void => {
    console.log(`    ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(42)} ${detail}`);
  };
  row('aggregation p95 < 1s while ingesting', aggPass, fmtMs(agg.p95));
  row(`sustained >= ${fmtNum(AGG_RATE)} aggregation req/s`, ratePass,
    `${fmtNum(aggRateAchieved)}/s`);
  row('new data queryable within 20s', freshPass,
    fresh.count > 0 ? `max ${fmtMs(fresh.max)}` : 'no samples');
  row('zero dropped ingest requests', dropPass, `${fmtInt(ingestDropped)} dropped`);

  console.log('');
  console.log(`    OVERALL: ${aggPass && ratePass && freshPass && dropPass ? 'PASS' : 'REVIEW'}`);

  if (m.errorSamples.length > 0) {
    console.log('');
    console.log('  Error samples');
    for (const e of m.errorSamples) console.log(`    - ${e}`);
  }
  console.log(line);
  console.log('  Compare the aggregation percentiles above against a quiet-system');
  console.log('  baseline:  npx tsx loadgen/aggregate.ts');
  console.log(line + '\n');
}

// ---------------------------------------------------------------
// Main
// ---------------------------------------------------------------

async function main(): Promise<void> {
  console.log('Mixed workload generator (query while ingesting)');
  console.log(
    `  duration=${DURATION_SEC}s ingest=${CONCURRENCY}x${BATCH_SIZE} ` +
      `agg=${AGG_RATE}/s freshness=every ${FRESHNESS_EVERY_SEC}s`,
  );

  await waitForHealth();

  if (WARMUP_SEC > 0) {
    console.log(`\nWarmup ${WARMUP_SEC}s (not recorded)...`);
    await runPhase(newMetrics(), WARMUP_SEC, false);
  }

  console.log('\nMeasuring...');
  const m = newMetrics();
  const start = Date.now();

  const progress = setInterval(() => {
    const elapsed = (Date.now() - start) / 1000;
    const agg = summarizeLatencies(m.aggLatencies);
    console.log(
      `  [${elapsed.toFixed(0).padStart(3)}s] ` +
        `accepted=${fmtInt(m.logsAccepted).padStart(10)}  ` +
        `agg=${fmtInt(m.aggRequests).padStart(3)} p95=${fmtMs(agg.p95).padStart(11)}  ` +
        `fresh=${m.freshnessSamples.length}  429=${m.ingestThrottled} fail=${m.ingestFailed}`,
    );
  }, 10_000);
  progress.unref();

  await runPhase(m, DURATION_SEC, true);
  clearInterval(progress);

  printReport(m, (Date.now() - start) / 1000);
}

main().catch((err) => {
  console.error('Mixed load generator failed:', err.message ?? err);
  process.exit(1);
});
