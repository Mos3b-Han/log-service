// src/db/migrate.ts
//
// Minimal migration runner. Reads .sql files from the migrations/
// directory in alphabetical order, tracks which have already been
// applied in a `schema_migrations` table, and runs any that are new.
//
// Why hand-rolled instead of Drizzle Kit or another tool:
//   - Our migrations are already tested raw SQL files (001–004).
//   - A custom runner is < 60 lines, fully understandable, and has
//     zero dependencies beyond `pg` (which we already have).
//   - In the interview demo, we can explain every line.

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';

// Resolve migrations/ relative to this file, not the process CWD.
// This file lives at src/db/migrate.ts (compiled to dist/db/migrate.js);
// migrations/ sits at the project root -- two directories up in both
// cases. Using CWD breaks the moment the process is launched from any
// directory other than the project root (CI runners, ad-hoc `node`
// invocations, integration tests running from tests/).
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', '..', 'migrations');

export async function runMigrations(): Promise<void> {
  const client = await pool.connect();

  try {
    // Ensure the tracking table exists. This statement is itself
    // idempotent (IF NOT EXISTS), so the very first run bootstraps
    // the table automatically.
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    // Read which migrations have already been applied.
    const { rows: applied } = await client.query(
      'SELECT filename FROM schema_migrations ORDER BY filename',
    );
    const appliedSet = new Set(applied.map((r) => r.filename));

    // Read all .sql files from the migrations directory, sorted
    // alphabetically (which matches our 001_, 002_, ... naming).
    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      if (appliedSet.has(file)) {
        continue; // Already applied — skip silently.
      }

      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf-8');

      console.log(`Applying migration: ${file}`);

      // Run the migration and record it in a single transaction so
      // that a partial failure leaves no ambiguous state.
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (filename) VALUES ($1)',
          [file],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }

    console.log('All migrations applied.');
  } finally {
    client.release();
  }
}