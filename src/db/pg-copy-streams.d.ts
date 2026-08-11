// src/db/pg-copy-streams.d.ts
//
// The pg-copy-streams package (v6.0.6) does not ship TypeScript types
// and no @types/pg-copy-streams exists on npm. Rather than adding
// another dependency for a single import surface we control, this
// file declares only what writer.ts actually calls -- the `from`
// factory that returns a Writable stream accepting COPY text data.
//
// Kept intentionally minimal: if we later use `pg-copy-streams`
// features beyond `from(sql)`, extend this file rather than pulling
// a broader third-party definition.

declare module 'pg-copy-streams' {
  import { Writable } from 'node:stream';
  import { Submittable } from 'pg';

  // The stream returned by `from()` is dual-purpose: it satisfies
  // pg's `Submittable` interface (so client.query() accepts it as a
  // custom query) AND is a Node Writable (so we pipe COPY payload
  // into it). Both facets are needed together at the call site.
  export interface CopyStreamQuery extends Writable, Submittable {}

  /**
   * Returns a stream for `COPY ... FROM STDIN`. Pass the raw SQL,
   * hand the stream to `client.query()` to activate it, then write
   * the COPY payload into it as a Writable.
   */
  export function from(sqlText: string): CopyStreamQuery;
}
