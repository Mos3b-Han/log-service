// src/http/routes/query.ts
//
// GET /logs -- the query endpoint. Like the ingest route, this handler
// is deliberately thin: it validates parameters (core layer), runs the
// query (db layer), and shapes the response. It contains no SQL and no
// pagination math of its own.
//
// Status codes (§7):
//   200  normal response, possibly an empty logs array
//   400  any invalid parameter: bad timestamp, until <= since, invalid
//        level, non-numeric or out-of-range limit, or a bad cursor
//   500  unexpected failure (surfaces via the global error handler)
//
// Error bodies are always { error: "<description>" }, matching §7.
//
// Authorization is intentionally not inspected here. Per §3, when auth
// is disabled the service must ignore an unrecognized Authorization
// header rather than reject it; ignoring it is exactly what a handler
// that never reads it does. Real auth arrives later as opt-in
// middleware.

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
    // Fastify parses the query string into an object whose values are
    // string (single) or string[] (repeated). The core validators
    // handle both shapes and reject ambiguous duplicates.
    const query = (request.query ?? {}) as Record<string, unknown>;

    // ---- shared filters: service, level, since, until, attr.*, q ----
    const filters = validateFilters(query);
    if (!filters.ok) {
      reply.code(400).send({ error: filters.reason });
      return;
    }

    // ---- limit: default 100, integer in [1, 1000] ----
    const limit = validateLimit(query['limit']);
    if (!limit.ok) {
      reply.code(400).send({ error: limit.reason });
      return;
    }

    // ---- cursor: absent means first page; present must decode ----
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

    // Response shape is verbatim §7: `next_cursor` is snake_case and is
    // null when there are no further pages.
    reply.code(200).send({
      logs: result.logs,
      next_cursor: result.nextCursor,
    });
  });
}
