
// Run: npx tsx loadgen/mixed.ts

import {
  summarizeLatencies,
  formatLatencyBlock,
  fmtInt,
  fmtNum,
  fmtMs,
} from './report.js';
import {
  authHeaders,
  baseUrl,
  envInt,
  envNum,
  envStr,
  parseJson,
  pick,
  randInt,
  sleep,
  timedFetch,
  waitForHealth,
} from './util.js';


const URL_BASE = baseUrl();
const DURATION_SEC = envInt('LOADGEN_DURATION_SEC', 60);
const WARMUP_SEC = envInt('LOADGEN_WARMUP_SEC', 5, 0);
const BATCH_SIZE = envInt('LOADGEN_BATCH_SIZE', 500);
const CONCURRENCY = envInt('LOADGEN_CONCURRENCY', 16);
const AGG_RATE = envNum('LOADGEN_AGG_RATE', 1);
const WINDOW_HOURS = envInt('LOADGEN_WINDOW_HOURS', 1);
const FRESHNESS_EVERY_SEC = envInt('LOADGEN_FRESHNESS_EVERY_SEC', 10);
const API_KEY = envStr('LOADGEN_API_KEY');

const INGEST_URL = `${URL_BASE}/logs`;
const QUERY_URL = `${URL_BASE}/logs`;
const AGG_URL = `${URL_BASE}/logs/aggregate`;

// Spec targets this run is judged against.
const AGG_P95_TARGET_MS = 1000;
const FRESHNESS_TARGET_MS = 20_000;

const GET_HEADERS: Record<string, string> = authHeaders();
const JSON_HEADERS: Record<string, string> = {
  'content-type': 'application/json',
  ...GET_HEADERS,
};


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


interface Metrics {
  // ingest
  ingestRequests: number;
  ingestOk: number;
  ingestThrottled: number;
  ingestFailed: number;
  logsAccepted: number;
  ingestLatencies: number[];
  ingestNetworkFailures: number;
  // aggregate
  aggRequests: number;
  aggOk: number;
  aggFailed: number;
  aggLatencies: number[];
  aggNetworkFailures: number;
  
  aggStartMs: number;
  aggEndMs: number;
  freshnessSamples: number[];
  freshnessTimeouts: number;
  errorSamples: string[];
}

function newMetrics(): Metrics {
  return {
    ingestRequests: 0, ingestOk: 0, ingestThrottled: 0, ingestFailed: 0,
    logsAccepted: 0, ingestLatencies: [], ingestNetworkFailures: 0,
    aggRequests: 0, aggOk: 0, aggFailed: 0, aggLatencies: [], aggNetworkFailures: 0,
    aggStartMs: 0, aggEndMs: 0,
    freshnessSamples: [], freshnessTimeouts: 0,
    errorSamples: [],
  };
}

function noteError(m: Metrics, msg: string): void {
  if (m.errorSamples.length < 8) m.errorSamples.push(msg);
}


async function ingestWorker(
  m: Metrics,
  record: boolean,
  done: () => boolean,
): Promise<void> {
  while (!done()) {
    const body = makeBatchBody(Date.now());
    const res = await timedFetch(INGEST_URL, {
      method: 'POST',
      headers: JSON_HEADERS,
      body,
    });
    if (!record) continue;

    m.ingestRequests++;
    if (!res.ok) {
      m.ingestFailed++;
      m.ingestNetworkFailures++;
      noteError(m, `ingest network: ${res.error}`);
      continue;
    }

    m.ingestLatencies.push(res.elapsedMs);
    if (res.status === 200) {
      m.ingestOk++;
      m.logsAccepted += parseJson<{ accepted?: number }>(res)?.accepted ?? 0;
    } else {
      if (res.status === 429) m.ingestThrottled++;
      else m.ingestFailed++;
      noteError(m, `ingest HTTP ${res.status}: ${res.text.slice(0, 120)}`);
    }
  }
}


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

    const res = await timedFetch(`${AGG_URL}?${qs.toString()}`, {
      headers: GET_HEADERS,
    });
    if (!record) continue;

    m.aggRequests++;
    if (!res.ok) {
      m.aggFailed++;
      m.aggNetworkFailures++;
      noteError(m, `aggregate network: ${res.error}`);
      continue;
    }
    m.aggLatencies.push(res.elapsedMs);
    if (res.status === 200) m.aggOk++;
    else {
      m.aggFailed++;
      noteError(m, `aggregate HTTP ${res.status}: ${res.text.slice(0, 120)}`);
    }
  }

  if (record) m.aggEndMs = Date.now();
}

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

    const write = await timedFetch(INGEST_URL, {
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
    if (!write.ok || write.status !== 200) {
      if (record) {
        noteError(
          m,
          `freshness write ${write.ok ? `HTTP ${write.status}` : write.error}`,
        );
      }
      continue;
    }

    
    let visible = false;
    while (performance.now() - t0 < FRESHNESS_TARGET_MS) {
      const q = await timedFetch(
        `${QUERY_URL}?service=${encodeURIComponent(marker)}&limit=1`,
        { headers: GET_HEADERS },
      );
      if (q.ok && q.status === 200) {
        const body = parseJson<{ logs: unknown[] }>(q);
        if (body !== undefined && body.logs.length > 0) {
          visible = true;
          break;
        }
      }
      await sleep(250);
    }

    const elapsed = performance.now() - t0;
    if (record) {
      if (visible) m.freshnessSamples.push(elapsed);
      else {
        m.freshnessTimeouts++;
        noteError(
          m,
          `freshness probe not visible within ${FRESHNESS_TARGET_MS}ms`,
        );
      }
    }
  }
}

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

function printReport(m: Metrics, wallSec: number): void {
  const line = '─'.repeat(68);
  const ing = summarizeLatencies(m.ingestLatencies);
  const agg = summarizeLatencies(m.aggLatencies);
  const fresh = summarizeLatencies(m.freshnessSamples);

  const acceptedPerSec = m.logsAccepted / wallSec;
 
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
  if (m.ingestNetworkFailures > 0) {
    console.log(`    excluded      : ${fmtInt(m.ingestNetworkFailures)} network failures (no latency sample)`);
  }
  console.log('');

  console.log('  Aggregation (during sustained ingestion)  <-- the grading scenario');
  console.log(`    requests      : ${fmtInt(m.aggRequests)}  ` +
    `(${fmtInt(m.aggOk)} ok, ${fmtInt(m.aggFailed)} failed)`);
  console.log(`    achieved rate : ${fmtNum(aggRateAchieved)} req/s ` +
    `(offered ${fmtNum(AGG_RATE)}/s over ${fmtNum(aggWindowSec)}s)`);
  console.log(formatLatencyBlock(agg, m.aggNetworkFailures));
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


async function main(): Promise<void> {
  console.log('Mixed workload generator (query while ingesting)');
  console.log(
    `  duration=${DURATION_SEC}s ingest=${CONCURRENCY}x${BATCH_SIZE} ` +
      `agg=${AGG_RATE}/s freshness=every ${FRESHNESS_EVERY_SEC}s`,
  );

  await waitForHealth(URL_BASE);

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
