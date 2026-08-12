

import type { FastifyInstance } from 'fastify';
import {
  validateFilters,
  validateLimit,
} from '../../core/validation/validateFilters.js';
import { decodeCursor } from '../../core/pagination/cursor.js';
import { queryLogs } from '../../db/query/list.js';
import { type Cursor } from '../../core/types.js';

export async function registerQueryRoute(
  app: FastifyInstance,
): Promise<void> {
  app.get('/logs', async (request, reply) => {
 
    const query = (request.query ?? {}) as Record<string, unknown>;

    // ---- shared filters: service, level, since, until, attr.*, q ----
    const filters = validateFilters(query);
    if (!filters.ok) {
      reply.code(400).send({ error: filters.reason });
      return;
    }

    const limit = validateLimit(query['limit']);
    if (!limit.ok) {
      reply.code(400).send({ error: limit.reason });
      return;
    }

    let cursor: Cursor | undefined;
    const rawCursor = query['cursor'];
    if (rawCursor !== undefined) {
      const decoded = decodeCursor(rawCursor);
      if (!decoded.ok) {
        reply.code(400).send({ error: decoded.reason });
        return;
      }
      cursor = decoded.value;
    }

    // ---- run the query (db layer owns the SQL) ----
    const result = await queryLogs({
      filters: filters.value,
      limit: limit.value,
      cursor,
    });

  
    reply.code(200).send({
      logs: result.logs,
      next_cursor: result.nextCursor,
    });
  });
}
