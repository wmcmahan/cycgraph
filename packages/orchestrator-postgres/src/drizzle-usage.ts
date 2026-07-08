/**
 * Drizzle Usage Recorder
 *
 * Implements UsageRecorder using Drizzle ORM + PostgreSQL.
 */

import { db } from './connection.js';
import { usage_records } from './schema.js';
import { and, eq, gte, sql } from 'drizzle-orm';
import { withTenant, type Tx, type TenantContext } from './tenancy.js';
import type { UsageRecorder, UsageRecord } from '@cycgraph/orchestrator';

export interface DrizzleUsageRecorderOptions {
  /**
   * Tenant this recorder bills to. When set, `usage_records.tenant_id` is
   * stamped on every write so per-tenant cost/token rollups are accurate.
   * When omitted, the column falls to the seed-tenant default (single-tenant
   * mode). Mis-attribution here is a *billing* bug, so hosted callers must
   * always construct one recorder per tenant request.
   */
  tenant?: TenantContext;
}

export class DrizzleUsageRecorder implements UsageRecorder {
  private readonly tenant?: TenantContext;

  constructor(options?: DrizzleUsageRecorderOptions) {
    this.tenant = options?.tenant;
  }

  async saveUsageRecord(record: UsageRecord): Promise<void> {
    const tenantValues = this.tenant ? { tenant_id: this.tenant.tenant_id } : {};
    const insert = (q: typeof db | Tx) => q.insert(usage_records).values({
      ...tenantValues,
      run_id: record.run_id,
      api_key_id: record.api_key_id ?? null,
      graph_id: record.graph_id,
      input_tokens: record.input_tokens,
      output_tokens: record.output_tokens,
      cost_usd: String(record.cost_usd),
      model_breakdown: record.model_breakdown ?? null,
      duration_ms: record.duration_ms,
    }).onConflictDoNothing();

    if (this.tenant) {
      await withTenant(this.tenant.tenant_id, insert);
    } else {
      await insert(db);
    }
  }

  /**
   * Total `cost_usd` this recorder's tenant has incurred at or after `since`.
   * Tenant-scoped (the cost-cap / billing-rollup read path). Returns a JS
   * number — `cost_usd` is `numeric`, summed in SQL and coerced once here.
   */
  async sumCostSince(since: Date): Promise<number> {
    const query = (q: typeof db | Tx) => q
      .select({ total: sql<string>`COALESCE(SUM(${usage_records.cost_usd}), 0)` })
      .from(usage_records)
      .where(
        and(
          gte(usage_records.created_at, since),
          this.tenant ? eq(usage_records.tenant_id, this.tenant.tenant_id) : undefined,
        ),
      );

    const rows = this.tenant
      ? await withTenant(this.tenant.tenant_id, query)
      : await query(db);
    return Number(rows[0]?.total ?? 0);
  }
}
