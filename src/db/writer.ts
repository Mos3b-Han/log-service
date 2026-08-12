
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { from as copyFrom } from 'pg-copy-streams';
import { pool } from './pool.js';
import { config } from '../config.js';
import type { LogEntry } from '../core/types.js';


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


const HARD_CAP_ROWS = config.writer.maxPendingRows;


export function write(entries: readonly LogEntry[]): Promise<void> {
  if (closed) {
    return Promise.reject(new WriterClosedError());
  }
  if (entries.length === 0) {
    return Promise.resolve();
  }
  if (pendingRowCount + entries.length > HARD_CAP_ROWS) {
   
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


export async function flushPending(): Promise<void> {
  triggerFlush();
  // triggerFlush may chain further flushes if writes arrive during
  // the initial one; wait until the queue drains completely.
  while (activeFlush || pending.length > 0) {
    if (activeFlush) await activeFlush;
    else triggerFlush();
  }
}


export async function stop(): Promise<void> {
  closed = true;
  await flushPending();
}


function scheduleFlushTimer(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    triggerFlush();
  }, config.writer.bufferMaxLatencyMs);

  flushTimer.unref();
}

function cancelFlushTimer(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

function triggerFlush(): void {
  
  if (activeFlush !== null) return;
  if (pending.length === 0) return;

  activeFlush = doFlush().finally(() => {
    activeFlush = null;
  
    if (pending.length > 0) triggerFlush();
  });
}

async function doFlush(): Promise<void> {
  
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
   
    for (const batch of snapshot) batch.resolve();
  } catch (err) {
 
    const error = err instanceof Error ? err : new Error(String(err));
    for (const batch of snapshot) batch.reject(error);
  }
}


const COPY_SQL =
  'COPY logs (timestamp, level, service, message, attributes) FROM STDIN';

async function copyRows(rows: readonly LogEntry[]): Promise<void> {
  const client = await pool.connect();
  try {
    const copyStream = client.query(copyFrom(COPY_SQL));
  
    const payload = encodeRows(rows);
    await pipeline(Readable.from([payload]), copyStream);
  } finally {
    client.release();
  }
}


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

  return value
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}
