// tests/unit/cursor.test.ts
//
// The pagination cursor is handed to clients and handed back verbatim,
// so it is the one piece of caller-controlled state that reaches the
// keyset predicate. Two properties matter most: BIGINT ids survive the
// round trip exactly, and no malformed input can throw or slip through.

import { describe, it, expect } from 'vitest';
import {
  encodeCursor,
  decodeCursor,
} from '../../src/core/pagination/cursor.js';

const TS = new Date('2026-08-11T11:32:01.123Z');

/** Encode an arbitrary payload the way a tamperer would. */
function forge(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

describe('encodeCursor / decodeCursor round trip', () => {
  it('preserves timestamp and id', () => {
    const encoded = encodeCursor({ timestamp: TS, id: '123456789' });
    const out = decodeCursor(encoded);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.timestamp.getTime()).toBe(TS.getTime());
    expect(out.value.id).toBe('123456789');
  });

  it('preserves a BIGINT id beyond Number.MAX_SAFE_INTEGER', () => {
    // The id is a BIGSERIAL. Held as a number it would round: this is
    // exactly why the cursor carries it as a string end to end.
    const bigId = '9223372036854775807';
    expect(Number(bigId).toString()).not.toBe(bigId); // precision is lost as a number
    const out = decodeCursor(encodeCursor({ timestamp: TS, id: bigId }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.id).toBe(bigId);
  });

  it('produces a URL-safe token', () => {
    // Cursors travel in a query string and the load generator passes
    // them back unchanged, so they must not need URL-encoding.
    for (let i = 0; i < 200; i++) {
      const encoded = encodeCursor({
        timestamp: new Date(Date.now() - i * 1000),
        id: String(i * 7919),
      });
      expect(encoded, encoded).not.toMatch(/[+/=]/);
    }
  });

  it('preserves millisecond precision', () => {
    const ts = new Date('2026-08-11T11:32:01.007Z');
    const out = decodeCursor(encodeCursor({ timestamp: ts, id: '1' }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.timestamp.toISOString()).toBe('2026-08-11T11:32:01.007Z');
  });
});

describe('decodeCursor — defensive', () => {
  it.each([
    ['an empty string', ''],
    ['random text', 'not-a-cursor!!!'],
    ['valid base64 that is not JSON', Buffer.from('hello').toString('base64url')],
    ['a JSON array', forge([1, 2, 3])],
    ['a JSON string', forge('nope')],
    ['a JSON null', forge(null)],
  ])('rejects %s', (_label, raw) => {
    const out = decodeCursor(raw);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('invalid cursor');
  });

  it('rejects an unknown format version', () => {
    // The version field exists so a future format change fails closed
    // instead of being misread against the new shape.
    const out = decodeCursor(forge({ v: 99, ts: TS.toISOString(), id: '1' }));
    expect(out.ok).toBe(false);
  });

  it.each([
    ['a missing id', { v: 1, ts: TS.toISOString() }],
    ['a non-string id', { v: 1, ts: TS.toISOString(), id: 5 }],
    ['a non-numeric id', { v: 1, ts: TS.toISOString(), id: 'abc' }],
    ['a negative id', { v: 1, ts: TS.toISOString(), id: '-1' }],
    ['an over-long id', { v: 1, ts: TS.toISOString(), id: '1'.repeat(20) }],
    ['an SQL-shaped id', { v: 1, ts: TS.toISOString(), id: '1; DROP TABLE logs' }],
  ])('rejects %s', (_label, payload) => {
    // The id ends up as a bound parameter, but constraining its shape
    // here means nothing but digits can ever reach the query layer.
    expect(decodeCursor(forge(payload)).ok).toBe(false);
  });

  it.each([
    ['a missing ts', { v: 1, id: '1' }],
    ['a non-string ts', { v: 1, ts: 12345, id: '1' }],
    ['an unparseable ts', { v: 1, ts: 'yesterday', id: '1' }],
  ])('rejects %s', (_label, payload) => {
    expect(decodeCursor(forge(payload)).ok).toBe(false);
  });

  it.each([[42], [null], [undefined], [{ v: 1 }], [['x']], [true]])(
    'rejects the non-string input %j',
    (raw) => {
      expect(decodeCursor(raw).ok).toBe(false);
    },
  );

  it('never throws on any of the above', () => {
    const hostile: unknown[] = [
      '',
      '!!!',
      forge([1]),
      forge({ v: 99 }),
      42,
      null,
      undefined,
      {},
      Buffer.from([0xff, 0xfe, 0xfd]).toString('base64url'),
    ];
    for (const raw of hostile) {
      expect(() => decodeCursor(raw), String(raw)).not.toThrow();
    }
  });
});
