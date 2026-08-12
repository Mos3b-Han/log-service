// src/http/server.ts
//
// Creates and configures the Fastify instance. Does not call
// server.listen() — that responsibility belongs to index.ts,
// which controls the full boot sequence.

import Fastify from 'fastify';
import { config } from '../config.js';

export const server = Fastify({
  // Error-level only. Fastify's default logger emits a line per request,
  // which is deliberately avoided on the ingest hot path at 15k logs/sec.
  // Raising the level to 'error' keeps that path silent while still
  // recording 5xx failures -- errorHandler.ts deliberately replaces the
  // client-facing message with a generic string, so without a live
  // logger the real cause would be lost entirely and a production 500
  // would be undiagnosable.
  logger: { level: 'error' },
  bodyLimit: config.ingest.bodyLimitBytes,
});