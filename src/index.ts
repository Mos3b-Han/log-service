// src/index.ts
//
// Application entry point. Boot sequence:
//   1. Load config (fail fast on malformed env vars).
//   2. Verify Postgres is reachable.
//   3. Run migrations (apply any unapplied .sql files).
//   4. Register HTTP routes and error handler.
//   5. Start listening.
//   6. Mark the service as ready (/health returns 200 from here).

import { config } from './config.js';
import { checkConnection } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { server } from './http/server.js';
import { registerErrorHandler } from './http/errorHandler.js';
import { registerAuth } from './http/middleware/auth.js';
import { registerHealthRoute } from './http/routes/health.js';
import { registerIngestRoute } from './http/routes/ingest.js';
import { registerQueryRoute } from './http/routes/query.js';
import { registerAggregateRoute } from './http/routes/aggregate.js';
import { setReady } from './readiness.js';

async function main() {
  console.log('Starting log-service...');

  // Step 1: config is already loaded at import time. If it threw,
  // we never reach this line — that is intentional (fail fast).

  // Step 2: verify Postgres connectivity before anything else.
  console.log('Checking Postgres connection...');
  await checkConnection();
  console.log('Postgres connection OK.');

  // Step 3: apply any pending migrations.
  await runMigrations();

  // Step 4: wire up HTTP layer. Auth is registered before the routes
  // so its onRequest hook (when enabled) guards every data endpoint;
  // when disabled it installs nothing and /health stays exempt either
  // way. Seeding happens here, before listen, so a valid credential
  // exists the moment the service reports ready.
  registerErrorHandler(server);
  registerAuth(server);
  await registerHealthRoute(server);
  await registerIngestRoute(server);
  await registerQueryRoute(server);
  await registerAggregateRoute(server);

  // Step 5: start listening on all interfaces (required for Docker).
  await server.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`log-service listening on port ${config.port}`);

  // Step 6: only now is the service truly ready.
  setReady();
  console.log('Service is ready.');
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});