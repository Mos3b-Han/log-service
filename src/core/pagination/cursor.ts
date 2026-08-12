
import { type Cursor, type ValidationResult } from '../types.js';


const CURSOR_VERSION = 1;


interface CursorPayload {
  readonly v: number;
  readonly ts: string;
  readonly id: string;
}


const ID_RE = /^\d{1,19}$/;


export function encodeCursor(cursor: Cursor): string {
  const payload: CursorPayload = {
    v: CURSOR_VERSION,
    ts: cursor.timestamp.toISOString(),
    id: cursor.id,
  };
  const json = JSON.stringify(payload);
  return Buffer.from(json, 'utf8').toString('base64url');
}

export function decodeCursor(raw: unknown): ValidationResult<Cursor> {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, reason: 'invalid cursor' };
  }

  let parsed: unknown;
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, reason: 'invalid cursor' };
  }

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
