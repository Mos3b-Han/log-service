// src/http/errorHandler.ts
//
// Ensures every error response matches the spec's required shape:
//   { "error": "<description>" }
//
// Without this, Fastify returns its own default error format
// ({ statusCode, error, message }) which does not match the spec
// and would cause the load generator to see unexpected responses.

import type { FastifyInstance } from 'fastify';

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const statusCode = error.statusCode ?? 500;

    // Client-facing errors (4xx) carry a message we deliberately wrote
    // for the client -- validation reasons, bad cursors, wrong levels.
    // Server-facing errors (5xx) may contain raw exception text: pg
    // driver messages leaking DB credentials, stack fragments, internal
    // paths. Never forward those to the wire; log them and return a
    // generic string.
    if (statusCode >= 500) {
      request.log.error({ err: error }, 'unhandled server error');
      reply.code(statusCode).send({ error: 'Internal server error' });
      return;
    }

    reply.code(statusCode).send({ error: error.message });
  });
}