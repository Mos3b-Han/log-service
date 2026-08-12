

import { pool } from './pool.js';
import { config } from '../config.js';

const DAY_MS = 86_400_000;


const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;


const PARTITION_NAME_RE = /^logs_\d{4}_\d{2}_\d{2}$/;

let timer: NodeJS.Timeout | null = null;


function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

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

function boundLiteral(dayStart: Date): string {
  return (
    `${dayStart.getUTCFullYear()}-` +
    `${pad2(dayStart.getUTCMonth() + 1)}-` +
    `${pad2(dayStart.getUTCDate())} 00:00:00+00`
  );
}

async function provisionPartitions(): Promise<number> {
  const lookahead = config.retention.partitionLookaheadDays;
  const retentionDays = config.retention.retentionDays;
  const today = todayUtc();

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
    
    const sql =
      `CREATE TABLE IF NOT EXISTS "${name}" PARTITION OF logs ` +
      `FOR VALUES FROM ('${boundLiteral(dayStart)}') ` +
      `TO ('${boundLiteral(dayEnd)}')`;
    await pool.query(sql);
    created++;
  }

  return created;
}


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

export async function runPartitionMaintenance(): Promise<void> {
 
  const created = await provisionPartitions();

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

export function startPartitionMaintenance(): void {
  if (timer !== null) return;
  timer = setInterval(() => {
    runPartitionMaintenance().catch((err) => {
      console.error('Scheduled partition maintenance failed:', err);
    });
  }, MAINTENANCE_INTERVAL_MS);
  timer.unref();
}

export function stopPartitionMaintenance(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}
