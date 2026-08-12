
// Run: npx tsx loadgen/ingest.ts

import {
  summarizeLatencies,
  formatLatencyBlock,
  fmtInt,
  fmtNum,
  fmtBytes,
} from './report.js';
import {
  authHeaders,
  baseUrl,
  envInt,
  envStr,
  pick,
  randInt,
  parseJson,
  timedFetch,
  waitForHealth,
} from './util.js';


const URL_BASE = baseUrl();
const BATCH_SIZE = envInt('LOADGEN_BATCH_SIZE', 500);
const CONCURRENCY = envInt('LOADGEN_CONCURRENCY', 16);
const DURATION_SEC = envInt('LOADGEN_DURATION_SEC', 30);
const WARMUP_SEC = envInt('LOADGEN_WARMUP_SEC', 5, 0);
const TOTAL_LOGS = envStr('LOADGEN_TOTAL_LOGS')
  ? envInt('LOADGEN_TOTAL_LOGS', 0)
  : undefined;
const API_KEY = envStr('LOADGEN_API_KEY');
const SPREAD_DAYS = envInt('LOADGEN_SPREAD_DAYS', 0, 0);

const SPREAD_MS = SPREAD_DAYS > 0 ? SPREAD_DAYS * 86_400_000 : 60_000;

const INGEST_URL = `${URL_BASE}/logs`;

const HEADERS: Record<string, string> = {
  'content-type': 'application/json',
  ...authHeaders(),
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

interface WireEntry {
  timestamp: string;
  level: string;
  service: string;
  message: string;
  attributes: Record<string, string | number>;
}

function makeBatchBody(nowMs: number): string {
  const logs: WireEntry[] = new Array(BATCH_SIZE);
  for (let i = 0; i < BATCH_SIZE; i++) {
    logs[i] = {
      timestamp: new Date(nowMs - randInt(SPREAD_MS)).toISOString(),
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


interface Metrics {
  requests: number;
  ok: number; // 200
  rejected: number; // 400
  throttled: number; // 429
  failed: number; // 5xx or network error
  logsSent: number;
  logsAccepted: number;
  bytesSent: number;
  latencies: number[]; 
  networkFailures: number;
  firstErrorSamples: string[];
}

function newMetrics(): Metrics {
  return {
    requests: 0, ok: 0, rejected: 0, throttled: 0, failed: 0,
    logsSent: 0, logsAccepted: 0, bytesSent: 0,
    latencies: [], networkFailures: 0, firstErrorSamples: [],
  };
}


interface PhaseOpts {
  readonly label: string;
  readonly record: boolean;
  readonly done: () => boolean;
}

async function runWorker(m: Metrics, opts: PhaseOpts): Promise<void> {
  while (!opts.done()) {
    const nowMs = Date.now();
    const body = makeBatchBody(nowMs);
    const bytes = Buffer.byteLength(body);

    const res = await timedFetch(INGEST_URL, {
      method: 'POST',
      headers: HEADERS,
      body,
    });

    if (!opts.record) continue;

    m.requests++;
    m.logsSent += BATCH_SIZE;
    m.bytesSent += bytes;

    if (!res.ok) {
      
      m.failed++;
      m.networkFailures++;
      if (m.firstErrorSamples.length < 5) {
        m.firstErrorSamples.push(`network: ${res.error}`);
      }
      continue;
    }

    m.latencies.push(res.elapsedMs);

    if (res.status === 200) {
      m.ok++;
      m.logsAccepted += parseJson<{ accepted?: number }>(res)?.accepted ?? 0;
    } else {
      if (res.status === 429) m.throttled++;
      else if (res.status === 400) m.rejected++;
      else m.failed++;
      if (m.firstErrorSamples.length < 5) {
        m.firstErrorSamples.push(
          `HTTP ${res.status}: ${res.text.slice(0, 120)}`,
        );
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
  console.log(formatLatencyBlock(lat, m.networkFailures));
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


async function main(): Promise<void> {
  console.log('Ingest load generator');
  console.log(
    `  mode=${TOTAL_LOGS ? `count(${fmtInt(TOTAL_LOGS)})` : `duration(${DURATION_SEC}s)`}` +
      ` batch=${BATCH_SIZE} concurrency=${CONCURRENCY}`,
  );

  await waitForHealth(URL_BASE);

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

  const shared = newMetrics();
  const progress = startProgress(shared, startMs);

  const measuredEnd = startMs + DURATION_SEC * 1000;
  const done =
    TOTAL_LOGS === undefined
      ? () => Date.now() >= measuredEnd
      : () => shared.logsSent >= TOTAL_LOGS;

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
