// tests/unit/validateFilters.test.ts
//
// Query-filter validation, shared by GET /logs and GET /logs/aggregate.
// Two things matter here beyond the obvious: every rejection must be a
// clean 400 rather than a throw, and the attribute-key allow-list is
// the first of the two defenses that keep caller-controlled identifiers
// away from SQL.

import { describe, it, expect } from 'vitest';
import {
  validateFilters,
  validateLimit,
} from '../../src/core/validation/validateFilters.js';

describe('validateFilters — accepts', () => {
  it('an empty query', () => {
    const out = validateFilters({});
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.service).toBeUndefined();
    // Always an array so consumers can iterate without a null check.
    expect(out.value.attributes).toEqual([]);
  });

  it('the full shared filter set', () => {
    const out = validateFilters({
      service: 'checkout',
      level: 'error',
      since: '2026-08-11T10:00:00Z',
      until: '2026-08-11T11:00:00Z',
      q: 'declined',
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.service).toBe('checkout');
    // Stored as the SMALLINT code, ready for `WHERE level = $n`.
    expect(out.value.level).toBe(3);
    expect(out.value.since?.toISOString()).toBe('2026-08-11T10:00:00.000Z');
    expect(out.value.q).toBe('declined');
  });

  it('multiple attribute filters', () => {
    const out = validateFilters({
      'attr.user_id': '42',
      'attr.region': 'eu-west',
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.attributes).toEqual([
      { key: 'user_id', value: '42' },
      { key: 'region', value: 'eu-west' },
    ]);
  });

  it('since without until, and until without since', () => {
    // Both are optional on GET /logs; only the aggregate route requires
    // them, and it enforces that itself.
    expect(validateFilters({ since: '2026-08-11T10:00:00Z' }).ok).toBe(true);
    expect(validateFilters({ until: '2026-08-11T10:00:00Z' }).ok).toBe(true);
  });

  it('an empty q, treating it as no filter at all', () => {
    const out = validateFilters({ q: '' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // An empty substring would mean ILIKE '%%', i.e. match everything.
    expect(out.value.q).toBeUndefined();
  });

  it('attribute keys made of the allowed characters', () => {
    for (const key of ['user_id', 'a.b', 'trace-id', 'A1', 'x'.repeat(128)]) {
      expect(validateFilters({ [`attr.${key}`]: 'v' }).ok, key).toBe(true);
    }
  });
});

describe('validateFilters — rejects', () => {
  it('an unsupported level, with spec wording', () => {
    const out = validateFilters({ level: 'critical' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("invalid level: 'critical'");
  });

  it.each([
    ['since', { since: 'nope' }],
    ['until', { until: '11-08-2026' }],
  ])('an unparseable %s', (_label, query) => {
    expect(validateFilters(query).ok).toBe(false);
  });

  it('until equal to or before since', () => {
    // §8 requires until to be strictly after since; the range is
    // half-open, so an equal pair can never match anything.
    for (const until of ['2026-08-11T10:00:00Z', '2026-08-11T09:00:00Z']) {
      const out = validateFilters({ since: '2026-08-11T10:00:00Z', until });
      expect(out.ok, until).toBe(false);
      if (out.ok) continue;
      expect(out.reason).toMatch(/'until' must be after 'since'/);
    }
  });

  it('an empty service filter', () => {
    expect(validateFilters({ service: '' }).ok).toBe(false);
  });

  it.each([
    ['service', { service: ['a', 'b'] }],
    ['level', { level: ['info', 'warn'] }],
    ['since', { since: ['a', 'b'] }],
    ['q', { q: ['a', 'b'] }],
    ['an attribute', { 'attr.k': ['a', 'b'] }],
  ])('a duplicated %s parameter', (_label, query) => {
    // Repeating a single-valued parameter is ambiguous. Picking one
    // silently would give the caller results they did not ask for.
    expect(validateFilters(query).ok).toBe(false);
  });

  it.each([
    ['a space', 'bad key'],
    ['a quote', "a'b"],
    ['a semicolon', 'a;DROP TABLE logs'],
    ['a percent sign', 'a%b'],
    ['empty', ''],
  ])('an attribute key containing %s', (_label, key) => {
    // Defense in depth: the key never reaches SQL as an identifier --
    // it travels inside a JSONB parameter -- but it is still constrained
    // at the earliest possible point.
    const out = validateFilters({ [`attr.${key}`]: 'v' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toMatch(/attribute key/);
  });

  it('too many attribute filters', () => {
    const query: Record<string, string> = {};
    for (let i = 0; i < 40; i++) query[`attr.k${i}`] = 'v';
    const out = validateFilters(query);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toMatch(/too many attribute filters/);
  });

  it('an over-long q or service', () => {
    expect(validateFilters({ q: 'x'.repeat(1025) }).ok).toBe(false);
    expect(validateFilters({ service: 'x'.repeat(513) }).ok).toBe(false);
  });
});

describe('validateLimit', () => {
  it('defaults to 100 when absent', () => {
    expect(validateLimit(undefined)).toEqual({ ok: true, value: 100 });
  });

  it.each([
    ['1', 1],
    ['100', 100],
    ['999', 999],
    ['1000', 1000],
  ])('accepts %s', (raw, expected) => {
    expect(validateLimit(raw)).toEqual({ ok: true, value: expected });
  });

  it.each([
    ['0', 'below the minimum'],
    ['1001', 'above the maximum'],
    ['-5', 'negative'],
    ['abc', 'non-numeric'],
    ['10.5', 'fractional'],
    ['1e3', 'exponent notation'],
    [' 100', 'padded'],
    ['0x64', 'hex'],
    ['', 'empty'],
  ])('rejects %j (%s)', (raw) => {
    expect(validateLimit(raw).ok).toBe(false);
  });

  it('rejects a duplicated limit parameter', () => {
    expect(validateLimit(['1', '2']).ok).toBe(false);
  });
});
