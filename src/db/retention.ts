// src/db/retention.ts
//
// Partition lifecycle management, run in the Node.js layer rather than
// PL/pgSQL so it is testable, observable, and stoppable on shutdown
// (CLAUDE.md §4). One maintenance cycle does two things, in this order:
//
//   1. Provisioning -- ensure a daily partition exists for every day in
//      [today, today + PARTITION_LOOKAHEAD_DAYS]. Missing future
//      partitions break ingestion outright (an insert with no target
//      partition fails), so this runs FIRST and its failure is fatal.
//
//   2. Retention -- DROP partitions whose entire range is older than
//      RETENTION_DAYS. DROP is an O(1) metadata operation with no dead
//      tuples, no bloat, and one WAL record -- never DELETE (see
//      DESIGN.md). Delayed retention only means data outlives its
//      policy briefly, so a failure here is logged, not fatal.
//
// Partition metadata is read from the logs_partitions view
// (migrations/004_retention.sql); this file contains the scheduling and
// orchestration the view deliberately omits.

import { pool } from './pool.js';
import { config } from '../config.js';

const DAY_MS = 86_400_000;

// How often the background cycle runs. Daily partitions with a 14-day
// lookahead leave enormous headroom, so hourly is already very
// conservative -- it just means a delayed process still provisions the
// next day's partition long before midnight. Both operations are
// idempotent, so extra runs are cheap and harmless.
const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;

// Every partition this service manages matches this exact shape. Used
// to validate names read back from the catalog before they are
// interpolated into a DROP -- the names are already trusted (they come
// from pg_catalog), but validating guarantees the identifier can hold
// nothing but [a-z0-9_], making the DROP injection-proof by
// construction.
const PARTITION_NAME_RE = /^logs_\d{4}_\d{2}_\d{2}$/;

let timer: NodeJS.Timeout | null = null;

// ---------------------------------------------------------------
// Date helpers (all UTC; partitions are UTC day-aligned)
// ---------------------------------------------------------------

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

