// src/db/pool.ts
//
// The single shared Postgres connection pool for this application.
// Every module that needs to talk to the database imports `pool`
// from here — never constructs its own `new Pool()`.
//
// Why a shared singleton matters: Postgres runs on 1 CPU / 1GB here.
// If every module created its own pool, the true connection count
// would be (number of pools × maxConnections each), silently
// exceeding what the database can handle. One pool, one limit.

import { Pool } from 'pg';
import { config } from '../config.js';

export const pool = new Pool({
  host: config.postgres.host,
  port: config.postgres.port,
  user: config.postgres.user,
  password: config.postgres.password,
  database: config.postgres.database,
  max: config.postgres.maxConnections,
});

// `pg` requires an `error` listener on idle-client errors, or Node
// will crash the whole process with an unhandled exception. This is
// documented `pg` behavior, not defensive paranoia.
pool.on('error', (err) => {
  console.error('Unexpected error on idle Postgres client:', err);
});

/**
 * Verifies the pool can actually reach Postgres. Used by the
 * readiness check at startup — never called on the hot path.
 */
export async function checkConnection(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
  } finally {
    client.release();
  }
}