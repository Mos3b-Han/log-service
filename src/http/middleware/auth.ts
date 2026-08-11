// src/http/middleware/auth.ts
//
// Optional API-key authentication. OFF by default: with AUTH_ENABLED
// unset or false, registerAuth installs no hook at all, so the service
// behaves exactly as the unauthenticated core service and any
// Authorization header is ignored (not rejected) -- exactly what the
// load-generator contract requires.
//
// When AUTH_ENABLED=true:
//   - The LOADGEN_API_KEY (if set) is seeded into an in-memory key set
//     at startup, before the service reports healthy. Seeding reads
//     from config (i.e. the environment), so it is idempotent and
//     survives restarts: the same env yields the same key every boot.
//     No admin call, SQL, or manual step is involved.
//   - If LOADGEN_API_KEY is unset, the set stays empty; the service
//     still starts and stays healthy, it just has no valid credential.
//   - GET /health remains unauthenticated (the load generator polls it
//     before it has any credentials).
//   - The three data endpoints require a credential via
//     `Authorization: Bearer <key>` (primary) or `X-API-Key: <key>`
//     (secondary). Missing or malformed -> 401; unknown key -> 401.
//     The single seeded key carries full scope, so 403 never arises.
//
// Auth failures return 401 with { error } and never fall through to
// the route, so they can never become a 200-with-empty-results or a
// 500.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from '../../config.js';

// In-memory set of accepted keys. A Set gives O(1) membership and,
// because lookup hashes the whole candidate string, its timing does
// not correlate with how many leading characters match a real key --
// unlike a naive character-by-character compare. Module-scoped so the
// single seeded key is shared across all requests.
const validKeys = new Set<string>();

// GET /health is always exempt. Compared against the raw path (query
// string stripped) so it does not depend on Fastify internals.
const EXEMPT_PATHS = new Set<string>(['/health']);

const BEARER_RE = /^Bearer\s+(.+)$/i;

/**
 * Extract a credential from the request headers, or null if none is
 * present in an acceptable form. Credentials are only ever read from
 * headers -- never the query string or body (§ Credential Transport).
 */
function extractKey(request: FastifyRequest): string | null {
  // Primary: Authorization: Bearer <key>. Must always work.
  const auth = request.headers['authorization'];
  if (typeof auth === 'string') {
    const match = BEARER_RE.exec(auth.trim());
    if (match) {
      const token = match[1]!.trim();
      if (token.length > 0) return token;
    }
  }

  // Secondary: X-API-Key: <key>.
  const apiKey = request.headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey.trim().length > 0) {
    return apiKey.trim();
  }

  return null;
}

/**
 * Install authentication if enabled. Call once during boot, before the
 * server starts listening, so seeding completes before /health is
 * allowed to report ready.
 */
export function registerAuth(app: FastifyInstance): void {
  if (!config.auth.enabled) {
    // Disabled: register nothing. No hook inspects the Authorization
    // header, so an unrecognized one is ignored -- the zero-config
    // core-service posture.
    return;
  }

  // Idempotent seed from the environment. Re-running at every startup
  // with the same env keeps the key stable across restarts.
  if (config.auth.loadgenApiKey !== undefined) {
    validKeys.add(config.auth.loadgenApiKey);
  }
  // Log the count only -- never the secret itself.
  console.log(`Auth enabled; seeded ${validKeys.size} API key(s).`);

  app.addHook('onRequest', async (request, reply) => {
    // /health is always unauthenticated.
    const path = request.url.split('?', 1)[0]!;
    if (EXEMPT_PATHS.has(path)) return;

    const key = extractKey(request);
    if (key === null) {
      reply
        .code(401)
        .header('WWW-Authenticate', 'Bearer')
        .send({ error: 'missing or malformed credential' });
      return reply;
    }
    if (!validKeys.has(key)) {
      reply
        .code(401)
        .header('WWW-Authenticate', 'Bearer')
        .send({ error: 'invalid credential' });
      return reply;
    }

    // Valid credential with full scope: allow the request to proceed.
    return;
  });
}
