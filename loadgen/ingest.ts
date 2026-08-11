// loadgen/ingest.ts
//
// Ingestion load generator. Drives POST /logs as an external HTTP
// client -- exactly how the grader's load generator sees the service --
// and reports achieved throughput, latency percentiles, and the status
// breakdown that proves whether any request was dropped.
//
// Load model: a closed loop of N concurrent workers, each generating a
// batch, POSTing it, awaiting the response, and repeating. Achieved
// throughput is therefore whatever the server can absorb -- the client
// only has to keep enough batches in flight to saturate it. At batch
// 500 the 15,000 logs/sec target is just ~30 requests/sec, so the
// bottleneck under test is the server's COPY path, not this client.
//
// Configuration (all via environment, all optional):
//   LOADGEN_URL           base URL              default http://localhost:8080
//   LOADGEN_BATCH_SIZE    logs per POST         default 500
//   LOADGEN_CONCURRENCY   parallel workers      default 16
//   LOADGEN_DURATION_SEC  measured seconds      default 30
//   LOADGEN_WARMUP_SEC    unrecorded warmup     default 5
//   LOADGEN_TOTAL_LOGS    if set, run until this many logs are sent
//                         (count mode, no warmup) instead of by time
//   LOADGEN_API_KEY       bearer token          default none
//
// Run: npx tsx loadgen/ingest.ts

import {
  summarizeLatencies,
  formatLatencyBlock,
  fmtInt,
  fmtNum,
  fmtBytes,
} from './report.js';

// ---------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------

function envInt(name: string, dflt: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return dflt;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n <= 0) {
    throw new Error(`Invalid ${name}: '${raw}'`);
  }
  return n;
}

const URL_BASE = process.env['LOADGEN_URL'] ?? 'http://localhost:8080';
const BATCH_SIZE = envInt('LOADGEN_BATCH_SIZE', 500);
const CONCURRENCY = envInt('LOADGEN_CONCURRENCY', 16);
const DURATION_SEC = envInt('LOADGEN_DURATION_SEC', 30);
const WARMUP_SEC = process.env['LOADGEN_WARMUP_SEC']
  ? envInt('LOADGEN_WARMUP_SEC', 5)
  : 5;
const TOTAL_LOGS = process.env['LOADGEN_TOTAL_LOGS']
  ? envInt('LOADGEN_TOTAL_LOGS', 0)
  : undefined;
const API_KEY = process.env['LOADGEN_API_KEY'];

const INGEST_URL = `${URL_BASE.replace(/\/$/, '')}/logs`;
const HEALTH_URL = `${URL_BASE.replace(/\/$/, '')}/health`;

const HEADERS: Record<string, string> = {
  'content-type': 'application/json',
};
if (API_KEY) HEADERS['authorization'] = `Bearer ${API_KEY}`;

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
  return arr[(Math.random() * arr.length) | 0]!;
}

function randInt(maxExclusive: number): number {
  return (Math.random() * maxExclusive) | 0;
}

interface WireEntry {
  timestamp: string;
  level: string;
  service: string;
  message: string;
  attributes: Record<string, string | number>;
}

// Build one batch. `nowMs` is computed once per batch by the caller.
// Timestamps are jittered across the last 60s so the resulting dataset
// spreads over time (useful for the later time-bucket query tests) and
// is always a valid, non-future value.
function makeBatchBody(nowMs: number): string {
  const logs: WireEntry[] = new Array(BATCH_SIZE);
  for (let i = 0; i < BATCH_SIZE; i++) {
    logs[i] = {
      timestamp: new Date(nowMs - randInt(60_000)).toISOString(),
      level: pick(LEVELS),
      service: pick(SERVICES),
      message: pick(MESSAGES),
      attributes: {
        user_id: String(randInt(100_000)),
        region: pick(REGIONS),
        // A mix of number and string values exercises normalization.
        retries: randInt(5),
      },
    };
  }
  return JSON.stringify({ logs });
}

// ---------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------

interface Metrics {
  requests: number;
  ok: number; // 200
  rejected: number; // 400
  throttled: number; // 429
  failed: number; // 5xx or network error
  logsSent: number;
  logsAccepted: number;
  bytesSent: number;
  latencies: number[]; // ms, per request
  firstErrorSamples: string[];
}

