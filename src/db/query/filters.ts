
import { type Cursor, type QueryFilters } from '../../core/types.js';



export interface ParamAccumulator {
  add(value: unknown): string;
 
  readonly values: unknown[];
}

export function createParams(): ParamAccumulator {
  const values: unknown[] = [];
  return {
    add(value: unknown): string {
      values.push(value);
      return '$' + values.length;
    },
    values,
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

export function filterConditions(
  filters: QueryFilters,
  params: ParamAccumulator,
): string[] {
  const conditions: string[] = [];

  if (filters.service !== undefined) {
    conditions.push(`service = ${params.add(filters.service)}`);
  }

  if (filters.level !== undefined) {
    conditions.push(`level = ${params.add(filters.level)}`);
  }

  if (filters.since !== undefined) {
    conditions.push(`"timestamp" >= ${params.add(filters.since)}`);
  }

  if (filters.until !== undefined) {
    conditions.push(`"timestamp" < ${params.add(filters.until)}`);
  }

  if (filters.attributes.length > 0) {
    const containment: Record<string, string> = {};
    for (const attr of filters.attributes) {
      containment[attr.key] = attr.value;
    }
    conditions.push(
      `attributes @> ${params.add(JSON.stringify(containment))}::jsonb`,
    );
  }

  if (filters.q !== undefined) {
    const pattern = '%' + escapeLike(filters.q) + '%';
    conditions.push(`message ILIKE ${params.add(pattern)} ESCAPE '\\'`);
  }

  return conditions;
}

export function keysetCondition(
  cursor: Cursor,
  params: ParamAccumulator,
): string {
  const ts = params.add(cursor.timestamp);
  const id = params.add(cursor.id);
  return `("timestamp", id) < (${ts}::timestamptz, ${id}::bigint)`;
}

export function whereClause(conditions: readonly string[]): string {
  return conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
}
