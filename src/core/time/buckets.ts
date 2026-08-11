// src/core/time/buckets.ts
//
// Validation and translation for the two aggregate-only query
// parameters: `bucket` (the time-window size) and `group_by` (the
// grouping dimension). Pure core logic: no I/O, no imports from http/
// or db/, returns ValidationResult rather than throwing.
//
// The bucket size maps to a PostgreSQL interval literal for use as the
// stride of date_bin(stride, source, origin). date_bin (PG14+) buckets
// each row's timestamp into fixed-width windows aligned to an origin.
// We use the query's `since` as the origin (chosen in aggregate.ts),
// so the first window starts exactly at the inclusive range start --
// matching the spec's example where a since of 14:00:00 yields buckets
// at 14:00, 14:01, ...
//
// Only fixed-width strides are allowed (minute/hour/day); date_bin
// forbids month-or-larger units because their length varies. '1 day'
// is treated as exactly 24h on the UTC instant, which is deterministic.

import {
  type GroupByDimension,
  type ValidationResult,
} from '../types.js';

// Allow-list mapping the four accepted bucket tokens to PostgreSQL
// interval literals. The value side is entirely ours -- never derived
// from user input -- but aggregate.ts still binds it as a parameter
// ($n::interval) to keep the "every value is a parameter" rule total.
const BUCKET_INTERVALS = {
  '1m': '1 minute',
  '5m': '5 minutes',
  '1h': '1 hour',
  '1d': '1 day',
} as const;

export type BucketSize = keyof typeof BUCKET_INTERVALS;

/**
 * Validate the required `bucket` parameter and return the PostgreSQL
 * interval literal for its stride. Absent, duplicated, or unrecognized
 * values all produce a 400.
 */
export function validateBucket(raw: unknown): ValidationResult<string> {
  // Covers absent (undefined) and duplicated (string[]) alike: neither
  // is a single string token.
  if (typeof raw !== 'string') {
    return {
      ok: false,
      reason: "'bucket' must be one of 1m, 5m, 1h, 1d",
    };
  }

  const interval = BUCKET_INTERVALS[raw as BucketSize];
  if (interval === undefined) {
    return {
      ok: false,
      reason: `invalid bucket: '${raw}' (must be one of 1m, 5m, 1h, 1d)`,
    };
  }

  return { ok: true, value: interval };
}

/**
 * Validate the optional `group_by` parameter.
 *   absent            -> { ok: true, value: undefined } (single series)
 *   'service'|'level' -> { ok: true, value: <dimension> }
 *   anything else     -> 400
 */
export function validateGroupBy(
  raw: unknown,
): ValidationResult<GroupByDimension | undefined> {
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  if (raw !== 'service' && raw !== 'level') {
    return {
      ok: false,
      reason: `invalid group_by: '${String(raw)}' (must be 'service' or 'level')`,
    };
  }
  return { ok: true, value: raw };
}
