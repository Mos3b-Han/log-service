// src/http/routes/aggregate.ts
//
// GET /logs/aggregate -- the time-bucketed aggregation endpoint. Thin,
// like the other data routes: it validates parameters (core layer),
// runs the aggregation (db layer), and returns the buckets. No SQL and
// no bucketing math live here.
//
// Parameters (§7):
//   since     required   ISO 8601, inclusive start
//   until     required   ISO 8601, exclusive end
//   bucket    required   one of 1m, 5m, 1h, 1d
//   group_by  optional   'service' or 'level'
//   + the shared filters (service, level, attr.<key>, q)
//
// since and until are optional on GET /logs but REQUIRED here, so this
// route enforces their presence explicitly after the shared validator
// (which only checks their format and ordering).
//
// Status codes (§7): 200 normal, 400 on any invalid or missing
// parameter, 500 on unexpected failure via the global error handler.
// Error bodies are always { error: "<description>" }. Authorization is
// not inspected, so an unrecognized header is ignored (§3).

import type { FastifyInstance } from 'fastify';
import { validateFilters } from '../../core/validation/validateFilters.js';
import { validateBucket, validateGroupBy } from '../../core/time/buckets.js';
import { queryAggregate } from '../../db/query/aggregate.js';

export async function registerAggregateRoute(
  app: FastifyInstance,
): Promise<void> {
  app.get('/logs/aggregate', async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, unknown>;

    // ---- shared filters: service, level, since, until, attr.*, q ----
    const filters = validateFilters(query);
    if (!filters.ok) {
      reply.code(400).send({ error: filters.reason });
      return;
    }

    // ---- since / until are required for aggregation (§7) ----
    // validateFilters parsed and range-checked them if present; here we
    // require presence. Both-present ordering (until > since) was
    // already enforced by validateFilters.
    if (filters.value.since === undefined) {
      reply.code(400).send({ error: "'since' is required" });
      return;
    }
    if (filters.value.until === undefined) {
      reply.code(400).send({ error: "'until' is required" });
      return;
    }

    // ---- bucket (required): one of 1m, 5m, 1h, 1d ----
    const bucket = validateBucket(query['bucket']);
    if (!bucket.ok) {
      reply.code(400).send({ error: bucket.reason });
      return;
    }

    // ---- group_by (optional): 'service' or 'level' ----
    const groupBy = validateGroupBy(query['group_by']);
    if (!groupBy.ok) {
      reply.code(400).send({ error: groupBy.reason });
      return;
    }

    // ---- run the aggregation (db layer owns the SQL) ----
    const result = await queryAggregate({
      filters: filters.value,
      interval: bucket.value,
      groupBy: groupBy.value,
    });

    reply.code(200).send({ buckets: result.buckets });
  });
}
