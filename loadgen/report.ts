// loadgen/report.ts


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

export function percentile(sortedAsc: readonly number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return NaN;
  const rank = Math.ceil((p / 100) * n);
  const idx = Math.min(n - 1, Math.max(0, rank - 1));
  return sortedAsc[idx]!;
}

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

export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

export function fmtNum(n: number, decimals = 2): string {
  if (!Number.isFinite(n)) return 'n/a';
  return n.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

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
