// src/index.ts
//
// Application entry point. Boot sequence:
//   1. Verify the config module loads without throwing (fail fast on
//      malformed environment variables).
//   2. Verify Postgres is actually reachable.
//   3. Start the HTTP server listening on all interfaces.
//
// This is an intentionally minimal first version -- just enough to
// prove the full chain works end to end (config -> pool -> Postgres
// -> Fastify -> a real HTTP response). The `/health` route here will
// be replaced by a fuller readiness check (DB + migrations applied)
// in a later session.

import Fastify from 'fastify';
import { config } from './config.js';
import { checkConnection } from './db/pool.js';

async function main() {
  console.log('Starting log-service...');

  console.log('Checking Postgres connection...');
  await checkConnection();
  console.log('Postgres connection OK.');

  const server = Fastify({ logger: false });

  server.get('/health', async (_request, reply) => {
    reply.code(200).send({ status: 'ok' });
  });

  await server.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`log-service listening on port ${config.port}`);
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});