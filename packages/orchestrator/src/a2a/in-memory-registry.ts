/**
 * In-Memory A2A Server Registry
 *
 * Reference implementation for tests and single-process deployments. A
 * durable backing store implements the same interface.
 *
 * @module a2a/in-memory-registry
 */

import { camelToSnakeDeep } from '../utils/case-mapping.js';
import {
  A2AServerEntrySchema,
  type A2AServerConfig,
  type A2AServerEntry,
  type A2AServerRegistry,
} from './schema.js';

export class InMemoryA2AServerRegistry implements A2AServerRegistry {
  private readonly servers = new Map<string, A2AServerEntry>();

  /**
   * Register or update a server entry.
   *
   * SECURITY: the entry is parsed through {@link A2AServerEntrySchema}
   * before storage. The registry is a trust boundary, and the SSRF guard
   * only holds if every write actually parses — TypeScript types are
   * compile-time only and say nothing about what a caller passed.
   */
  async saveServer(entry: A2AServerConfig): Promise<void> {
    const validated = A2AServerEntrySchema.parse(camelToSnakeDeep(entry));
    this.servers.set(validated.id, validated);
  }

  /**
   * Load a server by ID. Returns `null` if not found.
   *
   * Re-validated on read: an entry stored before the guard tightened, or
   * written by tampering with the backing store, must not be trusted merely
   * because it is already there.
   */
  async loadServer(id: string): Promise<A2AServerEntry | null> {
    const entry = this.servers.get(id);
    if (!entry) return null;
    return A2AServerEntrySchema.parse(entry);
  }

  /** List all registered servers. */
  async listServers(): Promise<A2AServerEntry[]> {
    return [...this.servers.values()];
  }

  /** Remove a server by ID. Returns `true` if it existed. */
  async deleteServer(id: string): Promise<boolean> {
    return this.servers.delete(id);
  }
}
