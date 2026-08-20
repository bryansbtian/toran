import { pino, type Logger as PinoLogger } from 'pino';
import { redact } from './redaction.js';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/**
 * Fields Toran attaches to log lines. Everything here is safe: identifiers are
 * database ids or opaque correlation ids, never tokens or credentials.
 */
export interface LogFields {
  readonly requestId?: string;
  readonly route?: string;
  readonly method?: string;
  readonly statusCode?: number;
  readonly durationMs?: number;
  readonly jobId?: string;
  readonly jobType?: string;
  readonly fileId?: string;
  readonly shareLinkId?: string;
  readonly errorCategory?: string;
  readonly retryCount?: number;
  readonly workerId?: string;
  readonly [key: string]: unknown;
}

export interface Logger {
  trace(fields: LogFields, message: string): void;
  debug(fields: LogFields, message: string): void;
  info(fields: LogFields, message: string): void;
  warn(fields: LogFields, message: string): void;
  error(fields: LogFields, message: string): void;
  fatal(fields: LogFields, message: string): void;
  child(fields: LogFields): Logger;
}

export interface CreateLoggerOptions {
  readonly level: LogLevel;
  readonly service: string;
  /** Pretty-printing is never enabled: production wants parseable JSON. */
  readonly destination?: NodeJS.WritableStream;
  readonly base?: LogFields;
}

class PinoAdapter implements Logger {
  constructor(private readonly inner: PinoLogger) {}

  trace(fields: LogFields, message: string): void {
    this.inner.trace(redact(fields) as object, message);
  }
  debug(fields: LogFields, message: string): void {
    this.inner.debug(redact(fields) as object, message);
  }
  info(fields: LogFields, message: string): void {
    this.inner.info(redact(fields) as object, message);
  }
  warn(fields: LogFields, message: string): void {
    this.inner.warn(redact(fields) as object, message);
  }
  error(fields: LogFields, message: string): void {
    this.inner.error(redact(fields) as object, message);
  }
  fatal(fields: LogFields, message: string): void {
    this.inner.fatal(redact(fields) as object, message);
  }
  child(fields: LogFields): Logger {
    return new PinoAdapter(this.inner.child(redact(fields) as object));
  }
}

/** Structured JSON logger. One line per event, no ANSI, no multi-line output. */
export function createLogger(options: CreateLoggerOptions): Logger {
  const inner = pino(
    {
      level: options.level,
      base: { service: options.service, ...(options.base ?? {}) },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level: (label) => ({ level: label }),
      },
      // Second layer of protection: even if a call site bypasses `redact`.
      redact: {
        paths: [
          'password',
          '*.password',
          'token',
          '*.token',
          'authorization',
          '*.authorization',
          'headers.authorization',
          'headers.cookie',
        ],
        censor: '[redacted]',
      },
    },
    options.destination,
  );
  return new PinoAdapter(inner);
}

/** Discards everything. Used in tests that are not asserting on logs. */
export function createNullLogger(): Logger {
  const noop = (): void => {};
  const logger: Logger = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => logger,
  };
  return logger;
}

/** Collects log records so tests can assert nothing sensitive was written. */
export function createTestLogger(): {
  logger: Logger;
  records: Array<[string, LogFields, string]>;
} {
  const records: Array<[string, LogFields, string]> = [];
  const make = (base: LogFields): Logger => {
    const at =
      (level: string) =>
      (fields: LogFields, message: string): void => {
        records.push([level, redact({ ...base, ...fields }) as LogFields, message]);
      };
    return {
      trace: at('trace'),
      debug: at('debug'),
      info: at('info'),
      warn: at('warn'),
      error: at('error'),
      fatal: at('fatal'),
      child: (fields) => make({ ...base, ...fields }),
    };
  };
  return { logger: make({}), records };
}
