// src/db/writer.ts
//
// The write path. Accepts validated LogEntry batches from the ingest
// route, coalesces them into micro-batches, and writes them to
// Postgres via the COPY protocol. This file decides whether the
// 15,000 logs/sec target is reachable, so every design choice here
// is deliberate and worth defending.
//
// ---- The contract ----
//
// §7 of the spec:  "Never respond 200 to a batch you have not
// durably accepted."
//
// §10 of CLAUDE.md: "Buffer flushes on size (500 rows) or time
// (200ms). Buffer full -> return 429 with Retry-After."
//
// These two rules pull in opposite directions. If we buffer to batch
// COPYs together (fast) but return 200 before the flush completes,
// a crash between the two events drops accepted data. If we run one
// COPY per HTTP batch (safe), throughput collapses under the 500 rps
// of small batches typical of a log fan-in.
//
// The resolution: micro-batching with per-caller promise. Each write()
// enqueues its entries and receives a Promise that resolves ONLY when
// the COPY containing those specific entries has committed. The route
// awaits this promise before responding 200. Multiple concurrent HTTP
// batches merge into one COPY, but each caller is honest about
// durability.
//
// ---- Backpressure ----
//
// BUFFER_MAX_ROWS  (config: 500) triggers a flush.
// BUFFER_HARD_CAP  (10x MAX)      rejects new writes with 429.
//
// The gap between the two lets the flusher catch up. If we set them
// equal, a single burst above the flush size would immediately bounce
// with 429 instead of being absorbed and drained.
//
// ---- Serial flushes ----
//
// Only one flush is in flight at a time. Parallel COPYs to the same
// partition compete for the same relation lock, so parallelism buys
// nothing at moderate scale. A serial pipeline is also easier to
// reason about for shutdown ordering.

import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { from as copyFrom } from 'pg-copy-streams';
import { pool } from './pool.js';
import { config } from '../config.js';
import type { LogEntry } from '../core/types.js';

// -----------------------------------------------------------------
// Errors -- typed so the route can distinguish 429 from 500 without
// string matching.
// -----------------------------------------------------------------

export class BackpressureError extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super('writer buffer at capacity');
    this.name = 'BackpressureError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class WriterClosedError extends Error {
  constructor() {
    super('writer has been closed');
    this.name = 'WriterClosedError';
  }
}

// -----------------------------------------------------------------
// State -- module-scoped singletons. Only this file may mutate them.
// -----------------------------------------------------------------

interface PendingBatch {
  readonly entries: readonly LogEntry[];
  readonly resolve: () => void;
  readonly reject: (err: Error) => void;
}

let pending: PendingBatch[] = [];
let pendingRowCount = 0;
let activeFlush: Promise<void> | null = null;
let flushTimer: NodeJS.Timeout | null = null;
let closed = false;

// Hard cap: 10x the flush trigger. The gap lets a slow Postgres
// absorb bursts without immediately rejecting new writes. If we ever
// see 429s in normal operation, this ratio is the first knob.
const HARD_CAP_ROWS = config.writer.bufferMaxRows * 10;

// -----------------------------------------------------------------
// Public API
// -----------------------------------------------------------------

/**
 * Enqueue a batch of already-validated entries for durable write.
 * Resolves ONLY when the COPY containing these specific entries has
 * committed. Rejects with BackpressureError when the buffer is full,
 * or WriterClosedError when the writer has been stopped.
 *
 * The route is expected to:
 *   try { await write(accepted) } // then respond 200
 *   catch (BackpressureError) { respond 429 with Retry-After }
 *   catch (other)             { respond 500 }
 */
export function write(entries: readonly LogEntry[]): Promise<void> {
  if (closed) {
    return Promise.reject(new WriterClosedError());
  }
  if (entries.length === 0) {
    return Promise.resolve();
  }
  if (pendingRowCount + entries.length > HARD_CAP_ROWS) {
    // Ask the client to back off for one flush cycle. Not longer:
    // buffer status changes fast, and a Retry-After of many seconds
    // just parks capacity we could be using.
    return Promise.reject(
      new BackpressureError(config.writer.bufferMaxLatencyMs),
    );
  }

  return new Promise<void>((resolve, reject) => {
    pending.push({ entries, resolve, reject });
    pendingRowCount += entries.length;

    if (pendingRowCount >= config.writer.bufferMaxRows) {
      // Size trigger: don't wait for the timer.
      triggerFlush();
    } else {
      // Below threshold: arm the timer so a slow trickle still lands
      // within the latency SLO.
      scheduleFlushTimer();
    }
  });
}

/**
 * Flush every currently pending batch and wait until it lands. Used
 * by the shutdown handler and by tests that need synchronous progress.
 * Does NOT close the writer.
 */
