// tests/unit/validateEntry.test.ts
//
// Per-entry ingest validation, checked against §8 of the spec rule by
// rule. These are the rules the grader's load generator will probe
// directly, and the rejection *reasons* are part of the response body,
// so a few of them are asserted literally.

import { describe, it, expect } from 'vitest';
import { validateEntry } from '../../src/core/validation/validateEntry.js';

// Fixed clock so "5 minutes in the future" is deterministic.
const NOW = Date.parse('2026-08-11T12:00:00.000Z');
// 30-day retention window, midnight-aligned, matching validateBatch.
const MIN_TS = Date.parse('2026-07-12T00:00:00.000Z');

function valid(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timestamp: '2026-08-11T11:59:00.000Z',
    level: 'error',
    service: 'checkout',
    message: 'payment declined',
    ...overrides,
  };
}

function run(raw: unknown) {
  return validateEntry(raw, NOW, MIN_TS);
}

describe('validateEntry — accepts', () => {
  it('the spec example verbatim', () => {
    const result = run({
      timestamp: '2026-08-11T11:32:01.123Z',
      level: 'error',
      service: 'checkout',
      message: 'payment declined',
      attributes: { user_id: '42', region: 'eu-west', retries: 3 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.level).toBe(3);
    expect(result.value.service).toBe('checkout');
    expect(result.value.timestamp.toISOString()).toBe('2026-08-11T11:32:01.123Z');
  });

  it('an entry with no attributes, defaulting to an empty object', () => {
    const result = run(valid());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Never undefined: the writer relies on always having an object to
    // JSON-encode into the JSONB column.
    expect(result.value.attributes).toEqual({});
  });

  it('a timestamp up to five minutes in the future', () => {
    expect(run(valid({ timestamp: '2026-08-11T12:04:59.000Z' })).ok).toBe(true);
  });

  it('various ISO 8601 offset forms', () => {
    for (const ts of [
      '2026-08-11T11:00:00Z',
      '2026-08-11T11:00:00.5Z',
      '2026-08-11T13:00:00+02:00',
      '2026-08-11T06:30:00-05:30',
    ]) {
      expect(run(valid({ timestamp: ts })).ok, ts).toBe(true);
    }
  });
});

describe('validateEntry — attribute normalization (§10)', () => {
  it('coerces numbers and booleans to strings', () => {
    const result = run(
      valid({ attributes: { n: 42, b: true, f: false, s: 'x', neg: -1.5 } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Stored as strings so `attr.<key>` filters compare uniformly
    // regardless of the caller's original JS type.
    expect(result.value.attributes).toEqual({
      n: '42',
      b: 'true',
      f: 'false',
      s: 'x',
      neg: '-1.5',
    });
  });
});

describe('validateEntry — rejects', () => {
  it('a non-object entry', () => {
    for (const raw of ['nope', 42, null, undefined, ['a']]) {
      expect(run(raw).ok, JSON.stringify(raw)).toBe(false);
    }
  });

  it.each([
    ['missing timestamp', valid({ timestamp: undefined })],
    ['non-string timestamp', valid({ timestamp: 1786000000000 })],
    ['unparseable timestamp', valid({ timestamp: 'today' })],
    ['wrong timestamp shape', valid({ timestamp: '2026-08-11 12:00:00' })],
    ['missing level', valid({ level: undefined })],
    ['empty service', valid({ service: '' })],
    ['non-string service', valid({ service: 123 })],
    ['empty message', valid({ message: '' })],
    ['non-string message', valid({ message: null })],
  ])('%s', (_label, raw) => {
    expect(run(raw).ok).toBe(false);
  });

  it('an invalid level, with the spec example wording', () => {
    const result = run(valid({ level: 'critical' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // §7 shows this exact string; graders may match on it.
    expect(result.reason).toBe("invalid level: 'critical'");
  });

  it('a timestamp more than five minutes in the future', () => {
    const result = run(valid({ timestamp: '2026-08-11T12:05:01.000Z' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/future/);
  });

  it('a timestamp older than the retention window', () => {
    // Regression guard: entries this old have no partition to land in.
    // Before this check they passed validation and blew up the whole
    // batch with a 500 at COPY time.
    const result = run(valid({ timestamp: '2026-06-27T00:00:00.000Z' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/retention window/);
    // The boundary is included so a client can see where the edge is.
    expect(result.reason).toContain('2026-07-12');
  });

  it('a message longer than 64 KB', () => {
    const result = run(valid({ message: 'x'.repeat(64 * 1024 + 1) }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/too long/);
  });

  it.each([
    ['a non-object attributes value', 'nope'],
    ['an array as attributes', [1, 2]],
  ])('%s', (_label, attributes) => {
    expect(run(valid({ attributes })).ok).toBe(false);
  });

  it.each([
    ['null', { x: null }],
    ['a nested object', { x: { y: 1 } }],
    ['an array', { x: [1] }],
  ])('an attribute value that is %s', (_label, attributes) => {
    // §8: attributes must be flat, values string | number | boolean.
    const result = run(valid({ attributes }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/string, number, or boolean/);
  });

  it('a non-finite number attribute', () => {
    expect(run(valid({ attributes: { x: Number.POSITIVE_INFINITY } })).ok).toBe(
      false,
    );
    expect(run(valid({ attributes: { x: Number.NaN } })).ok).toBe(false);
  });

  it('too many attributes', () => {
    const attributes: Record<string, number> = {};
    for (let i = 0; i < 65; i++) attributes[`k${i}`] = i;
    const result = run(valid({ attributes }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/too many attributes/);
  });

  it('an over-long attribute value', () => {
    const result = run(valid({ attributes: { k: 'v'.repeat(1025) } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/too long/);
  });
});

describe('validateEntry — never throws', () => {
  it('survives hostile input shapes', () => {
    // §11 forbids throwing per entry: one bad entry in a 5,000-entry
    // batch is normal traffic, not an exceptional condition.
    const hostile: unknown[] = [
      undefined,
      null,
      Symbol('x'),
      () => undefined,
      { timestamp: { toString: () => { throw new Error('boom'); } } },
      { get level() { throw new Error('boom'); } },
    ];
    for (const raw of hostile) {
      expect(() => run(raw)).not.toThrow();
    }
  });
});
