// tests/helpers/client.ts
//
// HTTP helper for the integration and contract suites.
//
// Both suites drive the service the same way the grader's load
// generator does: as an external HTTP client against a running
// instance, with no privileged access and no in-process shortcuts.
// That is deliberate -- an in-process harness would bypass the
// Dockerfile, the compose wiring, the real Postgres connection, and the
// COPY path, which are precisely the parts most likely to break.
//
// It also happens to be the only option available: Postgres is not
// published to the host (see docker-compose.yml), so there is no way to
// stand the app up from a test process anyway.
//
// Requires a running stack:  docker compose up -d --wait

const BASE_URL = (process.env['TEST_BASE_URL'] ?? 'http://localhost:8080').replace(
  /\/$/,
  '',
);
const API_KEY = process.env['TEST_API_KEY'];

const AUTH_HEADERS: Record<string, string> = API_KEY
  ? { authorization: `Bearer ${API_KEY}` }
  : {};

export interface HttpResult<T = unknown> {
  readonly status: number;
  readonly body: T;
  readonly headers: Headers;
  /** Raw text, for assertions about malformed or non-JSON responses. */
  readonly text: string;
}

async function toResult<T>(res: Response): Promise<HttpResult<T>> {
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: res.status, body: body as T, headers: res.headers, text };
}

/** GET a path, e.g. `/logs?service=x`. Auth applied when configured. */
export async function get<T = unknown>(path: string): Promise<HttpResult<T>> {
  const res = await fetch(`${BASE_URL}${path}`, { headers: AUTH_HEADERS });
  return toResult<T>(res);
}

/** POST a JSON-serializable body. */
export async function postJson<T = unknown>(
  path: string,
  body: unknown,
): Promise<HttpResult<T>> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
    body: JSON.stringify(body),
  });
  return toResult<T>(res);
}

/** POST a raw string body, for malformed-JSON cases. */
export async function postRaw<T = unknown>(
  path: string,
  raw: string,
): Promise<HttpResult<T>> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...AUTH_HEADERS },
    body: raw,
  });
  return toResult<T>(res);
}

/** GET without credentials, to assert the auth gate itself. */
export async function getUnauthenticated<T = unknown>(
  path: string,
): Promise<HttpResult<T>> {
  const res = await fetch(`${BASE_URL}${path}`);
  return toResult<T>(res);
}

/**
 * Block until /health returns 200, or fail with actionable guidance.
 * Called once per suite so a stopped stack produces one clear message
 * instead of dozens of confusing connection errors.
 */
export async function waitForHealthy(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no response';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.status === 200) {
        await res.text();
        return;
      }
      lastError = `HTTP ${res.status}`;
      await res.text();
    } catch (err) {
      lastError = (err as Error).message;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `Service at ${BASE_URL} never became healthy (${lastError}).\n` +
      'These suites need a running stack:\n' +
      '  docker compose up -d --build --wait',
  );
}

/**
 * A service name unique to one test.
 *
 * Every suite writes into the same live database, which may already
 * hold millions of rows from load testing. Tagging each test's data
 * with its own service name is what makes assertions like "exactly
 * three rows come back" true regardless of what else is in there, and
 * lets the suites be re-run without cleanup.
 */
export function uniqueService(label: string): string {
  return `test-${label}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** An ISO timestamp `secondsAgo` in the past -- always valid to ingest. */
export function isoAgo(secondsAgo: number): string {
  return new Date(Date.now() - secondsAgo * 1000).toISOString();
}

export { BASE_URL, API_KEY };
