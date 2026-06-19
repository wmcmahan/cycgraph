/**
 * Tenancy — connection-level isolation primitive.
 *
 * The hosted multi-tenant model splits every database operation into two
 * planes:
 *
 *  - **Tenant plane** (RLS-enforced): everything a single tenant's request
 *    touches — run state, events, memory, agents, usage. Runs through
 *    {@link withTenant}, which opens a transaction and sets the
 *    `app.tenant_id` session GUC so Postgres Row-Level Security policies
 *    filter every statement to that tenant. A forgotten `WHERE tenant_id`
 *    cannot leak data: the database enforces the boundary.
 *
 *  - **Platform plane** (RLS-bypass): shared infrastructure that legitimately
 *    spans tenants — the job queue's cross-tenant dequeue/reclaim sweep,
 *    retention GC, and migrations. Runs through {@link withPlatform}. In the
 *    enforce phase this connects as a `BYPASSRLS` role; a worker that claims a
 *    job reads `job.tenant_id` and re-enters the tenant plane via
 *    {@link withTenant} to actually execute the run.
 *
 * RLS requires the GUC to be set on the *same* connection as the query, and
 * `SET LOCAL` / `set_config(..., true)` only persist for the current
 * transaction — hence {@link withTenant} is transaction-scoped by
 * construction.
 *
 * @module @cycgraph/orchestrator-postgres/tenancy
 */

import { sql } from 'drizzle-orm';
import { db, getAppDb, getPlatformDb } from './connection.js';
import { TENANT_GUC } from './constants.js';

/** A Drizzle transaction handle (matches `db.transaction`'s callback arg). */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Identifies the tenant a tenant-plane operation runs on behalf of. */
export interface TenantContext {
  /** Tenant UUID. Set as the `app.tenant_id` GUC for the operation. */
  tenant_id: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Run `fn` inside a transaction scoped to `tenantId`'s RLS context.
 *
 * Sets the `app.tenant_id` session variable (transaction-local) before
 * invoking `fn`, so every statement `fn` issues on the provided transaction
 * is filtered/checked by the tenant-isolation policies. The value is bound as
 * a parameter (never interpolated) and additionally validated as a UUID — a
 * non-UUID tenant id is a programming error and throws before any SQL runs.
 *
 * @throws {Error} if `tenantId` is not a syntactically valid UUID.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(tenantId)) {
    throw new Error(
      `withTenant: tenant_id must be a UUID (got ${JSON.stringify(tenantId)}). ` +
        `Refusing to open a tenant-scoped transaction with an invalid tenant.`,
    );
  }
  // Tenant plane runs on the RLS-subject app-role connection (falls back to the
  // owner connection when APP_DATABASE_URL is unset — see getAppDb).
  const appDb = await getAppDb();
  return appDb.transaction(async (tx) => {
    // `set_config(setting, value, is_local=true)` == `SET LOCAL`, but
    // parameterizable. Transaction-local: reset automatically at commit/abort,
    // so a pooled connection never leaks one tenant's context into the next
    // checkout.
    await tx.execute(sql`select set_config(${TENANT_GUC}, ${tenantId}, true)`);
    return fn(tx);
  });
}

/**
 * Run a cross-tenant *platform-plane* operation. No tenant GUC is set; the
 * caller is asserting the work legitimately spans tenants (queue maintenance,
 * retention GC).
 *
 * Runs on the platform connection ({@link getPlatformDb}) — the `cycgraph_admin`
 * BYPASSRLS role when `PLATFORM_DATABASE_URL` is set, else the owner connection.
 * Under `FORCE` RLS (migration 0019) the owner is itself subject to policies, so
 * production cross-tenant sweeps REQUIRE the BYPASSRLS connection.
 *
 * Also an explicit, greppable marker at every cross-tenant call site, so "no
 * tenant scope here" is always a deliberate, reviewable decision.
 */
export async function withPlatform<T>(fn: (database: typeof db) => Promise<T>): Promise<T> {
  return fn(await getPlatformDb());
}
