

import { LOG_LEVELS, type LogLevel, type LogLevelCode } from './types.js';


const NAME_TO_CODE: Readonly<Record<LogLevel, LogLevelCode>> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};


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

export function encodeLevel(name: LogLevel): LogLevelCode {
  return NAME_TO_CODE[name];
}

export function decodeLevel(code: LogLevelCode): LogLevel {
  const name = LOG_LEVELS[code];
  if (name === undefined) {
    throw new Error(`Unknown log level code from database: ${code}`);
  }
  return name;
}

export function isLogLevel(value: unknown): value is LogLevel {
  return (
    typeof value === 'string' &&
    (LOG_LEVELS as readonly string[]).includes(value)
  );
}
