// loadgen/report.ts
//
// Shared statistics and formatting for the load generators. Kept free
// of any HTTP or scenario logic so ingest.ts, query.ts, aggregate.ts,
// and mixed.ts all report numbers the same way. Pure functions only.
//
// These tools produce the measured numbers that go into PERFORMANCE.md,
// so the percentile math is deliberately simple and inspectable: sort
// the samples, index by rank. No sketches or approximations -- request
// counts here are small enough (thousands to low millions) to hold and
// sort exactly.

export interface LatencySummary {
  readonly count: number;
  readonly min: number;
  readonly mean: number;
  readonly p50: number;
  readonly p90: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

/**
 * Nearest-rank percentile on an ascending-sorted array. `p` is 0..100.
 * Returns NaN for an empty array.
 */
export function percentile(sortedAsc: readonly number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return NaN;
  const rank = Math.ceil((p / 100) * n);
  const idx = Math.min(n - 1, Math.max(0, rank - 1));
  return sortedAsc[idx]!;
}

/**
 * Summarize a set of latency samples (milliseconds). Copies and sorts
 * the input, so the caller's array is left untouched.
 */
export function summarizeLatencies(samplesMs: readonly number[]): LatencySummary {
  const n = samplesMs.length;
  if (n === 0) {
    return {
      count: 0,
      min: NaN,
      mean: NaN,
      p50: NaN,
      p90: NaN,
      p95: NaN,
      p99: NaN,
      max: NaN,
    };
  }
  const sorted = [...samplesMs].sort((a, b) => a - b);
  let sum = 0;
  for (const v of sorted) sum += v;
  return {
    count: n,
    min: sorted[0]!,
    mean: sum / n,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[n - 1]!,
  };
}

// ---------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------

/** Integer with thousands separators, e.g. 1234567 -> "1,234,567". */
export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** Fixed-decimal number, default 2 places. */
export function fmtNum(n: number, decimals = 2): string {
  if (!Number.isFinite(n)) return 'n/a';
  return n.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Milliseconds with a unit, e.g. "12.34 ms". */
export function fmtMs(n: number): string {
  return Number.isFinite(n) ? `${fmtNum(n)} ms` : 'n/a';
}

/** Human byte size, e.g. 1536 -> "1.50 KB". */
export function fmtBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${fmtNum(v)} ${units[u]}`;
}

/**
 * Render a latency summary as aligned lines for the final report.
 *
 * `excluded` is the number of requests that produced no latency sample
 * because they failed at the network level, before a response arrived.
 * Folding those into the distribution would flatter it -- a refused
 * connection returns in a fraction of a millisecond -- but dropping
 * them silently is worse: the percentiles would then describe only the
 * requests that survived, which is exactly the wrong bias when a server
 * is collapsing. When any were excluded the count is printed alongside
 * the samples, so the reader can never mistake a survivors-only
 * distribution for the whole picture.
 */
export function formatLatencyBlock(s: LatencySummary, excluded = 0): string {
  const samples =
    excluded > 0
      ? `  samples : ${fmtInt(s.count)}  (${fmtInt(excluded)} excluded: network failures)`
      : `  samples : ${fmtInt(s.count)}`;
  return [
    samples,
    `  min     : ${fmtMs(s.min)}`,
    `  mean    : ${fmtMs(s.mean)}`,
    `  p50     : ${fmtMs(s.p50)}`,
    `  p90     : ${fmtMs(s.p90)}`,
    `  p95     : ${fmtMs(s.p95)}`,
    `  p99     : ${fmtMs(s.p99)}`,
    `  max     : ${fmtMs(s.max)}`,
  ].join('\n');
}
