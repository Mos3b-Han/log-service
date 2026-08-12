
import type { FastifyInstance } from 'fastify';

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const statusCode = error.statusCode ?? 500;

   
    if (statusCode >= 500) {
      request.log.error({ err: error }, 'unhandled server error');
      reply.code(statusCode).send({ error: 'Internal server error' });
      return;
    }

    reply.code(statusCode).send({ error: error.message });
  });
}