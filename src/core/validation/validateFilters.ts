// src/core/validation/validateFilters.ts
//
// Validate the query parameters shared by GET /logs and
// GET /logs/aggregate, producing a normalized QueryFilters object for
// the db layer to turn into a parameterized WHERE clause. Pure core
// logic: no I/O, no imports from http/ or db/, never throws.
//
// The shared filters (§7):
//   service      exact match
//   level        one of debug/info/warn/error
//   since        ISO 8601, inclusive start
//   until        ISO 8601, exclusive end (must be after `since`)
//   attr.<key>   attribute equality, compared as strings
//   q            case-insensitive substring on message
//
// list-only concerns (limit, cursor) and aggregate-only concerns
// (bucket, group_by) are validated elsewhere; this file owns only the
// intersection so neither endpoint duplicates it.
//
// Everything here returns a ValidationResult rather than throwing, so
// a bad parameter becomes a clean 400 with { error: reason } at the
// route, per §7's invalid-parameter contract.

import {
  type AttributeFilter,
  type QueryFilters,
  type ValidationResult,
} from '../types.js';
import { encodeLevel, isLogLevel } from '../levels.js';

// -----------------------------------------------------------------
// Limits -- defensive bounds on filter inputs. A filter that never
// matches is harmless, but an unbounded pattern or key count invites
// pathological queries, so we cap them.
// -----------------------------------------------------------------

const MAX_SERVICE_LENGTH = 512;
const MAX_Q_LENGTH = 1024;
const MAX_ATTR_KEY_LENGTH = 128;
const MAX_ATTR_VALUE_LENGTH = 1024;
const MAX_ATTR_FILTERS = 32;

// Attribute-key allow-list. Even though the key travels inside a JSONB
// parameter (never concatenated into SQL), we still constrain its
// shape as defense in depth and to reject obvious garbage early. This
// is the "validate dynamic identifiers against a regex allow-list"
// rule described in README.md, applied at the earliest possible point.
const ATTR_KEY_RE = /^[A-Za-z0-9_.\-]{1,128}$/;

const ATTR_PREFIX = 'attr.';

// -----------------------------------------------------------------
// ISO 8601 parsing -- same strict gate used for ingest timestamps.
// A regex catches shape errors that JS's lenient parser would silently
// normalize (e.g. rolling Feb 30 into March), then Date.parse plus a
// NaN check catches the rest. Unlike ingest, there is no future-skew
// rule here: querying a future range is legitimate (it just returns
// nothing).
// -----------------------------------------------------------------

const ISO_8601 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

function parseIso8601(value: string): Date | null {
  if (!ISO_8601.test(value)) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return new Date(ms);
}

// -----------------------------------------------------------------
// Query-string value helpers
// -----------------------------------------------------------------
//
// Fastify's default parser turns duplicate keys (?service=a&service=b)
// into an array. A single-valued filter given twice is ambiguous, so
// we reject it rather than silently pick one. Returns:
//   undefined  -> parameter absent
//   string     -> exactly one value present
//   the DUP symbol -> present more than once (caller rejects)

const DUP = Symbol('duplicate');

function singleValue(raw: unknown): string | undefined | typeof DUP {
  if (raw === undefined) return undefined;
  if (typeof raw === 'string') return raw;
  // Array (duplicate keys) or any non-string shape is ambiguous.
  return DUP;
}

// -----------------------------------------------------------------
// Public entry point
// -----------------------------------------------------------------

/**
 * Validate the shared query filters. Never throws.
 *
 * @param query  The parsed query-string object from Fastify. Keys map
 *               to string (single) or string[] (repeated); attr.<key>
 *               keys carry the literal dotted name.
 */
