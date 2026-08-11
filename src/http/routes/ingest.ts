// src/http/routes/ingest.ts
//
// POST /logs -- the ingest endpoint.
//
// This handler is deliberately thin. All business logic lives one
// layer below it:
//   - shape + per-entry validation -> core/validation/validateBatch
//   - buffering, COPY, backpressure -> db/writer
// The handler's job is orchestration and status-code selection.
// It contains no SQL, no encoding, no timing logic.
//
// Status-code matrix (from spec §7 and §6):
//
//   400  request shape is malformed (body not an object, logs missing
//        or empty, batch too large) -- from validateBatch
//   400  every entry was rejected (spec §7 "all entries rejected")
//   200  at least one entry accepted AND the write completed durably
//   429  writer buffer at hard cap; Retry-After header set
//   500  everything else (surfaces via the global error handler)
//
// The 200 branch is the only path that reports success to the client.
// It runs only after write() has resolved, which by writer.ts's
// contract means the COPY has committed. This is how §7's "never
// respond 200 to a batch you have not durably accepted" is honored.

import type { FastifyInstance } from 'fastify';
import { validateBatch } from '../../core/validation/validateBatch.js';
import { write, BackpressureError } from '../../db/writer.js';
import { config } from '../../config.js';

export async function registerIngestRoute(
  app: FastifyInstance,
): Promise<void> {
  app.post('/logs', async (request, reply) => {
    // Fastify has already parsed JSON and enforced the body-size
    // limit (config.ingest.bodyLimitBytes). If the body was not
    // valid JSON, Fastify replied 400 before we got here.
    // retentionDays comes from config here, not from inside core: the
    // core layer never reads process.env. It bounds how far into the
    // past a timestamp may be, since only that window has partitions.
    const outcome = validateBatch(
      request.body,
      config.retention.retentionDays,
    );

    // Shape errors: request body is malformed at the envelope level.
    // Route responds 400 with just { error } -- per-entry details do
    // not apply because we never got to the entries.
    if (!outcome.ok) {
      reply.code(400).send({ error: outcome.reason });
      return;
    }

    const { accepted, rejected } = outcome.result;

    // Every entry rejected: 400 per §7. The rejected[] list is
    // included as an additive field so callers can see WHICH entries
    // failed. The primary { error } contract from the spec is met;
    // extras are additive per §6 of the Optional Features rules.
    if (accepted.length === 0) {
      reply.code(400).send({
        error: 'all entries rejected',
        rejected,
      });
      return;
    }

    // The happy path: send accepted entries to the writer and await
    // durable commit. We deliberately await BEFORE sending 200 so
    // the promise never lies about persistence.
    try {
      await write(accepted);
    } catch (err) {
      if (err instanceof BackpressureError) {
        // 429 with Retry-After in seconds (RFC 7231 permits either
        // an HTTP-date or a delta-seconds; seconds is simpler for
        // clients to act on).
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
      // Any other write failure surfaces to the global error handler
      // as a 500. We never turn it into a 200 -- durability was not
      // achieved for the entries the client sent us.
      throw err;
    }

    // Successful durable write. The response shape is verbatim §7:
    //   accepted: <number>   (count, not the entries themselves)
    //   rejected: [{ index, reason }, ...]
    reply.code(200).send({
      accepted: accepted.length,
      rejected,
    });
  });
}
