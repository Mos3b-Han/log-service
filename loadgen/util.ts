// loadgen/util.ts
//
// Shared plumbing for the load generators.
//
// These helpers existed as byte-identical copies in ingest.ts,
// aggregate.ts, query.ts, and mixed.ts. That is not a hypothetical
// maintenance concern: `waitForHealth` had ALREADY drifted -- the copy
// in ingest.ts used an inline promise while the other three used the
// shared sleep -- and the divergence went unnoticed precisely because
// nothing forces four copies to stay equal.
//
// The important member here is `timedFetch`. Every generator needs the
// same three things from a request (how long it took, what came back,
// and whether it failed at the network level), and each one previously
// hand-rolled that with a try/catch. The result was a subtle
// inconsistency in what got measured -- see the note on `elapsedMs`
// below -- which is exactly the class of bug that one code path
// prevents and four cannot.

// ---------------------------------------------------------------
// Environment configuration
// ---------------------------------------------------------------

/**
 * Integer from the environment, or the default when unset.
 *
 * `min` defaults to 1 because most settings here (batch size,
 * concurrency, duration) are meaningless at zero. A few are not:
 * LOADGEN_WARMUP_SEC=0 means "skip the warmup" and
 * LOADGEN_SPREAD_DAYS=0 means "live-stream shape", both legitimate
 * requests that the original one-size-fits-all bound rejected with a
 * confusing "Invalid" error. Making the bound explicit at each call
 * site keeps the check while letting the exceptions say so.
 */
export function envInt(name: string, dflt: number, min = 1): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return dflt;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < min) {
    throw new Error(`Invalid ${name}: '${raw}' (must be an integer >= ${min})`);
  }
  return n;
}

/** Positive number (may be fractional) from the environment. */
export function envNum(name: string, dflt: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return dflt;
  const n = Number.parseFloat(raw);
  if (Number.isNaN(n) || n <= 0) throw new Error(`Invalid ${name}: '${raw}'`);
  return n;
}

/** Optional string from the environment; empty is treated as unset. */
export function envStr(name: string): string | undefined {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? undefined : raw;
}

/** Base URL with any trailing slash removed. */
export function baseUrl(dflt = 'http://localhost:8080'): string {
  return (process.env['LOADGEN_URL'] ?? dflt).replace(/\/$/, '');
}

/** Bearer headers when LOADGEN_API_KEY is set, otherwise empty. */
export function authHeaders(): Record<string, string> {
  const key = envStr('LOADGEN_API_KEY');
  return key ? { authorization: `Bearer ${key}` } : {};
}

// ---------------------------------------------------------------
// Timing
// ---------------------------------------------------------------

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface TimedResult {
  /** True when a response was received, whatever its status code. */
  readonly ok: boolean;
  /** HTTP status, or 0 when the request never completed. */
  readonly status: number;
  readonly elapsedMs: number;
  /** Response body as text; empty string on a network failure. */
  readonly text: string;
  /** Present only when the request failed before a response arrived. */
  readonly error?: string;
}

/**
 * Perform one timed request. Never throws.
 *
 * On `elapsedMs`: the clock stops when the response headers arrive, not
 * when the body finishes downloading — `fetch` resolves at headers.
 * That is the same point every generator measured before this helper
 * existed, so figures stay comparable across the refactor. It does mean
 * large payloads are understated slightly; the body is drained
 * immediately afterwards regardless, which is required to release the
 * socket for keep-alive reuse.
 *
 * A network-level failure still reports `elapsedMs` (time until the
 * failure), but callers should think carefully before folding that into
 * a latency distribution: a refused connection returns in a fraction of
 * a millisecond and would make percentiles look better, not worse.
 * `TimedResult` keeps the two cases distinguishable so the decision is
 * explicit rather than accidental.
 */
export async function timedFetch(
  url: string,
  init?: RequestInit,
): Promise<TimedResult> {
  const t0 = performance.now();
  try {
    const res = await fetch(url, init);
    const elapsedMs = performance.now() - t0;
    const text = await res.text();
    return { ok: true, status: res.status, elapsedMs, text };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      elapsedMs: performance.now() - t0,
      text: '',
      error: (err as Error).message,
    };
  }
}

/** Parse a TimedResult body, or undefined when it is not JSON. */
export function parseJson<T>(result: TimedResult): T | undefined {
  try {
    return JSON.parse(result.text) as T;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------
// Health gate
// ---------------------------------------------------------------

/**
 * Block until GET /health returns 200, so a stopped stack produces one
 * clear message instead of a flood of connection errors mid-run.
 */
export async function waitForHealth(
  base: string,
  timeoutMs = 30_000,
): Promise<void> {
  const url = `${base}/health`;
  const deadline = Date.now() + timeoutMs;
  process.stdout.write(`Waiting for ${url} ... `);
  while (Date.now() < deadline) {
    const res = await timedFetch(url);
    if (res.ok && res.status === 200) {
      process.stdout.write('ready.\n');
      return;
    }
    await sleep(500);
  }
  throw new Error(
    `Service did not become healthy at ${url}.\n` +
      'Start the stack first:  docker compose up -d --build --wait',
  );
}

// ---------------------------------------------------------------
// Synthetic data
// ---------------------------------------------------------------

export function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

/**
 * Uniform integer in [0, maxExclusive).
 *
 * Math.floor, never `| 0`: the bitwise form coerces through ToInt32 and
 * wraps anything above 2^31-1 to a negative number. That silently broke
 * a 30-day timestamp spread (2,592,000,000 ms), producing future
 * timestamps that the service correctly rejected — measured at 17.1% of
 * a workload before the cause was found.
 */
export function randInt(maxExclusive: number): number {
  return Math.floor(Math.random() * maxExclusive);
}
