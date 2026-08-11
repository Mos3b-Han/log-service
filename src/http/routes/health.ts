// src/http/routes/health.ts
//
// The load generator polls this endpoint until it returns 200
// before starting any ingestion. Per the spec, 200 means:
//   - DB connection established
//   - Migrations applied
//   - Service ready to accept logs

import type { FastifyInstance } from 'fastify';
import { isReady } from '../../readiness.js';

export async function registerHealthRoute(app: FastifyInstance): Promise<void> {
  app.get('/health', async (_request, reply) => {
    if (isReady()) {
      reply.code(200).send({ status: 'ok' });
    } else {
      reply.code(503).send({ status: 'starting' });
    }
  });
}