// Today's UTC midnight -- the lower bound of the current day's partition.
function todayUtc(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

// logs_YYYY_MM_DD for a given day-start instant.
function partitionName(dayStart: Date): string {
  return (
    `logs_${dayStart.getUTCFullYear()}_` +
    `${pad2(dayStart.getUTCMonth() + 1)}_${pad2(dayStart.getUTCDate())}`
  );
}

// 'YYYY-MM-DD 00:00:00+00' -- a partition bound literal. DDL cannot take
// bind parameters, so bounds are interpolated; every component derives
// from a Date we computed, never from request input.
function boundLiteral(dayStart: Date): string {
  return (
    `${dayStart.getUTCFullYear()}-` +
    `${pad2(dayStart.getUTCMonth() + 1)}-` +
    `${pad2(dayStart.getUTCDate())} 00:00:00+00`
  );
}

// ---------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------

/**
 * Ensure a daily partition exists across the whole storable window:
 * from RETENTION_DAYS in the past through PARTITION_LOOKAHEAD_DAYS in
 * the future. Returns how many were created. New partitions inherit
 * the parent's composite and GIN indexes automatically (a property of
 * CREATE TABLE ... PARTITION OF).
 *
 * Why the window reaches backwards as well as forwards:
 *
 * Log delivery is not ordered or instantaneous. An agent that buffered
 * during a network outage, a batch replayed from a dead-letter queue,
 * or a host with a skewed clock all produce entries timestamped in the
 * past. Those entries pass validation (§8 only bounds the FUTURE, by
 * five minutes), so if no partition covers their day the INSERT fails
 * with "no partition of relation logs found for row" -- surfacing as a
 * 500 that takes the entire batch down with it, including every valid
 * entry alongside it.
 *
 * Provisioning the full retention window closes that gap: any entry we
 * are willing to KEEP (i.e. inside RETENTION_DAYS) now has somewhere to
 * land. Entries older than the window are rejected per-entry by the
 * validator instead, so the batch survives.
 *
 * The backward bound deliberately matches the retention cutoff, so
 * provisioning and retention never fight: the oldest day this creates
 * has an upper bound strictly greater than the drop cutoff, and so is
 * never immediately dropped by the same cycle.
 */
async function provisionPartitions(): Promise<number> {
  const lookahead = config.retention.partitionLookaheadDays;
  const retentionDays = config.retention.retentionDays;
  const today = todayUtc();

  // Names that already exist, so we only issue CREATE for real gaps and
  // can report an accurate count.
  const existingResult = await pool.query<{ partition_name: string }>(
    'SELECT partition_name FROM logs_partitions',
  );
  const existing = new Set(existingResult.rows.map((r) => r.partition_name));

  let created = 0;
  for (let i = -retentionDays; i <= lookahead; i++) {
    const dayStart = new Date(today.getTime() + i * DAY_MS);
    const name = partitionName(dayStart);
    if (existing.has(name)) continue;

    const dayEnd = new Date(dayStart.getTime() + DAY_MS);
    // IF NOT EXISTS guards against a race with a concurrent run; the
    // name and bounds are entirely derived from the current date.
    const sql =
      `CREATE TABLE IF NOT EXISTS "${name}" PARTITION OF logs ` +
      `FOR VALUES FROM ('${boundLiteral(dayStart)}') ` +
      `TO ('${boundLiteral(dayEnd)}')`;
    await pool.query(sql);
    created++;
  }

  return created;
}

// ---------------------------------------------------------------
// Retention
// ---------------------------------------------------------------

/**
 * Drop every partition whose upper bound is at or before the retention
 * cutoff (today - RETENTION_DAYS), i.e. whose entire range is older
 * than the policy. Returns how many were dropped.
 */
async function dropExpiredPartitions(): Promise<number> {
  const retentionDays = config.retention.retentionDays;
  const cutoff = new Date(todayUtc().getTime() - retentionDays * DAY_MS);

  // The cutoff is a bound parameter; this is a plain SELECT.
  const expired = await pool.query<{ partition_name: string }>(
    'SELECT partition_name FROM logs_partitions ' +
      'WHERE upper_bound <= $1 ORDER BY upper_bound',
    [cutoff],
  );

  let dropped = 0;
  for (const row of expired.rows) {
    const name = row.partition_name;
    if (!PARTITION_NAME_RE.test(name)) {
      // A table under the parent that we did not create -- never drop
      // something outside our naming contract.
      console.warn(
        `Retention: skipping unexpected partition name '${name}'`,
      );
      continue;
    }
    await pool.query(`DROP TABLE IF EXISTS "${name}"`);
    dropped++;
  }

  return dropped;
}

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------

/**
 * Run one maintenance cycle: provision first (fatal on failure), then
 * retention (best-effort). Awaited at startup before the service
 * reports ready, and invoked periodically by the scheduler.
 */
export async function runPartitionMaintenance(): Promise<void> {
  // Provisioning failure propagates: without partitions, ingestion
  // cannot proceed, so the caller (startup) should treat it as fatal.
  const created = await provisionPartitions();

  // Retention failure is non-fatal -- log and carry on. Provisioning
  // has already succeeded, so ingestion is safe regardless.
  let dropped = 0;
  try {
    dropped = await dropExpiredPartitions();
  } catch (err) {
    console.error('Partition retention failed (non-fatal):', err);
  }

  if (created > 0 || dropped > 0) {
    console.log(
      `Partition maintenance: +${created} provisioned, -${dropped} dropped.`,
    );
  }
}

/**
 * Start the periodic maintenance cycle. Idempotent: a second call while
 * already running is a no-op. The timer is unref'd so it never keeps
 * the process alive on its own.
 */
export function startPartitionMaintenance(): void {
  if (timer !== null) return;
  timer = setInterval(() => {
    runPartitionMaintenance().catch((err) => {
      console.error('Scheduled partition maintenance failed:', err);
    });
  }, MAINTENANCE_INTERVAL_MS);
  timer.unref();
}

/**
 * Stop the periodic maintenance cycle. Called during graceful shutdown.
 */
export function stopPartitionMaintenance(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}
