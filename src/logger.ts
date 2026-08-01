/**
 * Minimal structured logger. One JSON object per line on stdout.
 * No dependency, no transport, no buffering. Operators pipe stdout to their
 * collector of choice.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export interface Logger {
  readonly level: LogLevel;
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

function safeFields(fields: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!fields) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'bigint') out[key] = value.toString();
    else if (value instanceof Error) out[key] = { name: value.name, message: value.message };
    else out[key] = value;
  }
  return out;
}

export function createLogger(level: LogLevel = 'info', bindings: Record<string, unknown> = {}): Logger {
  const threshold = LEVEL_ORDER[level];

  const emit = (lineLevel: Exclude<LogLevel, 'silent'>, message: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[lineLevel] < threshold) return;
    const line = JSON.stringify({
      time: new Date().toISOString(),
      level: lineLevel,
      message,
      ...bindings,
      ...safeFields(fields),
    });
    process.stdout.write(`${line}\n`);
  };

  return {
    level,
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    child: (extra) => createLogger(level, { ...bindings, ...extra }),
  };
}

export const nullLogger: Logger = createLogger('silent');
