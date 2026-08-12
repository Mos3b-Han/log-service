// src/core/types.ts
//
// Shared data types for the core layer. Pure declarations only:
// no I/O, no imports from http/ or db/, no runtime dependencies.
// Every module that describes what a log "is" or what a validation
// "returns" imports from here.
//
// Only the types needed by phases 2-3 (ingest path) live here for
// now. Query filters, cursors, aggregate buckets, and DB row shapes
// arrive alongside their first consumer in later phases.

// ---------------------------------------------------------------
// Log levels
// ---------------------------------------------------------------

// The four accepted level names, in ascending severity order.
// The order also defines the SMALLINT encoding used in the DB:
//   debug -> 0, info -> 1, warn -> 2, error -> 3
// Both encoding functions (in levels.ts) and the "invalid level"
// rejection message (in validateEntry.ts) derive from this single
// array, so the source of truth is here.
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

// SMALLINT storage form. Constrained to 0..3 to prevent accidental
// insertion of an out-of-range code from anywhere in the codebase.
export type LogLevelCode = 0 | 1 | 2 | 3;

// ---------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------

// What the client is allowed to send inside `attributes`. The spec
// (§8) explicitly forbids nested objects and arrays; validation
// enforces the flatness at runtime.
export type RawAttributeValue = string | number | boolean;
export type RawAttributes = Readonly<Record<string, RawAttributeValue>>;

// What we actually store. Per the design brief (§10), every value
// is coerced to a string at ingest time so that JSONB `@>` equality
// filters work uniformly regardless of the original JS type. Keeping
// the two names distinct forces the type system to remind the writer
// that normalization must happen -- a plain `Attributes` would let a
// raw number slip through unnoticed.
export type NormalizedAttributes = Readonly<Record<string, string>>;

// ---------------------------------------------------------------
// Log entry (post-validation, pre-insert)
// ---------------------------------------------------------------

// The canonical shape of a validated, normalized log entry, ready
// for the writer to hand to Postgres.
//
// Notes on the fields:
//   - `timestamp` is a Date, not an ISO string. The validator parses
//     once; nobody downstream should re-parse.
//   - `level` is the numeric code, not the string. The name is only
//     for I/O boundaries; the writer, indexes, and hot path all use
//     the SMALLINT form.
//   - `id` is deliberately absent -- Postgres assigns it via
//     BIGSERIAL when the row lands.
export interface LogEntry {
  readonly timestamp: Date;
  readonly level: LogLevelCode;
  readonly service: string;
  readonly message: string;
  readonly attributes: NormalizedAttributes;
}

// ---------------------------------------------------------------
// Validation result
// ---------------------------------------------------------------

// A tagged-union result type for validation. Preferred over throwing
// deliberately, not by accident: throwing on every bad entry
// in a 5,000-entry batch is expensive and awkward to accumulate.
// The `ok` discriminant lets callers narrow with a single `if`.
export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

// One rejected entry in a batch response. The `index` refers to the
// entry's position in the original request `logs` array, per §7.
export interface RejectedEntry {
  readonly index: number;
  readonly reason: string;
}

// Output of validating a whole batch. Consumed directly by the
// ingest route to build the `{ accepted, rejected }` response body:
// `accepted` in the response is `accepted.length` here.
export interface BatchValidationResult {
  readonly accepted: readonly LogEntry[];
  readonly rejected: readonly RejectedEntry[];
}

// ---------------------------------------------------------------
// Query filters (read path)
// ---------------------------------------------------------------

// One `attr.<key>=<value>` equality filter. Values are compared as
// strings, matching how attributes are stored (see NormalizedAttributes
// and §10). Multiple attribute filters are ANDed together; the db
// layer merges them into a single JSONB `@>` containment object so the
// GIN index handles any number of keys in one operation.
export interface AttributeFilter {
  readonly key: string;
  readonly value: string;
}

// The validated, normalized filter set shared by GET /logs and
// GET /logs/aggregate. Produced by core/validation/validateFilters and
// consumed by db/query/filters to build a parameterized WHERE clause.
//
// Field notes:
//   - `level` is the SMALLINT code, not the name: the WHERE clause
//     filters on the stored numeric form directly.
//   - `since` / `until` are Date objects, parsed once here so the db
//     layer never re-parses. `since` is inclusive, `until` exclusive
//     (enforced when the SQL is built, not here).
//   - `attributes` is always an array (possibly empty), never
//     undefined, so consumers iterate without a null check.
export interface QueryFilters {
  readonly service?: string;
  readonly level?: LogLevelCode;
  readonly since?: Date;
  readonly until?: Date;
  readonly attributes: readonly AttributeFilter[];
  readonly q?: string;
}

// ---------------------------------------------------------------
// Pagination cursor
// ---------------------------------------------------------------

// The decoded logical content of a keyset-pagination cursor: the
// (timestamp, id) of the last row on the previous page. The next page
// selects rows strictly "before" this point under the DESC ordering.
//
//   - `id` is kept as a string, not a number: it is a BIGSERIAL that
//     can exceed JS's safe-integer range, and pg returns BIGINT as a
//     string. Keeping it a string avoids precision loss and passes
//     straight through as a query parameter.
//   - `timestamp` is a Date, reconstructed from the cursor's ISO form.
export interface Cursor {
  readonly timestamp: Date;
  readonly id: string;
}

// ---------------------------------------------------------------
// API output row
// ---------------------------------------------------------------

// One log row in the GET /logs response, shaped exactly as §7 requires
// so the route can serialize it straight to JSON. This is the wire
// form, distinct from LogEntry (the pre-insert form) and from the raw
// pg row: `timestamp` is an ISO 8601 string, `level` is the name, and
// `id` is a string.
export interface LogRow {
  readonly id: string;
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly service: string;
  readonly message: string;
  readonly attributes: Record<string, string>;
}

// ---------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------

// The dimension GET /logs/aggregate can group by (§7). Absence of a
// group_by means a single ungrouped series (group is null in output).
export type GroupByDimension = 'service' | 'level';

// One row in the GET /logs/aggregate response, shaped exactly as §7:
//   - `start` is the bucket's start instant as an ISO 8601 string
//   - `group` is the grouped value (service name or level name), or
//     null when no group_by was requested
//   - `count` is a number (the db layer converts pg's BIGINT string)
export interface AggregateBucket {
  readonly start: string;
  readonly group: string | null;
  readonly count: number;
}
