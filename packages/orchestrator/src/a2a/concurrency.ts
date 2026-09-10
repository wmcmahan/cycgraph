/**
 * A2A Per-Server Concurrency Cap
 *
 * Enforces `max_concurrent_tasks` from an {@link A2AServerEntry}: the number
 * of tasks this process may have in flight against one remote agent at a
 * time. Without it a `map`, voting, or parallel-branch graph fires every
 * branch at once and can overwhelm a shared or rate-limited agent.
 *
 * The limiter is module-scoped rather than per-run on purpose. The thing
 * being protected is the REMOTE agent, so two concurrent runs delegating to
 * the same server must share one budget — a per-run limiter would multiply
 * the configured cap by the number of runs in flight.
 *
 * Keyed by server id AND agent card URL: two registry entries that resolve
 * to the same endpoint are the same remote agent and share a budget, while
 * a tenant-specific entry that reuses an id but points elsewhere gets its
 * own. Absent `max_concurrent_tasks` means unlimited, and allocates nothing.
 *
 * @module a2a/concurrency
 */

import { Semaphore } from '../mcp/semaphore.js';
import type { A2AServerEntry } from './schema.js';

/** Cached limiter plus the limit it was built for, so edits take effect. */
interface ServerLimiter {
  limit: number;
  semaphore: Semaphore;
}

const limiters = new Map<string, ServerLimiter>();

/** Identity of the remote agent being protected, not of the registry row. */
function limiterKey(server: Pick<A2AServerEntry, 'id' | 'agent_card_url'>): string {
  return `${server.id}\u0000${server.agent_card_url}`;
}

/**
 * Resolve (and lazily create) the limiter for a server. Returns `undefined`
 * when the entry sets no cap, so the unlimited path stays allocation-free.
 *
 * A registry entry whose cap changed is re-limited: the new semaphore starts
 * fresh while tasks already holding the old one drain against it, so the two
 * caps overlap briefly rather than the edit being ignored outright.
 */
export function getA2AServerSemaphore(
  server: Pick<A2AServerEntry, 'id' | 'agent_card_url' | 'max_concurrent_tasks'>,
): Semaphore | undefined {
  const limit = server.max_concurrent_tasks;
  if (!limit || limit < 1) return undefined;

  const key = limiterKey(server);
  const existing = limiters.get(key);
  if (existing && existing.limit === limit) return existing.semaphore;

  const semaphore = new Semaphore(limit);
  limiters.set(key, { limit, semaphore });
  return semaphore;
}

/**
 * Run `fn` while holding one of the server's task slots, releasing it even
 * if `fn` throws. Uncapped servers call straight through.
 */
export async function withA2AServerConcurrency<T>(
  server: Pick<A2AServerEntry, 'id' | 'agent_card_url' | 'max_concurrent_tasks'>,
  fn: () => Promise<T>,
): Promise<T> {
  const semaphore = getA2AServerSemaphore(server);
  return semaphore ? semaphore.run(fn) : fn();
}

/**
 * Drop every cached limiter. For tests that need one suite's fan-out not to
 * inherit permits held by another; not part of the runtime path.
 */
export function resetA2AServerConcurrency(): void {
  limiters.clear();
}
