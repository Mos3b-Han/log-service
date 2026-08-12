

import { server } from './http/server.js';
import { pool } from './db/pool.js';
import { stop as stopWriter } from './db/writer.js';
import { stopPartitionMaintenance } from './db/retention.js';
import { setShuttingDown } from './readiness.js';


const SHUTDOWN_TIMEOUT_MS = 8_000;

let shuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {

  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`Received ${signal}, shutting down gracefully...`);

 
  const guard = setTimeout(() => {
    console.error(
      `Shutdown exceeded ${SHUTDOWN_TIMEOUT_MS}ms; forcing exit.`,
    );
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  guard.unref();

  try {
    
    setShuttingDown();

    stopPartitionMaintenance();

    
    await server.close();
    console.log('HTTP server closed.');

    await stopWriter();
    console.log('Writer drained.');

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


export function registerShutdownHandlers(): void {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void gracefulShutdown(signal);
    });
  }
}
