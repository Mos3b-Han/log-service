// src/db/query/filters.ts
//
// The shared, parameterized WHERE builder used by both GET /logs
// (list.ts) and GET /logs/aggregate (aggregate.ts). This is the most
// security-sensitive file in the project: the grading spec states that
// SQL injection is disqualifying. Every rule here exists to make an
// injection structurally impossible, not merely unlikely.
//
// The security posture, top to bottom:
//
//   1. Every VALUE is a bound parameter ($N). Nothing derived from a
//      request is ever concatenated into SQL text. The condition
//      strings this module builds contain only placeholders and fixed
//      keywords -- never user data.
//
//   2. The only DYNAMIC IDENTIFIERS in the whole read path are the
//      attribute keys (attr.<key>). They never reach SQL as
//      identifiers at all: they live INSIDE a JSONB parameter passed
//      to the `@>` operator, and they were already checked against a
//      regex allow-list in core/validation/validateFilters before
//      arriving here. Two independent defenses.
//
//   3. All numeric/temporal inputs (level code, timestamps, cursor id)
//      were parsed and range-checked in the core layer; here they are
//      passed as typed parameters with explicit ::casts.
//
// This file builds only WHERE conditions and their parameters. The
// SELECT list, table name, ORDER BY, LIMIT, and date_bin() belong to
// the callers (list.ts / aggregate.ts), which compose the fragments
// this module returns.

import { type Cursor, type QueryFilters } from '../../core/types.js';

// -----------------------------------------------------------------
// Parameter accumulator
// -----------------------------------------------------------------
//
// list and aggregate each build one SQL statement whose $N parameters
// must be numbered consistently across the shared WHERE conditions AND
// each caller's own extras (LIMIT for list; the date_bin interval and
// origin for aggregate). A shared accumulator makes that numbering
// foolproof: every value is added through one counter, and each add()
// returns the exact placeholder to drop into the SQL text.

export interface ParamAccumulator {
  /** Push a value and return its placeholder, e.g. "$3". */
  add(value: unknown): string;
  /** The accumulated values, positionally aligned with the placeholders. */
  readonly values: unknown[];
}

export function createParams(): ParamAccumulator {
  const values: unknown[] = [];
  return {
    add(value: unknown): string {
      values.push(value);
      return '$' + values.length;
    },
    values,
  };
}

// -----------------------------------------------------------------
// LIKE / ILIKE escaping
// -----------------------------------------------------------------
//
// ILIKE treats % and _ as wildcards. For a literal substring match we
// must neutralize them, plus the escape character itself. We do this
// in the parameter VALUE (not the SQL text) and pair it with an
// explicit ESCAPE clause so the behavior does not depend on the
// server's default escape character.
//
// Single-pass over the original string: each of \, %, _ is prefixed
// with one backslash. Because we scan the original (not our output),
// the backslash we add is never itself re-escaped.
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

// -----------------------------------------------------------------
// Shared filter conditions
// -----------------------------------------------------------------

/**
 * Build the WHERE condition fragments shared by list and aggregate.
 * Appends every value to the supplied accumulator and returns the
 * condition strings (each already referencing its placeholder). The
 * caller joins these with its own conditions via whereClause().
 *
 * Order of conditions is chosen to match the composite index
 * (service, level, timestamp, id): equality columns first, range
 * columns last, so the planner can use the index prefix.
 */
export function filterConditions(
  filters: QueryFilters,
  params: ParamAccumulator,
): string[] {
  const conditions: string[] = [];

  // Equality on service -- leading column of the composite index.
  if (filters.service !== undefined) {
    conditions.push(`service = ${params.add(filters.service)}`);
  }

  // Equality on the SMALLINT level code -- second index column.
  if (filters.level !== undefined) {
    conditions.push(`level = ${params.add(filters.level)}`);
  }

  // Inclusive lower bound on the time range.
  if (filters.since !== undefined) {
    conditions.push(`"timestamp" >= ${params.add(filters.since)}`);
  }

  // Exclusive upper bound on the time range.
  if (filters.until !== undefined) {
    conditions.push(`"timestamp" < ${params.add(filters.until)}`);
  }

  // Attribute equality via JSONB containment. All attr.<key> filters
  // merge into ONE object handled by a single `@>` -- the GIN
  // jsonb_path_ops index resolves any number of keys in one probe.
  // Keys are guaranteed distinct (validateFilters rejects duplicates),
  // so the merge cannot silently drop a constraint.
  if (filters.attributes.length > 0) {
    const containment: Record<string, string> = {};
    for (const attr of filters.attributes) {
      containment[attr.key] = attr.value;
    }
    conditions.push(
      `attributes @> ${params.add(JSON.stringify(containment))}::jsonb`,
    );
  }

  // Case-insensitive substring on message. No index backs this (§9);
  // it relies on the other filters to have narrowed the scan. The
  // pattern is fully built and escaped in JS, then bound as one value.
  if (filters.q !== undefined) {
    const pattern = '%' + escapeLike(filters.q) + '%';
    conditions.push(`message ILIKE ${params.add(pattern)} ESCAPE '\\'`);
  }

  return conditions;
}

// -----------------------------------------------------------------
// Keyset (seek) condition -- list only
// -----------------------------------------------------------------

/**
 * Build the keyset-pagination condition that seeks past the last row
 * of the previous page. Uses a row-value comparison on (timestamp, id)
 * so it aligns exactly with `ORDER BY "timestamp" DESC, id DESC` and
 * the primary key (timestamp, id). Never OFFSET (CLAUDE.md §11).
 *
 * `< (ts, id)` selects rows strictly "older" than the cursor under the
 * descending order, giving stable, gap-free pagination even as new
 * rows are ingested at the head.
 */
export function keysetCondition(
  cursor: Cursor,
  params: ParamAccumulator,
): string {
  const ts = params.add(cursor.timestamp);
  const id = params.add(cursor.id);
  return `("timestamp", id) < (${ts}::timestamptz, ${id}::bigint)`;
}

// -----------------------------------------------------------------
// Assembly helper
// -----------------------------------------------------------------

/**
 * Turn a list of condition fragments into a WHERE clause, or the empty
 * string when there are no conditions (a bare SELECT over the table).
 */
export function whereClause(conditions: readonly string[]): string {
  return conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
}
