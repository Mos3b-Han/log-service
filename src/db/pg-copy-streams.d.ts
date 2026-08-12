
declare module 'pg-copy-streams' {
  import { Writable } from 'node:stream';
  import { Submittable } from 'pg';

  
  export interface CopyStreamQuery extends Writable, Submittable {}

  export function from(sqlText: string): CopyStreamQuery;
}
