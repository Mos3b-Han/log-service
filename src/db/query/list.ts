
import { pool } from '../pool.js';
import { decodeLevel } from '../../core/levels.js';
import { encodeCursor } from '../../core/pagination/cursor.js';
import {
  type Cursor,
  type LogLevelCode,
  type LogRow,
  type QueryFilters,
} from '../../core/types.js';
import {
  createParams,
  filterConditions,
  keysetCondition,
  whereClause,
} from './filters.js';


interface RawLogRow {
  readonly id: string;
  readonly timestamp: Date;
  readonly level: number;
  readonly service: string;
  readonly message: string;
  readonly attributes: Record<string, string>;
}

export interface ListParams {
  readonly filters: QueryFilters;
  readonly limit: number;
  readonly cursor?: Cursor;
}

export interface ListResult {
  readonly logs: readonly LogRow[];
  readonly nextCursor: string | null;
}


const SELECT_COLUMNS =
  'id, "timestamp", level, service, message, attributes';

export async function queryLogs(params: ListParams): Promise<ListResult> {
  const { filters, limit, cursor } = params;

  const accum = createParams();
  const conditions = filterConditions(filters, accum);
  if (cursor !== undefined) {
    conditions.push(keysetCondition(cursor, accum));
  }
  const where = whereClause(conditions);

  // Fetch one extra row to detect a next page without a COUNT.
  const limitPlaceholder = accum.add(limit + 1);

  const sql =
    `SELECT ${SELECT_COLUMNS} FROM logs ` +
    `${where} ` +
    `ORDER BY "timestamp" DESC, id DESC ` +
    `LIMIT ${limitPlaceholder}`;

  const result = await pool.query<RawLogRow>(sql, accum.values);
  const rows = result.rows;

  // If we got the sentinel extra row, there is another page.
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  // Transform to the API shape in a single pass.
  const logs: LogRow[] = [];
  for (const r of pageRows) {
    logs.push({
      id: r.id,
      timestamp: r.timestamp.toISOString(),
      level: decodeLevel(r.level as LogLevelCode),
      service: r.service,
      message: r.message,
      attributes: r.attributes,
    });
  }

  let nextCursor: string | null = null;
  if (hasMore && pageRows.length > 0) {
    const last = pageRows[pageRows.length - 1]!;
    nextCursor = encodeCursor({ timestamp: last.timestamp, id: last.id });
  }

  return { logs, nextCursor };
}
