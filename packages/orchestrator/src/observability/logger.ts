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

/** Supported log levels in increasing severity order. `silent` emits nothing. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

/** Arbitrary structured metadata attached to a log entry. */
export interface LogContext {
  [key: string]: unknown;
}

/**
 * Receives every entry the engine would otherwise write to a process stream.
 *
 * A function, not an object with `.info()` / `.warn()` methods: the engine has
 * already resolved the level and built the entry by the time this is called.
 * Adapting to a host logger is a one-liner:
 *
 * ```ts
 * const logger: LogSink = (e) => pino[e.level](e.context, e.event);
 * ```
 *
 * Called after level filtering, so `LOG_LEVEL` governs it exactly as it governs
 * stdout. Failures are swallowed, and a returned promise is not awaited: a
 * logging transport must not fail a workflow or add latency to every node.
 */
export type LogSink = (entry: LogEntry) => void;

/** Shape of a single JSON log line. */
export interface LogEntry {
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** Severity level. */
  level: LogLevel;
  /** Dot-delimited event name (e.g. `"runner.graph.started"`). */
  event: string;
  /** Merged context: run context + default context + per-call context. */
  context?: LogContext;
}

/**
 * The env-derived default, resolved on first use rather than at import.
 *
 * Every logger in the engine is a module-level constant, so reading
 * `LOG_LEVEL` in the constructor would freeze it before an application that
 * loads its environment with dotenv has had a chance to set it. Resolving
 * lazily means the variable works whenever it is set, and the read still
 * happens once per process.
 */
let cachedDefaultLevel: LogLevel | undefined;

function defaultLevel(): LogLevel {
  if (cachedDefaultLevel) return cachedDefaultLevel;
  const env = process.env.LOG_LEVEL;
  // An unrecognized value (typo, empty string) falls back rather than becoming
  // the min level: an unknown level has no priority, which would disable
  // filtering entirely and emit debug noise.
  cachedDefaultLevel = env && env in LOG_LEVEL_PRIORITY ? (env as LogLevel) : 'error';
  return cachedDefaultLevel;
}

/** Reset the cached level. Tests only. @internal */
export function resetLogLevelCache(): void {
  cachedDefaultLevel = undefined;
}

/** Numeric priority for level filtering. */
const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

/**
 * Structured JSON logger.
 *
 * Each instance is scoped to a component name (used as a prefix for
 * event names). Child loggers inherit and extend the default context.
 */
export class Logger {
  /** Set only when a caller passed one; otherwise the env default applies. */
  private readonly explicitLevel?: LogLevel;
  private readonly defaultContext: LogContext;

  constructor(
    private readonly component: string,
    options?: { level?: LogLevel; context?: LogContext },
  ) {
    this.explicitLevel = options?.level;
    this.defaultContext = options?.context ?? {};
  }

  /**
   * Create a child logger with additional default context.
   *
   * The child inherits this logger's component name and level. An inherited
   * level stays unset when the parent had none, so the child keeps following
   * the env default rather than pinning to whatever it resolved to.
   *
   * @param context - Additional context merged into every log entry.
   */
  child(context: LogContext): Logger {
    return new Logger(this.component, {
      ...(this.explicitLevel ? { level: this.explicitLevel } : {}),
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
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this.explicitLevel ?? defaultLevel()]) {
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

    // A sink installed for this run takes the entry instead of the process
    // streams. A host that wants both writes to stdout from inside its sink.
    if (runCtx.logger) {
      try {
        runCtx.logger(entry);
      } catch {
        // A failing transport is not a reason to fail the workflow. Reported
        // once here rather than swallowed silently, then execution continues.
        process.stderr.write(
          JSON.stringify({ timestamp: entry.timestamp, level: 'error', event: 'logger.sink_failed' }) + '\n',
        );
      }
      return;
    }

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
