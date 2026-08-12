
import { pool } from '../pool.js';
import { decodeLevel } from '../../core/levels.js';
import {
  type AggregateBucket,
  type GroupByDimension,
  type LogLevelCode,
  type QueryFilters,
} from '../../core/types.js';
import { createParams, filterConditions, whereClause } from './filters.js';


interface RawAggRow {
  readonly bucket_start: Date;
  readonly grp?: string | number;
  readonly cnt: string;
}

export interface AggregateParams {
 
  readonly filters: QueryFilters;
  
  readonly interval: string;
  readonly groupBy?: GroupByDimension;
}

export interface AggregateResult {
  readonly buckets: readonly AggregateBucket[];
}

export async function queryAggregate(
  params: AggregateParams,
): Promise<AggregateResult> {
  const { filters, interval, groupBy } = params;

  if (filters.since === undefined) {
    throw new Error('queryAggregate requires filters.since (origin)');
  }

  const accum = createParams();

  const intervalPlaceholder = accum.add(interval);
  const originPlaceholder = accum.add(filters.since);

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

  const buckets: AggregateBucket[] = [];
  for (const r of result.rows) {
    let group: string | null;
    if (groupBy === undefined) {
      group = null;
    } else if (groupBy === 'service') {
      group = r.grp as string;
    } else {
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
