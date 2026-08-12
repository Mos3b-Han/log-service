

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
