// src/shutdown.ts
//
// Graceful shutdown on SIGTERM / SIGINT. The ordering here is what lets
// the service honor "never lose an accepted batch" (spec §7) even while
// stopping:
//
//   1. Report unhealthy so any load balancer stops routing new traffic.
//   2. Stop the background partition-maintenance timer.
//   3. Close the HTTP server: stop accepting new connections and wait
//      for in-flight requests to finish. An in-flight POST /logs is
//      awaiting its write() promise, which resolves only once the COPY
//      commits -- so this step transitively waits for those durable
//      writes.
//   4. Stop the writer: a final flush of anything still buffered, then
//      mark it closed so any late write() rejects instead of vanishing.
//   5. Close the Postgres pool.
//
// Steps 3 and 4 must be in this order: closing the writer first would
// make the in-flight requests that step 3 is waiting on reject with
// WriterClosedError and return 500. The writer is closed only after the
// HTTP layer has drained.
//
// A guard timer forces exit if the sequence hangs, so shutdown always
// terminates within the container's stop grace period.

import { server } from './http/server.js';
import { pool } from './db/pool.js';
import { stop as stopWriter } from './db/writer.js';
import { stopPartitionMaintenance } from './db/retention.js';
import { setShuttingDown } from './readiness.js';

// Shorter than Docker's default 10s stop grace, so our own forced exit
// wins the race against SIGKILL and we still log a clean-ish outcome.
const SHUTDOWN_TIMEOUT_MS = 8_000;

let shuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  // A second signal during shutdown is ignored -- the sequence is
  // already running.
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`Received ${signal}, shutting down gracefully...`);

  // If any step hangs (e.g. a stuck connection), do not wait forever.
  // Unref'd so it is not itself a reason to stay alive.
  const guard = setTimeout(() => {
    console.error(
      `Shutdown exceeded ${SHUTDOWN_TIMEOUT_MS}ms; forcing exit.`,
    );
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  guard.unref();

  try {
    // 1. Fail readiness so /health returns 503 and new traffic drains
    //    away from this instance.
    setShuttingDown();

    // 2. Stop background maintenance.
    stopPartitionMaintenance();

    // 3. Stop accepting new connections; wait for in-flight requests
    //    (and, transitively, their durable writes) to complete.
    await server.close();
    console.log('HTTP server closed.');

    // 4. Final flush of any buffered entries, then close the writer.
    await stopWriter();
    console.log('Writer drained.');

    // 5. Close the database pool.
    await pool.end();
    console.log('Postgres pool closed.');

    clearTimeout(guard);
    console.log('Shutdown complete.');
    process.exit(0);
  } catch (err) {
    console.error('Error during shutdown:', err);
    clearTimeout(guard);
    process.exit(1);
  }
}

/**
 * Register SIGTERM and SIGINT handlers. Call once during boot. Safe to
 * call before the server is listening: closing a not-yet-listening
 * server resolves immediately.
 */
export function registerShutdownHandlers(): void {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void gracefulShutdown(signal);
    });
  }
}
