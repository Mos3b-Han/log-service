
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

pool.on('error', (err) => {
  console.error('Unexpected error on idle Postgres client:', err);
});


export async function checkConnection(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
  } finally {
    client.release();
  }
}