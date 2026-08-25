/**
 * The dashboard event bus: everything serve drives, on one feed
 *
 * Runs, forks, applies, and watch ticks each stream to whoever started
 * them; the bus is the second copy every activity publishes so the Logs
 * page can tail the whole dashboard live. A ring buffer holds the recent
 * past, so a page opened mid-run starts with context instead of silence.
 *
 * Only what this process drives appears here — a CLI run in another
 * terminal writes artifacts the historical queries see, but no live feed.
 *
 * @module server/bus
 */

/** One line on the live feed. */
export interface TailEvent {
  /** ISO timestamp assigned at publish. */
  at: string;
  /** Which activity produced it. */
  kind: 'run' | 'fork' | 'apply' | 'watch' | 'loop';
  /** The run it belongs to, when it belongs to one. */
  runId?: string;
  scenarioId?: string;
  /** The payload: a stream event, or a `{ message }` line. */
  data: unknown;
}

/** How much recent past a newly opened tail is handed. */
const RING_SIZE = 300;

/** The bus handle. */
export interface Bus {
  publish(event: Omit<TailEvent, 'at'>): void;
  /** Subscribe to future events. Returns the unsubscribe. */
  subscribe(listener: (event: TailEvent) => void): () => void;
  /** The ring buffer, oldest first. */
  recent(): TailEvent[];
}

/** Build a bus. One per dashboard. */
export function createBus(): Bus {
  const listeners = new Set<(event: TailEvent) => void>();
  const ring: TailEvent[] = [];

  return {
    publish(event) {
      const stamped: TailEvent = { at: new Date().toISOString(), ...event };
      ring.push(stamped);
      if (ring.length > RING_SIZE) ring.shift();
      for (const listener of listeners) {
        try {
          listener(stamped);
        } catch {
          // A broken subscriber must not take the publisher down with it.
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    recent: () => [...ring],
  };
}