export async function flushPending(): Promise<void> {
  triggerFlush();
  // triggerFlush may chain further flushes if writes arrive during
  // the initial one; wait until the queue drains completely.
  while (activeFlush || pending.length > 0) {
    if (activeFlush) await activeFlush;
    else triggerFlush();
  }
}

/**
 * Mark the writer closed and drain what remains. After this resolves,
 * any subsequent write() call rejects with WriterClosedError. Called
 * from the shutdown handler when SIGTERM arrives.
 */
export async function stop(): Promise<void> {
  closed = true;
  await flushPending();
}

// -----------------------------------------------------------------
// Internal -- flush lifecycle
// -----------------------------------------------------------------

function scheduleFlushTimer(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    triggerFlush();
  }, config.writer.bufferMaxLatencyMs);
  // Don't keep the event loop alive just for the flush timer. The
  // process should exit cleanly if nothing else is pending; the
  // shutdown handler is what guarantees a final flush.
  flushTimer.unref();
}

function cancelFlushTimer(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

function triggerFlush(): void {
  // A flush is already in flight -- it will chain another when done
  // if the queue is still non-empty. Never run two in parallel.
  if (activeFlush !== null) return;
  if (pending.length === 0) return;

  activeFlush = doFlush().finally(() => {
    activeFlush = null;
    // If writes arrived DURING the flush, drain them too. Chain
    // continues until the queue is empty.
    if (pending.length > 0) triggerFlush();
  });
}

async function doFlush(): Promise<void> {
  // Take a snapshot atomically: swap the pending queue with a fresh
  // array before any await. Any write() call after this line goes
  // into the new queue and is picked up by the next flush.
  const snapshot = pending;
  pending = [];
  pendingRowCount = 0;
  cancelFlushTimer();

  // Flatten all batches into one row list. flatMap allocates one
  // intermediate array; at 500 rows that's negligible.
  const rows: LogEntry[] = [];
  for (const batch of snapshot) {
    for (const entry of batch.entries) rows.push(entry);
  }

  try {
    await copyRows(rows);
    // Only after the COPY has completed do we honor the promises.
    // This is the point at which the entries are durable in Postgres.
    for (const batch of snapshot) batch.resolve();
  } catch (err) {
    // Any failure fails every promise in the snapshot. We do NOT
    // re-queue -- retrying automatically here would silently produce
    // duplicates. The client's retry is the authoritative decision.
    const error = err instanceof Error ? err : new Error(String(err));
    for (const batch of snapshot) batch.reject(error);
  }
}

// -----------------------------------------------------------------
// Internal -- COPY execution
// -----------------------------------------------------------------

const COPY_SQL =
  'COPY logs (timestamp, level, service, message, attributes) FROM STDIN';

async function copyRows(rows: readonly LogEntry[]): Promise<void> {
  const client = await pool.connect();
  try {
    const copyStream = client.query(copyFrom(COPY_SQL));
    // Materialize the encoded rows as a single string chunk. At 500
    // rows this is a few hundred KB; letting pipeline handle a single
    // chunk is simpler than streaming line by line and equally fast.
    const payload = encodeRows(rows);
    await pipeline(Readable.from([payload]), copyStream);
  } finally {
    client.release();
  }
}

// -----------------------------------------------------------------
// Internal -- COPY text format encoding
// -----------------------------------------------------------------
//
// PostgreSQL COPY text format (docs §14.6.2):
//   - Fields separated by TAB.
//   - Rows separated by LF.
//   - Backslash, TAB, LF, CR inside a field must each be preceded by
//     a backslash: \\, \t, \n, \r.
//   - Backslash MUST be escaped first, otherwise the escapes we add
//     for TAB/LF get double-escaped on the next pass.
//
// Field order matches the COPY statement above: (timestamp, level,
// service, message, attributes). The `id` column is BIGSERIAL and
// is omitted so Postgres assigns it.

function encodeRows(rows: readonly LogEntry[]): string {
  // Build with an array-join rather than repeated string concat to
  // avoid O(n^2) allocation on the intermediate string.
  const lines: string[] = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    lines[i] = encodeRow(rows[i]!);
  }
  return lines.join('');
}

function encodeRow(entry: LogEntry): string {
  return (
    entry.timestamp.toISOString() +
    '\t' +
    entry.level.toString() +
    '\t' +
    escapeCopy(entry.service) +
    '\t' +
    escapeCopy(entry.message) +
    '\t' +
    escapeCopy(JSON.stringify(entry.attributes)) +
    '\n'
  );
}

function escapeCopy(value: string): string {
  // Order matters: escape backslash first so the backslashes we
  // introduce below for TAB/LF/CR don't get themselves escaped on a
  // second pass. Regex .replace with /g is faster than a manual loop
  // in V8 for strings this size.
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}
