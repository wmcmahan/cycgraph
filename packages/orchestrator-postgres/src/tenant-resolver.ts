/**
 * Tenant Resolver — credential → tenant.
 *
 * The front of the control plane: turn an inbound API key into a
 * {@link TenantContext} that {@link createTenantScope} can use. Resolution is
 * storage-agnostic ({@link TenantResolver}); the persistent `api_keys` table is
 * intentionally NOT part of the engine schema — per the schema header,
 * "platform-specific tables (e.g. api_keys) live in the consuming application."
 * This module ships the interface, the hashing primitive every backing store
 * should use, and an in-memory reference implementation.
 *
 * SECURITY:
 *   - Only ever store the **hash** of an API key ({@link hashApiKey}); the raw
 *     key is shown to the user once at issue time and never persisted.
 *   - Resolution fails closed: an unknown/empty key returns `null`, never a
 *     default tenant.
 *
 * @module @cycgraph/orchestrator-postgres/tenant-resolver
 */

import { createHash, randomBytes } from 'node:crypto';
import type { TenantContext } from './tenancy.js';

/** Resolve an opaque credential (API key) to the tenant it authenticates. */
export interface TenantResolver {
  /** Returns the tenant for `apiKey`, or `null` if the key is unknown/revoked. */
  resolve(apiKey: string): Promise<TenantContext | null>;
}

/**
 * SHA-256 hash of an API key, hex-encoded. The lookup key for any backing
 * store: persist this, never the raw key. Deterministic, so a presented key
 * hashes to the same value for lookup.
 */
export function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey, 'utf8').digest('hex');
}

/**
 * Mint a new random API key. Returns the raw key (show once, then discard) and
 * its hash (store this). Default prefix makes keys greppable/identifiable in
 * logs and lets you scope leaked-key scans.
 */
export function generateApiKey(prefix = 'cyc_sk'): { rawKey: string; hash: string } {
  const rawKey = `${prefix}_${randomBytes(24).toString('base64url')}`;
  return { rawKey, hash: hashApiKey(rawKey) };
}

/**
 * In-memory {@link TenantResolver} — a reference implementation for tests and
 * single-process setups. Production swaps this for a store backed by the
 * consuming app's `api_keys` table (hash → tenant_id), reusing
 * {@link hashApiKey} for the lookup.
 */
export class InMemoryTenantResolver implements TenantResolver {
  private readonly tenantByHash = new Map<string, string>();

  /** Register a raw key → tenant mapping (hashes the key before storing). */
  register(rawKey: string, tenantId: string): void {
    this.tenantByHash.set(hashApiKey(rawKey), tenantId);
  }

  /** Revoke a key. Returns `true` if it existed. */
  revoke(rawKey: string): boolean {
    return this.tenantByHash.delete(hashApiKey(rawKey));
  }

  async resolve(apiKey: string): Promise<TenantContext | null> {
    if (!apiKey) return null;
    const tenantId = this.tenantByHash.get(hashApiKey(apiKey));
    return tenantId ? { tenant_id: tenantId } : null;
  }
}
