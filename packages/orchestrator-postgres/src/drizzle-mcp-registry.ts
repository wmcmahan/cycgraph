/**
 * Drizzle MCP Server Registry
 *
 * Implements MCPServerRegistry by querying the `mcp_servers` table.
 */

import { db } from './connection.js';
import { mcp_servers } from './schema.js';
import { eq } from 'drizzle-orm';
import type { MCPServerRegistry } from '@cycgraph/orchestrator';
import type { MCPServerEntry } from '@cycgraph/orchestrator';
import { MCPServerEntrySchema } from '@cycgraph/orchestrator';

export class DrizzleMCPServerRegistry implements MCPServerRegistry {
  async saveServer(entry: MCPServerEntry): Promise<void> {
    // SECURITY: re-validate at the trust boundary. The stdio command
    // allowlist and URL SSRF guard live in MCPServerEntrySchema and are only
    // enforced if every write actually parses (TS types are compile-time
    // only — a JS caller or `any` cast could otherwise persist an arbitrary
    // command/transport that connectToServer would then spawn).
    const v = MCPServerEntrySchema.parse(entry);
    await db
      .insert(mcp_servers)
      .values({
        id: v.id,
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
      });
  }

  async loadServer(id: string): Promise<MCPServerEntry | null> {
    const result = await db
      .select()
      .from(mcp_servers)
      .where(eq(mcp_servers.id, id))
      .limit(1);

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
    const rows = await db.select().from(mcp_servers);
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
    const result = await db.delete(mcp_servers).where(eq(mcp_servers.id, id));
    return (result.rowCount ?? 0) > 0;
  }
}
