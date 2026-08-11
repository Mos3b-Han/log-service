// src/db/query/aggregate.ts
//
// Executor for GET /logs/aggregate. Buckets rows by time with
// date_bin() (PG14+) and counts them, optionally grouped by service or
// level. Reuses the shared WHERE builder (filters.ts) so the aggregate
// filters behave identically to the list filters; all it adds is the
// bucketing, grouping, and counting.
//
// Parameter layout: the date_bin stride (interval) and origin (= since)
// are added to the shared accumulator FIRST, then the filter
// conditions. Because the accumulator numbers every value through one
// counter, the placeholders stay consistent no matter the order.
//
// Security note: the ONE dynamic identifier in the whole read path is
// the GROUP BY column. It is not a bound value (you cannot parameterize
// an identifier), so it is chosen from a closed two-value allow-list
// (service | level) derived from the already-validated group_by
// dimension. Everything else is a bound parameter.

import { pool } from '../pool.js';
import { decodeLevel } from '../../core/levels.js';
import {
  type AggregateBucket,
  type GroupByDimension,
  type LogLevelCode,
  type QueryFilters,
} from '../../core/types.js';
import { createParams, filterConditions, whereClause } from './filters.js';

// Raw row shapes from node-postgres before transformation.
//   - bucket_start  date_bin() -> Date
//   - grp           service (text) or level (smallint); absent when
//                   there is no group_by
//   - cnt           count(*) -> BIGINT -> string
interface RawAggRow {
  readonly bucket_start: Date;
  readonly grp?: string | number;
  readonly cnt: string;
}

export interface AggregateParams {
  // since and until are guaranteed present: the aggregate route rejects
  // the request with 400 before calling this if either is missing.
  readonly filters: QueryFilters;
  // The PostgreSQL interval literal for the bucket stride, from
  // validateBucket (e.g. '1 minute').
  readonly interval: string;
  readonly groupBy?: GroupByDimension;
}

export interface AggregateResult {
  readonly buckets: readonly AggregateBucket[];
}

/**
 * Run a GET /logs/aggregate query and return the time buckets.
 */
export async function queryAggregate(
  params: AggregateParams,
): Promise<AggregateResult> {
  const { filters, interval, groupBy } = params;

  // Origin for date_bin alignment is the inclusive range start. The
  // route guarantees it; guard defensively so a programming slip fails
  // loudly (500) rather than producing silently wrong buckets.
  if (filters.since === undefined) {
    throw new Error('queryAggregate requires filters.since (origin)');
  }

  const accum = createParams();

  // Add the date_bin arguments first: stride and origin.
  const intervalPlaceholder = accum.add(interval);
  const originPlaceholder = accum.add(filters.since);

  // Then the shared filter conditions (service, level, since, until,
  // attr, q) -- their placeholders continue the same numbering.
  const conditions = filterConditions(filters, accum);
  const where = whereClause(conditions);

  const bucketExpr =
    `date_bin(${intervalPlaceholder}::interval, "timestamp", ` +
    `${originPlaceholder}::timestamptz)`;

  let sql: string;
  if (groupBy === undefined) {
    // Single ungrouped series: one row per bucket.
    sql =
      `SELECT ${bucketExpr} AS bucket_start, count(*) AS cnt ` +
      `FROM logs ${where} ` +
      `GROUP BY bucket_start ` +
      `ORDER BY bucket_start ASC`;
  } else {
    // Grouped series. groupCol is chosen from a closed allow-list, not
    // interpolated from raw input -- the only dynamic identifier here.
    const groupCol = groupBy === 'service' ? 'service' : 'level';
    sql =
      `SELECT ${bucketExpr} AS bucket_start, ${groupCol} AS grp, ` +
      `count(*) AS cnt ` +
      `FROM logs ${where} ` +
      `GROUP BY bucket_start, grp ` +
      `ORDER BY bucket_start ASC, grp ASC`;
  }

  const result = await pool.query<RawAggRow>(sql, accum.values);

  // Transform to the API shape. Empty buckets never appear because
  // GROUP BY only emits rows for time windows that contain data (§7:
  // "empty buckets may be omitted").
  const buckets: AggregateBucket[] = [];
  for (const r of result.rows) {
    let group: string | null;
    if (groupBy === undefined) {
      group = null;
    } else if (groupBy === 'service') {
      group = r.grp as string;
    } else {
      // group_by=level: the column holds the SMALLINT code; decode it
      // to the wire name here, in the core mapping -- never in SQL.
      group = decodeLevel(r.grp as LogLevelCode);
    }

    buckets.push({
      start: r.bucket_start.toISOString(),
      group,
      count: Number(r.cnt),
    });
  }

  return { buckets };
}
