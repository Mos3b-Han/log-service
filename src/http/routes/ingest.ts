
import type { FastifyInstance } from 'fastify';
import { validateBatch } from '../../core/validation/validateBatch.js';
import { write, BackpressureError } from '../../db/writer.js';
import { config } from '../../config.js';

export async function registerIngestRoute(
  app: FastifyInstance,
): Promise<void> {
  app.post('/logs', async (request, reply) => {
   
    const outcome = validateBatch(
      request.body,
      config.retention.retentionDays,
    );

   
    if (!outcome.ok) {
      reply.code(400).send({ error: outcome.reason });
      return;
    }

    const { accepted, rejected } = outcome.result;

 
    if (accepted.length === 0) {
      reply.code(400).send({
        error: 'all entries rejected',
        rejected,
      });
      return;
    }

    
    try {
      await write(accepted);
    } catch (err) {
      if (err instanceof BackpressureError) {
   
        const retryAfterSec = Math.max(
          1,
          Math.ceil(err.retryAfterMs / 1000),
        );
        reply
          .header('Retry-After', retryAfterSec.toString())
          .code(429)
          .send({ error: 'server busy, retry shortly' });
        return;
      }
   
      throw err;
    }


    reply.code(200).send({
      accepted: accepted.length,
      rejected,
    });
  });
}
