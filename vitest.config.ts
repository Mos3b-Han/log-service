// vitest.config.ts
//
// Test layout and why the layers are separated:
//
//   tests/unit/        Pure core logic. No database, no HTTP, no
//                      running service. Milliseconds to run, so these
//                      gate every commit.
//   tests/integration/ Real behaviour through the whole stack: HTTP ->
//                      validation -> COPY -> Postgres -> read back.
//   tests/contract/    The API shape exactly as the spec defines it,
//                      independent of behaviour.
//
// The last two drive a RUNNING instance over HTTP rather than importing
// the app in-process. That is deliberate: it exercises the built image,
// the compose wiring, and the real database, which is where most of the
// interesting failure modes live. It is also the only option, since
// Postgres is not published to the host.
//
//   npm run test:unit   -- no prerequisites
//   npm test            -- everything; needs `docker compose up -d --wait`

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Integration and contract suites share one live database and write
    // real rows. They isolate themselves with unique service names
    // rather than by locking, so files may run in parallel safely.
    testTimeout: 30_000,
    hookTimeout: 40_000,
    reporters: 'default',
  },
});