export function validateFilters(
  query: Record<string, unknown>,
): ValidationResult<QueryFilters> {
  let service: string | undefined;
  let level: QueryFilters['level'];
  let since: Date | undefined;
  let until: Date | undefined;
  let q: string | undefined;
  const attributes: AttributeFilter[] = [];

  // ---- service (exact match) ----
  const rawService = singleValue(query['service']);
  if (rawService === DUP) {
    return { ok: false, reason: "'service' must be a single value" };
  }
  if (rawService !== undefined) {
    if (rawService.length === 0) {
      return { ok: false, reason: "'service' must be a non-empty string" };
    }
    if (rawService.length > MAX_SERVICE_LENGTH) {
      return { ok: false, reason: "'service' filter is too long" };
    }
    service = rawService;
  }

  // ---- level (one of the four names) ----
  const rawLevel = singleValue(query['level']);
  if (rawLevel === DUP) {
    return { ok: false, reason: "'level' must be a single value" };
  }
  if (rawLevel !== undefined) {
    if (!isLogLevel(rawLevel)) {
      return { ok: false, reason: `invalid level: '${rawLevel}'` };
    }
    level = encodeLevel(rawLevel);
  }

  // ---- since (inclusive start) ----
  const rawSince = singleValue(query['since']);
  if (rawSince === DUP) {
    return { ok: false, reason: "'since' must be a single value" };
  }
  if (rawSince !== undefined) {
    const parsed = parseIso8601(rawSince);
    if (parsed === null) {
      return { ok: false, reason: `invalid since timestamp: '${rawSince}'` };
    }
    since = parsed;
  }

  // ---- until (exclusive end) ----
  const rawUntil = singleValue(query['until']);
  if (rawUntil === DUP) {
    return { ok: false, reason: "'until' must be a single value" };
  }
  if (rawUntil !== undefined) {
    const parsed = parseIso8601(rawUntil);
    if (parsed === null) {
      return { ok: false, reason: `invalid until timestamp: '${rawUntil}'` };
    }
    until = parsed;
  }

  // ---- until must be strictly after since (§8) ----
  // Only checkable when both are present; aggregate enforces presence
  // of both separately.
  if (since !== undefined && until !== undefined) {
    if (until.getTime() <= since.getTime()) {
      return { ok: false, reason: "'until' must be after 'since'" };
    }
  }

  // ---- q (case-insensitive substring on message) ----
  const rawQ = singleValue(query['q']);
  if (rawQ === DUP) {
    return { ok: false, reason: "'q' must be a single value" };
  }
  if (rawQ !== undefined && rawQ.length > 0) {
    // An empty q would mean "match everything", i.e. no filter at all,
    // so we drop it rather than emit a useless ILIKE '%%'.
    if (rawQ.length > MAX_Q_LENGTH) {
      return { ok: false, reason: "'q' filter is too long" };
    }
    q = rawQ;
  }

  // ---- attr.<key> equality filters ----
  for (const rawKey of Object.keys(query)) {
    if (!rawKey.startsWith(ATTR_PREFIX)) continue;

    const key = rawKey.slice(ATTR_PREFIX.length);
    if (!ATTR_KEY_RE.test(key)) {
      return {
        ok: false,
        reason: `invalid attribute key: '${key}'`,
      };
    }
    if (key.length > MAX_ATTR_KEY_LENGTH) {
      return { ok: false, reason: `attribute key too long: '${key}'` };
    }

    const rawValue = singleValue(query[rawKey]);
    if (rawValue === DUP) {
      return {
        ok: false,
        reason: `attribute filter '${rawKey}' must be a single value`,
      };
    }
    if (rawValue === undefined) {
      // Key present in Object.keys but value undefined shouldn't happen
      // for a real query string; skip defensively rather than crash.
      continue;
    }
    if (rawValue.length > MAX_ATTR_VALUE_LENGTH) {
      return {
        ok: false,
        reason: `attribute value for '${rawKey}' is too long`,
      };
    }

    attributes.push({ key, value: rawValue });
    if (attributes.length > MAX_ATTR_FILTERS) {
      return {
        ok: false,
        reason: `too many attribute filters (max ${MAX_ATTR_FILTERS})`,
      };
    }
  }

  return {
    ok: true,
    value: { service, level, since, until, attributes, q },
  };
}

// -----------------------------------------------------------------
// limit -- list-only, but a query-parameter validation concern, so it
// lives in the core layer beside the shared filters rather than in the
// HTTP route.
// -----------------------------------------------------------------

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

// Strict integer form: reject "100.5", "1e3", " 100", "-5", "0x10".
const INTEGER_RE = /^\d+$/;

/**
 * Validate the `limit` query parameter for GET /logs.
 * Absent -> default 100. Present -> must be an integer in [1, 1000].
 */
export function validateLimit(raw: unknown): ValidationResult<number> {
  const value = singleValue(raw);
  if (value === DUP) {
    return { ok: false, reason: "'limit' must be a single value" };
  }
  if (value === undefined) {
    return { ok: true, value: DEFAULT_LIMIT };
  }
  if (!INTEGER_RE.test(value)) {
    return { ok: false, reason: `invalid limit: '${value}'` };
  }
  const n = Number.parseInt(value, 10);
  if (n < 1 || n > MAX_LIMIT) {
    return {
      ok: false,
      reason: `limit out of range: ${n} (must be 1..${MAX_LIMIT})`,
    };
  }
  return { ok: true, value: n };
}
