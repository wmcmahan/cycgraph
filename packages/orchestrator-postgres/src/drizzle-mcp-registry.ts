/**
 * Drizzle MCP Server Registry
 *
 * Implements MCPServerRegistry by querying the `mcp_servers` table.
 */

import { db } from './connection.js';
import { mcp_servers } from './schema.js';
import { eq, and, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { withTenant, type Tx, type TenantContext } from './tenancy.js';
import type { MCPServerRegistry } from '@cycgraph/orchestrator';
import type { MCPServerEntry } from '@cycgraph/orchestrator';
import { MCPServerEntrySchema } from '@cycgraph/orchestrator';

/** A query handle usable for both standalone (`db`) and tenant-scoped (`tx`) work. */
type Queryer = typeof db | Tx;

export interface DrizzleMCPServerRegistryOptions {
  /**
   * Tenant whose MCP servers this registry sees. When set, reads/deletes are
   * filtered to the tenant and writes stamp `tenant_id`. When omitted,
   * single-tenant (seed default).
   *
   * NOTE: `mcp_servers.id` is still a global PK (flagged follow-up in
   * MULTI_TENANCY.md), so two tenants cannot yet reuse the same server id —
   * the tenant filter scopes *visibility*, not the id namespace.
   */
  tenant?: TenantContext;
}

export class DrizzleMCPServerRegistry implements MCPServerRegistry {
  private readonly tenant?: TenantContext;

  constructor(options?: DrizzleMCPServerRegistryOptions) {
    this.tenant = options?.tenant;
  }

  private get tenantValues(): { tenant_id: string } | Record<string, never> {
    return this.tenant ? { tenant_id: this.tenant.tenant_id } : {};
  }

  private tenantEq(col: AnyPgColumn): SQL | undefined {
    return this.tenant ? eq(col, this.tenant.tenant_id) : undefined;
  }

  private read<T>(fn: (q: Queryer) => Promise<T>): Promise<T> {
    return this.tenant ? withTenant(this.tenant.tenant_id, fn) : fn(db);
  }

  async saveServer(entry: MCPServerEntry): Promise<void> {
    // SECURITY: re-validate at the trust boundary. The stdio command
    // allowlist and URL SSRF guard live in MCPServerEntrySchema and are only
    // enforced if every write actually parses (TS types are compile-time
    // only — a JS caller or `any` cast could otherwise persist an arbitrary
    // command/transport that connectToServer would then spawn).
    const v = MCPServerEntrySchema.parse(entry);
    await this.read((q) => q
      .insert(mcp_servers)
      .values({
        id: v.id,
        ...this.tenantValues,
        name: v.name,
        description: v.description ?? null,
        transport: v.transport,
        allowed_agents: v.allowed_agents ?? null,
        timeout_ms: v.timeout_ms,
      })
      .onConflictDoUpdate({
        target: mcp_servers.id,
        set: {
          name: v.name,
          description: v.description ?? null,
          transport: v.transport,
          allowed_agents: v.allowed_agents ?? null,
          timeout_ms: v.timeout_ms,
          updated_at: new Date(),
        },
      }));
  }

  async loadServer(id: string): Promise<MCPServerEntry | null> {
    const result = await this.read((q) => q
      .select()
      .from(mcp_servers)
      .where(and(eq(mcp_servers.id, id), this.tenantEq(mcp_servers.tenant_id)))
      .limit(1));

    if (result.length === 0) return null;

    const row = result[0];
    // Re-validate on read: a row written by a migration, a direct SQL
    // statement, or an older/looser schema must not bypass the guards.
    return MCPServerEntrySchema.parse({
      id: row.id,
      name: row.name,
      description: row.description ?? undefined,
      transport: row.transport,
      allowed_agents: row.allowed_agents ?? undefined,
      timeout_ms: row.timeout_ms,
    });
  }

  async listServers(): Promise<MCPServerEntry[]> {
    const rows = await this.read((q) => q.select().from(mcp_servers).where(this.tenantEq(mcp_servers.tenant_id)));
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      description: row.description ?? undefined,
      transport: row.transport,
      allowed_agents: row.allowed_agents ?? undefined,
      timeout_ms: row.timeout_ms,
    }));
  }

  async deleteServer(id: string): Promise<boolean> {
    const result = await this.read((q) => q
      .delete(mcp_servers)
      .where(and(eq(mcp_servers.id, id), this.tenantEq(mcp_servers.tenant_id))));
    return (result.rowCount ?? 0) > 0;
  }
}
