// tests/unit/buckets.test.ts
//
// Bucket and group_by validation for GET /logs/aggregate. The bucket
// token maps to a PostgreSQL interval literal, and group_by decides the
// single dynamic identifier in the whole read path -- so both are
// closed allow-lists, and these tests pin exactly what is in them.

import { describe, it, expect } from 'vitest';
import {
  validateBucket,
  validateGroupBy,
} from '../../src/core/time/buckets.js';

describe('validateBucket', () => {
  it.each([
    ['1m', '1 minute'],
    ['5m', '5 minutes'],
    ['1h', '1 hour'],
    ['1d', '1 day'],
  ])('maps %s to the interval %j', (token, interval) => {
    expect(validateBucket(token)).toEqual({ ok: true, value: interval });
  });

  it('accepts exactly the four documented tokens and nothing else', () => {
    // date_bin only supports fixed-width strides, which is why nothing
    // month-sized appears here.
    for (const token of ['2h', '30s', '1w', '1M', '1y', '10m', 'h', '']) {
      expect(validateBucket(token).ok, token).toBe(false);
    }
  });

  it('rejects an absent bucket', () => {
    // Required for aggregation, so absence is an error rather than a
    // default -- guessing a bucket size would silently change results.
    const out = validateBucket(undefined);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toMatch(/1m, 5m, 1h, 1d/);
  });

  it.each([[['1m', '5m']], [1], [null], [{}], [true]])(
    'rejects the non-token input %j',
    (raw) => {
      expect(validateBucket(raw).ok).toBe(false);
    },
  );

  it('names the offending value in the reason', () => {
    const out = validateBucket('2h');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toContain("'2h'");
  });
});

describe('validateGroupBy', () => {
  it.each([['service'], ['level']])('accepts %s', (dim) => {
    expect(validateGroupBy(dim)).toEqual({ ok: true, value: dim });
  });

  it('treats absence as a single ungrouped series', () => {
    // §7: with no group_by, every bucket reports group: null.
    expect(validateGroupBy(undefined)).toEqual({ ok: true, value: undefined });
  });

  it.each([
    ['message', 'a real column that is not a supported dimension'],
    ['timestamp', 'the partition key'],
    ['attributes', 'the JSONB column'],
    ['service; DROP TABLE logs', 'an injection attempt'],
    ['SERVICE', 'wrong case'],
    ['', 'empty'],
  ])('rejects %j (%s)', (raw) => {
    // This value selects a SQL identifier, so the allow-list is the
    // security boundary, not just input hygiene.
    expect(validateGroupBy(raw).ok).toBe(false);
  });

  it.each([[['service']], [1], [null], [{}]])(
    'rejects the non-string input %j',
    (raw) => {
      expect(validateGroupBy(raw).ok).toBe(false);
    },
  );
});