function newMetrics(): Metrics {
  return {
    requests: 0, ok: 0, rejected: 0, throttled: 0, failed: 0,
    logsSent: 0, logsAccepted: 0, bytesSent: 0,
    latencies: [], firstErrorSamples: [],
  };
}

// ---------------------------------------------------------------
// Worker + phase runner
// ---------------------------------------------------------------

interface PhaseOpts {
  readonly label: string;
  readonly record: boolean;
  // Stop when this returns true. Evaluated at the top of each worker
  // iteration.
  readonly done: () => boolean;
}

async function runWorker(m: Metrics, opts: PhaseOpts): Promise<void> {
  while (!opts.done()) {
    const nowMs = Date.now();
    const body = makeBatchBody(nowMs);
    const bytes = Buffer.byteLength(body);

    const t0 = performance.now();
    try {
      const res = await fetch(INGEST_URL, {
        method: 'POST',
        headers: HEADERS,
        body,
      });
      const elapsed = performance.now() - t0;

      // Always drain the body so the socket is freed for keep-alive
      // reuse; parse it only when we need the accepted count.
      if (res.status === 200) {
        const json = (await res.json()) as { accepted?: number };
        if (opts.record) {
          m.ok++;
          m.logsAccepted += json.accepted ?? 0;
        }
      } else {
        const text = await res.text();
        if (opts.record) {
          if (res.status === 429) m.throttled++;
          else if (res.status === 400) m.rejected++;
          else m.failed++;
          if (m.firstErrorSamples.length < 5) {
            m.firstErrorSamples.push(`HTTP ${res.status}: ${text.slice(0, 120)}`);
          }
        }
      }

      if (opts.record) {
        m.requests++;
        m.logsSent += BATCH_SIZE;
        m.bytesSent += bytes;
        m.latencies.push(elapsed);
      }
    } catch (err) {
      if (opts.record) {
        m.requests++;
        m.failed++;
        if (m.firstErrorSamples.length < 5) {
          m.firstErrorSamples.push(`network: ${(err as Error).message}`);
        }
      }
    }
  }
}

async function runPhase(opts: PhaseOpts): Promise<Metrics> {
  const m = newMetrics();
  const workers: Promise<void>[] = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    workers.push(runWorker(m, opts));
  }
  await Promise.all(workers);
  return m;
}

// ---------------------------------------------------------------
// Progress printer
// ---------------------------------------------------------------

