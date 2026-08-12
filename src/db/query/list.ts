// src/db/query/list.ts
//
// Executor for GET /logs. Composes the shared WHERE builder (filters.ts)
// into a full SELECT, runs it, transforms raw rows into the API shape,
// and computes the opaque next_cursor. All SQL lives here and in
// filters.ts; the route (query.ts) stays free of database concerns.
//
// Pagination strategy: keyset seek, never OFFSET. We
// ask Postgres for LIMIT+1 rows. If it returns the extra row, there is
// another page: we drop the extra, return exactly `limit` rows, and
// encode a cursor from the last RETURNED row so the next request seeks
// past it. If it returns fewer, this is the last page and next_cursor
// is null. This avoids a second COUNT query entirely.

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

// The raw row as node-postgres returns it, before transformation:
//   - id          BIGINT   -> string (pg default, preserves precision)
//   - timestamp   TIMESTAMPTZ -> Date (pg default type parser)
//   - level       SMALLINT -> number
//   - attributes  JSONB    -> object (pg parses it)
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

// Fixed column list. Static text -- no user input -- and "timestamp"
// is quoted because it is also a SQL type name (consistent with the
// index migration).
const SELECT_COLUMNS =
  'id, "timestamp", level, service, message, attributes';

/**
 * Run a GET /logs query and return the page plus its next cursor.
 */
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

  // Cursor points at the last row we actually returned, so the next
  // page seeks strictly past it. Null when this was the final page.
  let nextCursor: string | null = null;
  if (hasMore && pageRows.length > 0) {
    const last = pageRows[pageRows.length - 1]!;
    nextCursor = encodeCursor({ timestamp: last.timestamp, id: last.id });
  }

  return { logs, nextCursor };
}
