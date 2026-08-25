/**
 * The serve-side watcher: the watch tick on a debounced clock
 *
 * `play watch` is the one-shot; this wraps it in the trigger policy a
 * long-lived dashboard can offer: every run the dashboard completes bumps a
 * counter, a full batch schedules a tick, a quiet period flushes a partial
 * one, and nothing measures while a run is in flight — the watcher must
 * never make foreground work contend for the model server.
 *
 * The watcher exists whether or not automatic triggering is on: a manual
 * tick from the page is useful on any dashboard, and `auto` only decides
 * whether completed runs start the clock. Everything it spends is bounded
 * the same way the CLI tick is, and everything it produces lands in the
 * proposal ledger, which is where the page reads it back from.
 *
 * @module server/watcher
 */

import { watchTick } from '../improve/watch.js';
import type { WatchOptions, WatchRow } from '../improve/watch.js';
import type { Catalog } from '../scenarios/catalog.js';
import type { Stack } from '../stack/index.js';

/** Runs completed since the last tick that trigger the next one. */
const DEFAULT_DEBOUNCE_RUNS = 5;

/** Idle time that flushes a partial batch into a tick. */
const DEFAULT_QUIET_MS = 10 * 60 * 1000;

/** How long a deferred tick waits before rechecking for in-flight runs. */
const BUSY_RETRY_MS = 15 * 1000;

/** How long a triggered tick waits, so a burst of runs coalesces into one. */
const COALESCE_MS = 2 * 1000;

/** Options for {@link createWatcher}. */
export interface WatcherOptions {
  /** Whether completed runs trigger ticks. Manual ticks always work. */
  auto: boolean;
  /** Workflows a default tick sweeps. Required unless `tick` is supplied. */
  catalog?: Catalog;
  /** Completed runs per automatic tick. @default 5 */
  debounceRuns?: number;
  /** Idle time that flushes a partial batch. @default 10 minutes */
  quietMs?: number;
  /** Threaded to the tick. */
  minRuns?: number;
  maxForks?: number;
  /** Narration, for the serve log. */
  onLine?: (message: string) => void;
  /** Tick implementation. Injectable so tests never fork anything. */
  tick?: (options: WatchOptions) => Promise<WatchRow[]>;
}

/** What the page reads about the watcher. */
export interface WatcherSnapshot {
  auto: boolean;
  running: boolean;
  /** Completed runs since the last tick. */
  pendingRuns: number;
  /** Dashboard runs currently in flight. */
  activeRuns: number;
  lastTickAt?: string;
  lastRows?: WatchRow[];
  lastError?: string;
}

/** The serve-side watcher handle. */
export interface Watcher {
  snapshot(): WatcherSnapshot;
  noteRunStarted(): void;
  noteRunFinished(): void;
  /**
   * Mark non-corpus work (an apply's editor session) in flight, so ticks
   * defer without the debounce counter moving — it counts runs, and an
   * apply is not one.
   */
  noteWorkStarted(): void;
  noteWorkFinished(): void;
  /** Run a tick now. Rejects while one is already running. */
  tickNow(): Promise<WatchRow[]>;
  close(): void;
}

/** Build the watcher around a stack it does not own. */
export function createWatcher(stack: Stack, options: WatcherOptions): Watcher {
  const debounceRuns = options.debounceRuns ?? DEFAULT_DEBOUNCE_RUNS;
  const quietMs = options.quietMs ?? DEFAULT_QUIET_MS;
  const tick = options.tick
    ?? ((tickOptions: WatchOptions) => watchTick(stack, options.catalog?.scenarios ?? [], tickOptions));

  let running = false;
  let pendingRuns = 0;
  let activeRuns = 0;
  let closed = false;
  let lastTickAt: string | undefined;
  let lastRows: WatchRow[] | undefined;
  let lastError: string | undefined;
  let scheduled: NodeJS.Timeout | undefined;
  let quietTimer: NodeJS.Timeout | undefined;

  const say = (message: string) => options.onLine?.(message);

  const runTick = async (): Promise<WatchRow[]> => {
    running = true;
    pendingRuns = 0;
    try {
      const rows = await tick({
        ...(options.minRuns !== undefined ? { minRuns: options.minRuns } : {}),
        ...(options.maxForks !== undefined ? { maxForks: options.maxForks } : {}),
        ...(options.onLine ? { onProgress: options.onLine } : {}),
      });
      lastRows = rows;
      lastTickAt = new Date().toISOString();
      lastError = undefined;
      const proposed = rows.filter((row) => row.outcome === 'proposed').length;
      say(proposed > 0
        ? `watch tick: ${proposed} proposal(s) awaiting review`
        : 'watch tick: nothing to propose');
      return rows;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      say(`watch tick failed: ${lastError}`);
      throw err;
    } finally {
      running = false;
    }
  };

  const attempt = (): void => {
    scheduled = undefined;
    if (closed || running) return;
    if (activeRuns > 0) {
      // Never contend with foreground work; look again once it quiets.
      scheduled = setTimeout(attempt, BUSY_RETRY_MS);
      return;
    }
    void runTick().catch(() => {
      // Recorded in lastError; an automatic tick has nobody to rethrow to.
    });
  };

  const schedule = (delay: number): void => {
    if (closed || scheduled) return;
    scheduled = setTimeout(attempt, delay);
  };

  return {
    snapshot: () => ({
      auto: options.auto,
      running,
      pendingRuns,
      activeRuns,
      ...(lastTickAt ? { lastTickAt } : {}),
      ...(lastRows ? { lastRows } : {}),
      ...(lastError ? { lastError } : {}),
    }),

    noteRunStarted: () => {
      activeRuns++;
    },

    noteWorkStarted: () => {
      activeRuns++;
    },

    noteWorkFinished: () => {
      activeRuns = Math.max(0, activeRuns - 1);
    },

    noteRunFinished: () => {
      activeRuns = Math.max(0, activeRuns - 1);
      pendingRuns++;
      if (!options.auto) return;
      if (pendingRuns >= debounceRuns) {
        schedule(COALESCE_MS);
        return;
      }
      // A partial batch still deserves a look once things go quiet.
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => {
        if (pendingRuns > 0) schedule(0);
      }, quietMs);
    },

    tickNow: () => {
      if (running) return Promise.reject(new Error('a watch tick is already running'));
      return runTick();
    },

    close: () => {
      closed = true;
      if (scheduled) clearTimeout(scheduled);
      if (quietTimer) clearTimeout(quietTimer);
    },
  };
}
