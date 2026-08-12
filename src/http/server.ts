

import Fastify from 'fastify';
import { config } from '../config.js';

export const server = Fastify({
 
  logger: { level: 'error' },
  bodyLimit: config.ingest.bodyLimitBytes,
});