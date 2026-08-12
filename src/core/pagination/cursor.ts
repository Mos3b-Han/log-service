// src/core/pagination/cursor.ts
//
// Encode and decode the opaque pagination cursor for GET /logs. The
// cursor carries the (timestamp, id) of the last row on a page so the
// next request can seek past it -- keyset pagination, never OFFSET
// by design. Pure core logic: no I/O, no imports from http/ or
// db/, and decode never throws -- it returns a ValidationResult so a
// tampered or stale cursor becomes a clean 400 (§8).
//
// Wire format: base64url( JSON( { v, ts, id } ) )
//   v   format version    -> a bumped version rejects old cursors
//   ts  ISO 8601 string    -> the last row's timestamp
//   id  decimal string     -> the last row's BIGSERIAL id
//
// Why base64url (not standard base64): the cursor lives in a query
// string. Standard base64's '+' and '/' would need URL-encoding, and
// the load generator passes cursors back "unchanged"; base64url's
// alphabet (-, _, no padding) is URL-safe as-is.
//
// Why the timestamp check on decode is lenient (parse + NaN, no strict
// ISO regex): the cursor is a value WE emit, so the only threat is
// tampering. A tampered-but-parseable timestamp merely yields a
// different page boundary -- harmless, because ts and id both leave
// this module as bound query parameters, never as concatenated SQL.
// The real gate is the JSON parse and the shape check below.

import { type Cursor, type ValidationResult } from '../types.js';

// Current wire-format version. Bump this if the payload shape changes;
// decode rejects any other version, so old cursors fail cleanly rather
// than being misread against a new format.
const CURSOR_VERSION = 1;

// The on-wire JSON shape. Kept separate from the decoded `Cursor`
// (which uses a Date) because the wire form is all strings/numbers.
interface CursorPayload {
  readonly v: number;
  readonly ts: string;
  readonly id: string;
}

// BIGSERIAL id: a positive decimal integer, at most 19 digits
// (max BIGINT is 9223372036854775807). Validated on decode so a
// tampered id can never reach the SQL layer as anything but a plain
// number string.
const ID_RE = /^\d{1,19}$/;

/**
 * Encode the last row of a page into an opaque cursor string.
 * Called by the list query when a full page was returned and more
 * rows may exist.
 */
export function encodeCursor(cursor: Cursor): string {
  const payload: CursorPayload = {
    v: CURSOR_VERSION,
    ts: cursor.timestamp.toISOString(),
    id: cursor.id,
  };
  const json = JSON.stringify(payload);
  return Buffer.from(json, 'utf8').toString('base64url');
}

/**
 * Decode a client-supplied cursor. Defensive: any malformed input --
 * bad base64, non-JSON, wrong shape, wrong version, bad id/timestamp
 * -- returns { ok: false } with a generic reason. The route turns that
 * into a 400. Never throws.
 *
 * @param raw  The cursor parameter as received. Anything but a valid
 *             cursor string is rejected; callers invoke this only when
 *             a cursor was actually present (absence means first page).
 */
export function decodeCursor(raw: unknown): ValidationResult<Cursor> {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, reason: 'invalid cursor' };
  }

  // base64url decode is lenient and will not throw on stray chars;
  // the JSON.parse below is the real gate. Wrap it so a parse failure
  // becomes a result, not an exception.
  let parsed: unknown;
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, reason: 'invalid cursor' };
  }

  // Shape check: must be a plain object with the exact field types we
  // emitted. Anything else -- including an old version -- is rejected.
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    return { ok: false, reason: 'invalid cursor' };
  }

  const obj = parsed as Record<string, unknown>;

  if (obj['v'] !== CURSOR_VERSION) {
    return { ok: false, reason: 'invalid cursor' };
  }
  if (typeof obj['id'] !== 'string' || !ID_RE.test(obj['id'])) {
    return { ok: false, reason: 'invalid cursor' };
  }
  if (typeof obj['ts'] !== 'string') {
    return { ok: false, reason: 'invalid cursor' };
  }

  const ms = Date.parse(obj['ts']);
  if (Number.isNaN(ms)) {
    return { ok: false, reason: 'invalid cursor' };
  }

  return { ok: true, value: { timestamp: new Date(ms), id: obj['id'] } };
}
