// src/core/validation/validateBatch.ts
//
// Validate the top-level shape of a POST /logs body -- { logs: [...] } --
// and dispatch each entry to validateEntry. This file owns two things:
//
//   1. The distinction between "the request body itself is malformed"
//      (route responds 400 with { error }) and "the body was valid
//      but individual entries had problems" (route responds 200 with
//      { accepted, rejected } or 400 if nothing was accepted).
//
//   2. Computing `Date.now()` exactly once per batch, before the entry
//      loop. Per CLAUDE.md §11, calling Date.now() inside a 5,000-entry
//      loop is a documented anti-pattern; validateEntry accepts `now`
//      as a parameter for precisely this reason.
//
// This file performs no I/O, imports nothing from http/ or db/, and
// never throws on invalid input -- consistent with the core layer's
// contract in CLAUDE.md §4.

import { validateEntry } from './validateEntry.js';
import {
  type BatchValidationResult,
  type LogEntry,
  type RejectedEntry,
} from '../types.js';

// From CLAUDE.md §8. Enforced pre-loop, so an abusive 1M-entry batch
// is rejected before we allocate a validator result for each one.
const MAX_BATCH_SIZE = 5_000;

/**
 * Outcome of validating a full POST /logs body.
 *
 *   { ok: false, reason }
 *      The body itself is malformed: not an object, `logs` missing or
 *      not an array, empty array, or above the size limit. The route
 *      responds 400 with `{ error: reason }`.
 *
 *   { ok: true, result: { accepted, rejected } }
 *      The body was parseable and per-entry verdicts are populated.
 *      The route inspects `result.accepted.length`:
 *        > 0   -> 200 with { accepted: N, rejected: [...] }
 *        == 0  -> 400 (spec §7: "all entries rejected")
 */
export type BatchOutcome =
  | { readonly ok: false; readonly reason: string }
  | { readonly ok: true; readonly result: BatchValidationResult };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value)
  );
}

/**
 * Validate a full request body. Never throws.
 *
 * @param rawBody  The parsed JSON body from the HTTP request. May be
 *                 anything -- the caller has not inspected it yet.
 */
export function validateBatch(rawBody: unknown): BatchOutcome {
  if (!isPlainObject(rawBody)) {
    return { ok: false, reason: 'request body must be a JSON object' };
  }

  const logs = rawBody['logs'];
  if (!Array.isArray(logs)) {
    return { ok: false, reason: "'logs' must be an array" };
  }
  if (logs.length === 0) {
    // §8: "If `logs` is empty or missing, return 400". Missing was
    // handled by the isArray check above; this covers the empty case.
    return { ok: false, reason: "'logs' must contain at least one entry" };
  }
  if (logs.length > MAX_BATCH_SIZE) {
    return {
      ok: false,
      reason: `batch too large: ${logs.length} entries (max ${MAX_BATCH_SIZE})`,
    };
  }

  // Compute wall time ONCE per batch. Every validateEntry call reuses
  // this value. CLAUDE.md §11 lists Date.now() inside a per-entry loop
  // as an explicit anti-pattern; the cost is small per call but the
  // discipline is what keeps hot paths honest.
  const now = Date.now();

  const accepted: LogEntry[] = [];
  const rejected: RejectedEntry[] = [];

  // Single-pass loop, in-place push into two output arrays. No
  // filter/map chain -- that would allocate an intermediate array of
  // ValidationResult objects the size of the batch, then throw it
  // away. The direct loop touches each entry exactly once.
  for (let i = 0; i < logs.length; i++) {
    const result = validateEntry(logs[i], now);
    if (result.ok) {
      accepted.push(result.value);
    } else {
      rejected.push({ index: i, reason: result.reason });
    }
  }

  return { ok: true, result: { accepted, rejected } };
}
