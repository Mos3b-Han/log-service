
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogLevelCode = 0 | 1 | 2 | 3;

export type RawAttributeValue = string | number | boolean;
export type RawAttributes = Readonly<Record<string, RawAttributeValue>>;

export type NormalizedAttributes = Readonly<Record<string, string>>;

export interface LogEntry {
  readonly timestamp: Date;
  readonly level: LogLevelCode;
  readonly service: string;
  readonly message: string;
  readonly attributes: NormalizedAttributes;
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

export interface RejectedEntry {
  readonly index: number;
  readonly reason: string;
}

export interface BatchValidationResult {
  readonly accepted: readonly LogEntry[];
  readonly rejected: readonly RejectedEntry[];
}

export interface AttributeFilter {
  readonly key: string;
  readonly value: string;
}

export interface QueryFilters {
  readonly service?: string;
  readonly level?: LogLevelCode;
  readonly since?: Date;
  readonly until?: Date;
  readonly attributes: readonly AttributeFilter[];
  readonly q?: string;
}

export interface Cursor {
  readonly timestamp: Date;
  readonly id: string;
}

export interface LogRow {
  readonly id: string;
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly service: string;
  readonly message: string;
  readonly attributes: Record<string, string>;
}

export type GroupByDimension = 'service' | 'level';

export interface AggregateBucket {
  readonly start: string;
  readonly group: string | null;
  readonly count: number;
}
