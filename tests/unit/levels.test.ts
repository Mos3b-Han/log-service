// tests/unit/levels.test.ts
//
// Level encoding is load-bearing in a way that is easy to overlook: the
// numeric code is what lands in the SMALLINT column, so an off-by-one
// here would silently mislabel every row written afterwards and every
// row read back. These tests pin the mapping in both directions.

import { describe, it, expect } from 'vitest';
import { encodeLevel, decodeLevel, isLogLevel } from '../../src/core/levels.js';
import { LOG_LEVELS } from '../../src/core/types.js';
import type { LogLevelCode } from '../../src/core/types.js';

describe('encodeLevel', () => {
  it('maps each level to its documented SMALLINT code', () => {
    expect(encodeLevel('debug')).toBe(0);
    expect(encodeLevel('info')).toBe(1);
    expect(encodeLevel('warn')).toBe(2);
    expect(encodeLevel('error')).toBe(3);
  });

  it('encodes in ascending severity order', () => {
    // Ascending order is what makes `WHERE level >= 2` mean
    // "warn and above" -- a property the schema design relies on.
    const codes = LOG_LEVELS.map(encodeLevel);
    expect(codes).toEqual([...codes].sort((a, b) => a - b));
  });
});

describe('decodeLevel', () => {
  it('round-trips every level', () => {
    for (const name of LOG_LEVELS) {
      expect(decodeLevel(encodeLevel(name))).toBe(name);
    }
  });

  it('throws on a code outside the known range', () => {
    // Should be impossible through the type system, but a row inserted
    // outside our writer could carry anything. Failing loudly beats
    // returning undefined into a JSON response.
    expect(() => decodeLevel(7 as LogLevelCode)).toThrow(/Unknown log level/);
  });
});

describe('isLogLevel', () => {
  it('accepts exactly the four documented levels', () => {
    for (const name of LOG_LEVELS) {
      expect(isLogLevel(name)).toBe(true);
    }
  });

  it.each([
    ['critical', 'a plausible level that the spec does not define'],
    ['ERROR', 'wrong case'],
    ['', 'empty string'],
    [' info', 'leading whitespace'],
  ])('rejects %j (%s)', (value) => {
    expect(isLogLevel(value)).toBe(false);
  });

  it.each([[2], [null], [undefined], [{}], [['info']]])(
    'rejects the non-string %j',
    (value) => {
      expect(isLogLevel(value)).toBe(false);
    },
  );
});
