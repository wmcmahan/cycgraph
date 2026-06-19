/**
 * Tenancy constants — shared between the schema and the connection layer.
 *
 * Kept in a dependency-free module so both `schema.ts` (which sets the
 * transitional column default) and `tenancy.ts` (which sets the session GUC)
 * can import them without creating an import cycle
 * (`schema → constants`, `tenancy → connection → schema → constants`).
 *
 * @module @cycgraph/orchestrator-postgres/constants
 */

/**
 * Postgres session variable (GUC) that carries the active tenant for
 * RLS-enforced ("tenant plane") queries. Read by every row-level-security
 * policy via `current_setting('app.tenant_id', true)::uuid`. The `true`
 * (`missing_ok`) form returns NULL when unset, so an un-scoped connection
 * matches zero rows and is rejected by INSERT `WITH CHECK` — i.e. it fails
 * safe instead of leaking across tenants.
 */
export const TENANT_GUC = 'app.tenant_id';

/**
 * Well-known seed tenant. All pre-tenancy rows are backfilled to this id by
 * the expand migration, and it is the transitional column default while the
 * adapters are being threaded to set `tenant_id` explicitly.
 *
 * SECURITY: the column default is a migration scaffold, NOT a steady-state
 * behaviour. The "enforce" migration drops the default so a write that fails
 * to specify a tenant errors instead of silently landing in the seed tenant.
 * Do not rely on this default in application code.
 */
export const SEED_TENANT_ID = '00000000-0000-0000-0000-000000000001';
