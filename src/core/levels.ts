// src/core/levels.ts
//
// Encoding and decoding between the wire representation of a log
// level ('debug' | 'info' | 'warn' | 'error') and its storage
// representation (SMALLINT 0..3). Per DESIGN.md §9, this mapping
// lives strictly in the core layer -- routes and SQL touch the
// numeric form only, so they never need to know the string names.
//
// Hot-path characteristics:
//   - encodeLevel runs once per accepted log entry (~15,000/sec target)
//   - decodeLevel runs once per returned row (up to 1,000 per query)
// Both must be O(1) and allocation-free. A precomputed object lookup
// satisfies both; indexOf would be O(n) and less explicit.

import { LOG_LEVELS, type LogLevel, type LogLevelCode } from './types.js';

// Explicit lookup table. Written out longhand deliberately -- a
// derived version (Object.fromEntries + cast) would compile even if
// someone reordered LOG_LEVELS, silently corrupting all subsequent
// writes. The runtime check below catches that class of mistake.
const NAME_TO_CODE: Readonly<Record<LogLevel, LogLevelCode>> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// Load-time invariant: the encoding table and the source-of-truth
// array must agree on the ordering. If they diverge (someone edits
// one file but not the other), the process fails immediately at
// startup with a clear message -- not silently at the first INSERT.
for (let i = 0; i < LOG_LEVELS.length; i++) {
  const name = LOG_LEVELS[i]!;
  if (NAME_TO_CODE[name] !== i) {
    throw new Error(
      `Log level encoding is out of sync: LOG_LEVELS[${i}] = '${name}' ` +
        `but NAME_TO_CODE['${name}'] = ${NAME_TO_CODE[name]}. ` +
        `Fix src/core/levels.ts to match src/core/types.ts.`,
    );
  }
}

/**
 * Convert a level name to its SMALLINT storage code.
 * Called on every accepted log entry before insert.
 */
export function encodeLevel(name: LogLevel): LogLevelCode {
  return NAME_TO_CODE[name];
}

/**
 * Convert a SMALLINT storage code back to its wire name.
 * Called on every row returned from a query.
 *
 * Throws on an out-of-range code rather than returning undefined.
 * That state should be impossible given the type constraint, but if
 * a manually-inserted row bypasses our writer, we want to fail the
 * request loudly instead of returning `{ level: undefined }` to a
 * client that trusts our response shape.
 */
export function decodeLevel(code: LogLevelCode): LogLevel {
  const name = LOG_LEVELS[code];
  if (name === undefined) {
    throw new Error(`Unknown log level code from database: ${code}`);
  }
  return name;
}

/**
 * Runtime type guard used by input validators to check whether a
 * caller-supplied string is one of the four accepted level names.
 * Kept separate from encodeLevel: validators check first, writers
 * encode after -- the two responsibilities never overlap.
 */
export function isLogLevel(value: unknown): value is LogLevel {
  return (
    typeof value === 'string' &&
    (LOG_LEVELS as readonly string[]).includes(value)
  );
}
