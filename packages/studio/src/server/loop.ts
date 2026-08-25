/**
 * The dashboard's handle on the self-improvement loop.
 *
 * One loop at a time, because measurement contends with the runs it is
 * measuring: a second loop would make both slower and noisier. The
 * controller keeps the events so a page that was closed mid-loop can
 * still see what happened, and the result once it stops.
 *
 * @module server/loop
 */

import { runImproveLoop, type LoopEvent, type LoopOptions, type LoopResult } from '../improve/loop.js';
import type { Scenario } from '../scenarios/types.js';
import type { Stack } from '../stack/index.js';

const EVENT_LIMIT = 400;

/** What the page shows about the loop. */
export interface LoopStatus {
  running: boolean;
  workflow?: string;
  autonomy?: string;
  startedAt?: string;
  events: LoopEvent[];
  result?: LoopResult;
  error?: string;
}

export interface LoopController {
  status(): LoopStatus;
  start(workflow: Scenario, options: LoopOptions): void;
  stop(): void;
}

/** Build the controller around a stack it does not own. */
export function createLoopController(
  stack: Stack,
  onEvent?: (event: LoopEvent) => void,
): LoopController {
  let running = false;
  let workflow: string | undefined;
  let autonomy: string | undefined;
  let startedAt: string | undefined;
  let events: LoopEvent[] = [];
  let result: LoopResult | undefined;
  let error: string | undefined;
  let aborter: AbortController | undefined;

  return {
    status: () => ({
      running,
      ...(workflow ? { workflow } : {}),
      ...(autonomy ? { autonomy } : {}),
      ...(startedAt ? { startedAt } : {}),
      events,
      ...(result ? { result } : {}),
      ...(error ? { error } : {}),
    }),

    start(scenario, options) {
      if (running) throw new Error('a loop is already running');
      running = true;
      workflow = scenario.id;
      autonomy = options.autonomy ?? 'apply';
      startedAt = new Date().toISOString();
      events = [];
      result = undefined;
      error = undefined;
      aborter = new AbortController();

      void runImproveLoop(stack, scenario, {
        ...options,
        signal: aborter.signal,
        onEvent: (event) => {
          events = [...events, event].slice(-EVENT_LIMIT);
          onEvent?.(event);
        },
      })
        .then((outcome) => { result = outcome; })
        .catch((err: unknown) => { error = err instanceof Error ? err.message : String(err); })
        .finally(() => { running = false; });
    },

    stop() {
      aborter?.abort();
    },
  };
}
