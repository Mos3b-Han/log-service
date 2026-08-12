
import {
  type GroupByDimension,
  type ValidationResult,
} from '../types.js';


const BUCKET_INTERVALS = {
  '1m': '1 minute',
  '5m': '5 minutes',
  '1h': '1 hour',
  '1d': '1 day',
} as const;

export type BucketSize = keyof typeof BUCKET_INTERVALS;


export function validateBucket(raw: unknown): ValidationResult<string> {

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
