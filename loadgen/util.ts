// loadgen/util.ts

export function envInt(name: string, dflt: number, min = 1): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return dflt;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < min) {
    throw new Error(`Invalid ${name}: '${raw}' (must be an integer >= ${min})`);
  }
  return n;
}

export function envNum(name: string, dflt: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return dflt;
  const n = Number.parseFloat(raw);
  if (Number.isNaN(n) || n <= 0) throw new Error(`Invalid ${name}: '${raw}'`);
  return n;
}

export function envStr(name: string): string | undefined {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? undefined : raw;
}

export function baseUrl(dflt = 'http://localhost:8080'): string {
  return (process.env['LOADGEN_URL'] ?? dflt).replace(/\/$/, '');
}

export function authHeaders(): Record<string, string> {
  const key = envStr('LOADGEN_API_KEY');
  return key ? { authorization: `Bearer ${key}` } : {};
}


export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface TimedResult {
  readonly ok: boolean;
  readonly status: number;
  readonly elapsedMs: number;
  readonly text: string;
  readonly error?: string;
}

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

export function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

export function randInt(maxExclusive: number): number {
  return Math.floor(Math.random() * maxExclusive);
}
