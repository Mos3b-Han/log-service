// src/http/server.ts
//
// Creates and configures the Fastify instance. Does not call
// server.listen() — that responsibility belongs to index.ts,
// which controls the full boot sequence.

import Fastify from 'fastify';
import { config } from '../config.js';

export const server = Fastify({
  logger: false,
  bodyLimit: config.ingest.bodyLimitBytes,
});