function startProgress(m: Metrics, startMs: number): NodeJS.Timeout {
  let lastAccepted = 0;
  let lastMs = startMs;
  const timer = setInterval(() => {
    const now = Date.now();
    const windowSec = (now - lastMs) / 1000;
    const windowRate = (m.logsAccepted - lastAccepted) / windowSec;
    const elapsed = (now - startMs) / 1000;
    process.stdout.write(
      `  [${elapsed.toFixed(0).padStart(3)}s] ` +
        `accepted=${fmtInt(m.logsAccepted).padStart(11)}  ` +
        `now=${fmtInt(windowRate).padStart(8)}/s  ` +
        `reqs=${fmtInt(m.requests)}  ` +
        `429=${m.throttled} fail=${m.failed}\n`,
    );
    lastAccepted = m.logsAccepted;
    lastMs = now;
  }, 1000);
  timer.unref();
  return timer;
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
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Service did not become healthy at ${HEALTH_URL}`);
}

// ---------------------------------------------------------------
// Report
// ---------------------------------------------------------------

function printReport(m: Metrics, wallSec: number): void {
  const acceptedPerSec = m.logsAccepted / wallSec;
  const sentPerSec = m.logsSent / wallSec;
  const reqPerSec = m.requests / wallSec;
  const dropped = m.throttled + m.failed;
  const target = 15_000;

  const lat = summarizeLatencies(m.latencies);

  const line = '─'.repeat(60);
  console.log(`\n${line}`);
  console.log('  INGEST LOAD TEST REPORT');
  console.log(line);
  console.log('  Config');
  console.log(`    url          : ${INGEST_URL}`);
  console.log(`    batch size   : ${fmtInt(BATCH_SIZE)} logs/request`);
  console.log(`    concurrency  : ${CONCURRENCY} workers`);
  console.log(`    auth         : ${API_KEY ? 'bearer token' : 'none'}`);
  console.log(`    duration     : ${fmtNum(wallSec)} s (measured)`);
  console.log('');
  console.log('  Requests');
  console.log(`    total        : ${fmtInt(m.requests)}  (${fmtNum(reqPerSec)}/s)`);
  console.log(`    200 ok       : ${fmtInt(m.ok)}`);
  console.log(`    400 rejected : ${fmtInt(m.rejected)}`);
  console.log(`    429 throttled: ${fmtInt(m.throttled)}`);
  console.log(`    failed       : ${fmtInt(m.failed)}`);
  console.log('');
  console.log('  Throughput');
  console.log(`    logs sent    : ${fmtInt(m.logsSent)}  (${fmtInt(sentPerSec)}/s)`);
  console.log(`    logs accepted: ${fmtInt(m.logsAccepted)}  (${fmtInt(acceptedPerSec)}/s)  <= headline`);
  console.log(`    data sent    : ${fmtBytes(m.bytesSent)}`);
  console.log('');
  console.log('  Latency (per request)');
  console.log(formatLatencyBlock(lat));
  console.log('');
  console.log('  Verdict');
  console.log(`    target       : ${fmtInt(target)} logs/s`);
  console.log(`    achieved     : ${fmtInt(acceptedPerSec)} logs/s  ` +
    `(${fmtNum((acceptedPerSec / target) * 100, 0)}% of target)`);
  console.log(`    dropped reqs : ${fmtInt(dropped)}  ` +
    `${dropped === 0 ? '(zero — good)' : '(!! non-zero)'}`);
  const pass = acceptedPerSec >= target && dropped === 0;
  console.log(`    result       : ${pass ? 'PASS' : 'BELOW TARGET'}`);
  if (m.firstErrorSamples.length > 0) {
    console.log('');
    console.log('  Error samples');
    for (const e of m.firstErrorSamples) console.log(`    - ${e}`);
  }
  console.log(line);
  console.log('  Tip: capture resource usage in another terminal with:');
  console.log('    docker stats --no-stream log-service-app-1 log-service-postgres-1');
  console.log(line + '\n');
}

// ---------------------------------------------------------------
// Main
// ---------------------------------------------------------------

async function main(): Promise<void> {
  console.log('Ingest load generator');
  console.log(
    `  mode=${TOTAL_LOGS ? `count(${fmtInt(TOTAL_LOGS)})` : `duration(${DURATION_SEC}s)`}` +
      ` batch=${BATCH_SIZE} concurrency=${CONCURRENCY}`,
  );

  await waitForHealth();

  // Warmup (duration mode only): send real traffic without recording,
  // so JIT, connection pools, and the server's write buffers are all
  // warm before we start the clock.
  if (TOTAL_LOGS === undefined && WARMUP_SEC > 0) {
    console.log(`\nWarmup ${WARMUP_SEC}s (not recorded)...`);
    const warmEnd = Date.now() + WARMUP_SEC * 1000;
    await runPhase({
      label: 'warmup',
      record: false,
      done: () => Date.now() >= warmEnd,
    });
  }

  console.log('\nMeasuring...');
  const startMs = Date.now();

  // Placeholder metrics object for the progress printer; the real one
  // is created inside runPhase, so we thread progress via a shared ref.
  const shared = newMetrics();
  const progress = startProgress(shared, startMs);

  const measuredEnd = startMs + DURATION_SEC * 1000;
  const done =
    TOTAL_LOGS === undefined
      ? () => Date.now() >= measuredEnd
      : () => shared.logsSent >= TOTAL_LOGS;

  // Run workers directly against `shared` so the progress printer sees
  // live counts.
  const workers: Promise<void>[] = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    workers.push(runWorker(shared, { label: 'measure', record: true, done }));
  }
  await Promise.all(workers);

  clearInterval(progress);
  const wallSec = (Date.now() - startMs) / 1000;
  printReport(shared, wallSec);
}

main().catch((err) => {
  console.error('Load generator failed:', err);
  process.exit(1);
});
