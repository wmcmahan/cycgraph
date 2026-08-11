/**
 * Structured Logger for @cycgraph/orchestrator
 *
 * Production-grade JSON logging with log levels, async context correlation,
 * and structured error serialization.
 *
 * Output format: one JSON object per line to `stdout` (debug/info) or
 * `stderr` (warn/error), compatible with all major log aggregators.
 *
 * @module observability/logger
 */

import { getCurrentContext } from '../utils/context.js';

/** Supported log levels in increasing severity order. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Arbitrary structured metadata attached to a log entry. */
interface LogContext {
  [key: string]: unknown;
}

/** Shape of a single JSON log line. */
interface LogEntry {
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** Severity level. */
  level: LogLevel;
  /** Dot-delimited event name (e.g. `"runner.graph.started"`). */
  event: string;
  /** Merged context: run context + default context + per-call context. */
  context?: LogContext;
}

/** Numeric priority for level filtering. */
const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Structured JSON logger.
 *
 * Each instance is scoped to a component name (used as a prefix for
 * event names). Child loggers inherit and extend the default context.
 */
export class Logger {
  private readonly minLevel: LogLevel;
  private readonly defaultContext: LogContext;

  constructor(
    private readonly component: string,
    options?: { level?: LogLevel; context?: LogContext },
  ) {
    // An unrecognized LOG_LEVEL (typo, empty string) must fall back to 'info',
    // not become the min level — an unknown level has no priority, which would
    // disable filtering entirely and emit debug noise in production.
    const envLevel = process.env.LOG_LEVEL;
    const validEnvLevel = envLevel && envLevel in LOG_LEVEL_PRIORITY
      ? (envLevel as LogLevel)
      : undefined;
    this.minLevel = options?.level ?? validEnvLevel ?? 'info';
    this.defaultContext = options?.context ?? {};
  }

  /**
   * Create a child logger with additional default context.
   *
   * The child inherits this logger's component name and minimum level.
   *
   * @param context - Additional context merged into every log entry.
   */
  child(context: LogContext): Logger {
    return new Logger(this.component, {
      level: this.minLevel,
      context: { ...this.defaultContext, ...context },
    });
  }

  /** Log a debug-level event. */
  debug(event: string, context?: LogContext): void {
    this.log('debug', event, context);
  }

  /** Log an info-level event. */
  info(event: string, context?: LogContext): void {
    this.log('info', event, context);
  }

  /** Log a warn-level event. */
  warn(event: string, context?: LogContext): void {
    this.log('warn', event, context);
  }

  /**
   * Log an error-level event with optional error object.
   *
   * Error objects are serialized to `{ message, name, stack }` and
   * nested under the `error` key in the context.
   *
   * @param event - Event name.
   * @param error - Error object or unknown value.
   * @param context - Additional structured context.
   */
  error(event: string, error?: Error | unknown, context?: LogContext): void {
    const errorInfo = error instanceof Error
      ? { message: error.message, name: error.name, stack: error.stack }
      : error
        ? { message: String(error), name: 'UnknownError' }
        : undefined;

    this.log('error', event, { ...context, ...(errorInfo ? { error: errorInfo } : {}) });
  }

  /**
   * Core log writer.
   *
   * Merges contexts (run → default → per-call), constructs the JSON
   * entry, and writes to the appropriate stream.
   */
  private log(level: LogLevel, event: string, context?: LogContext): void {
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this.minLevel]) {
      return;
    }

    const runCtx = getCurrentContext();
    const mergedContext = { ...runCtx, ...this.defaultContext, ...context };
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      event: `${this.component}.${event}`,
      ...(Object.keys(mergedContext).length > 0 ? { context: mergedContext } : {}),
    };

    const output = JSON.stringify(entry);

    if (level === 'error' || level === 'warn') {
      process.stderr.write(output + '\n');
    } else {
      process.stdout.write(output + '\n');
    }
  }
}

/**
 * Create a logger for a component.
 *
 * @param component - Dot-delimited component name (e.g. `"runner.graph"`).
 * @param context - Optional default context for every log entry.
 * @returns A new {@link Logger} instance.
 */
export function createLogger(component: string, context?: LogContext): Logger {
  return new Logger(component, { context });
}
