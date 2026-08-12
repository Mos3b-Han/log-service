
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from '../../config.js';


const validKeys = new Set<string>();


const EXEMPT_PATHS = new Set<string>(['/health']);

const BEARER_RE = /^Bearer\s+(.+)$/i;


function extractKey(request: FastifyRequest): string | null {
  // Primary: Authorization: Bearer <key>. Must always work.
  const auth = request.headers['authorization'];
  if (typeof auth === 'string') {
    const match = BEARER_RE.exec(auth.trim());
    if (match) {
      const token = match[1]!.trim();
      if (token.length > 0) return token;
    }
  }

  // Secondary: X-API-Key: <key>.
  const apiKey = request.headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey.trim().length > 0) {
    return apiKey.trim();
  }

  return null;
}


export function registerAuth(app: FastifyInstance): void {
  if (!config.auth.enabled) {
    
    return;
  }


  if (config.auth.loadgenApiKey !== undefined) {
    validKeys.add(config.auth.loadgenApiKey);
  }
  // Log the count only -- never the secret itself.
  console.log(`Auth enabled; seeded ${validKeys.size} API key(s).`);

  app.addHook('onRequest', async (request, reply) => {
    // /health is always unauthenticated.
    const path = request.url.split('?', 1)[0]!;
    if (EXEMPT_PATHS.has(path)) return;

    const key = extractKey(request);
    if (key === null) {
      reply
        .code(401)
        .header('WWW-Authenticate', 'Bearer')
        .send({ error: 'missing or malformed credential' });
      return reply;
    }
    if (!validKeys.has(key)) {
      reply
        .code(401)
        .header('WWW-Authenticate', 'Bearer')
        .send({ error: 'invalid credential' });
      return reply;
    }

    return;
  });
}
