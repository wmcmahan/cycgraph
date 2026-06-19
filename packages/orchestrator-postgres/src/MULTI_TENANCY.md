# Multi-Tenancy (Hosted Service)

How the Postgres adapter isolates tenants. The engine (`@cycgraph/orchestrator`)
stays **tenant-agnostic** — `PersistenceProvider` is keyed by `run_id`/`graph_id`
and `GraphRunner` never sees a tenant. Tenancy lives entirely in this adapter and
the control plane that constructs a per-request provider, exactly like run
`fencing` is injected today.

## Isolation model: Hybrid (RLS floor + app filters)

- **Postgres Row-Level Security is the hard enforcement floor.** Every
  tenant-owned table has a `tenant_id` and an `USING (tenant_id =
  current_setting('app.tenant_id', true)::uuid)` policy. A forgotten
  `WHERE tenant_id` cannot leak data — the database rejects it. `missing_ok =
  true` means an unset GUC matches zero rows and fails INSERT `WITH CHECK`, so
  an unscoped connection fails **safe**.
- **App-level `tenant_id` filters are kept for the planner/indexes**, not for
  safety. Tenant-leading composite indexes (`idx_*_tenant*`) back the
  list/dashboard/billing paths.

## Two planes

| Plane | Runs as | Used by | Mechanism |
|-------|---------|---------|-----------|
| **Tenant** (RLS-enforced) | `cycgraph_app` (RLS-subject) | run state, events, memory, agents, usage — anything one tenant's request touches | `withTenant(tenantId, fn)` opens a txn and sets `app.tenant_id` |
| **Platform** (RLS-bypass) | owner / `cycgraph_admin` (BYPASSRLS) | queue dequeue/reclaim sweep, retention GC, migrations | `withPlatform(fn)` — explicit, greppable cross-tenant marker |

The job queue is deliberately **platform-plane**: workers dequeue across all
tenants (shared fair scheduling). A claiming worker reads `job.tenant_id` and
re-enters the tenant plane via `withTenant` to execute the run. `workflow_jobs.
tenant_id` exists for attribution + per-tenant depth metrics, not RLS-scoped
dequeue. Per-tenant fair scheduling is a later (scaling-phase) concern.

## Rollout: expand → thread → enforce

A forgotten-tenant write must **fail**, not silently land in the seed tenant —
but flipping that on before the adapters set `tenant_id` would break every
current write. So we stage it:

1. **EXPAND** — `0017_tenancy_expand.sql` (done). Adds the `tenants` table and a
   `tenant_id` column (NOT NULL, **default = seed tenant**) to every table,
   plus indexes and the per-tenant `agents.name` uniqueness swap. RLS is **not**
   enabled. The column default keeps un-threaded single-tenant adapter writes
   working, so this migration is safe to apply to a live DB alone.
   - Seed tenant: `00000000-0000-0000-0000-000000000001` (`SEED_TENANT_ID`).

2. **THREAD** (DONE) — every Drizzle adapter runs its tenant-plane operations
   inside `withTenant(ctx.tenant_id, tx => …)` and sets `tenant_id` explicitly
   on every insert. Tenant is injected at construction, mirroring `fencing`:
   ```ts
   new DrizzlePersistenceProvider({ tenant: { tenant_id }, fencing })
   ```
   Threaded: `DrizzlePersistenceProvider`, `DrizzleEventLogWriter`,
   `DrizzleUsageRecorder`, `DrizzleAgentRegistry`, `DrizzleMCPServerRegistry`,
   `DrizzleMemoryStore`, `DrizzleMemoryIndex`, `DrizzleOutcomeLedger` — each via
   an optional `tenant?` ctor option + `tenantValues`/`tenantEq`/`read`/`tx`
   helpers (app-level filter is the live isolation pre-enforce). The queue
   carries `tenant_id` as opaque job metadata and `dequeue` copies it onto the
   `workflow_runs` row it upserts. Platform-plane `DrizzleRetentionService.*` is
   wrapped in `withPlatform` (cross-tenant by design). Cross-tenant isolation
   tests cover runs/state, agents, memory facts + tag retrieval, and the
   outcome-ledger gate stats. Remaining: control-plane wiring that constructs a
   per-tenant adapter set per request (Phase B).

3. **ENFORCE** (DONE) — `0018_tenancy_enforce.sql` + the connection split.
   Two choices changed vs the original sketch, both to avoid breaking
   single-tenant / owner callers:

   - **`ENABLE`, not `FORCE`.** Non-forced RLS lets the table *owner bypass*
     the policies. So migrations, the platform plane (`withPlatform`), and every
     existing owner-connection test keep working untouched. Only a **non-owner**
     role is subject to RLS.
   - **The seed column default is KEPT (not dropped).** Dropping it would make
     every unscoped `new DrizzleX()` insert a NOT NULL violation. Instead the
     policy's **`WITH CHECK` is the fail-loud**: as `cycgraph_app` with no GUC
     set, `current_setting('app.tenant_id', true)` is NULL, so
     `WITH CHECK (tenant_id = NULL)` fails and the unscoped write is rejected —
     it can't silently land in the seed tenant. On the owner/bypass path
     (single-tenant) the default still applies and seed is correct.

   ```sql
   CREATE ROLE cycgraph_app NOLOGIN;             -- non-owner ⇒ RLS-subject
   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO cycgraph_app;
   ALTER TABLE workflow_runs ENABLE ROW LEVEL SECURITY;   -- not FORCE
   CREATE POLICY tenant_isolation ON workflow_runs
     USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
     WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
   ```

   **Connection split (`connection.ts` + `tenancy.ts`):** `withTenant` now runs
   on `getAppDb()` — backed by `APP_DATABASE_URL` (a non-owner login role with
   `cycgraph_app` membership). When `APP_DATABASE_URL` is unset it **falls back
   to the owner connection**, so dev / CI / single-tenant run on one URL and RLS
   (which the owner bypasses) simply doesn't engage — the app-level `tenant_id`
   filters still isolate. `withPlatform` stays on the owner connection, so the
   queue/retention cross-tenant sweeps work by owner-bypass — no separate
   BYPASSRLS attribute needed.

   **Deployment:** owner `DATABASE_URL` for migrations + platform plane; non-owner
   `APP_DATABASE_URL` for the tenant plane. Enforcement activates the moment
   `APP_DATABASE_URL` is set; until then behaviour is identical to the thread
   phase. Tests `RLS hides cross-tenant rows…` / `RLS WITH CHECK rejects…`
   (tenancy-isolation.test.ts) exercise the policies via `SET LOCAL ROLE
   cycgraph_app` in CI.

## Structural hardening (B.2 / migration 0019)

`0018` *enabled* RLS; `0019` makes isolation **structural** rather than
discipline-dependent:

- **`FORCE` RLS** on all 21 tenant-owned tables — so even a *non-superuser table
  owner* is subject to policies (closes the "tenant query accidentally on the
  owner connection" gap). Superusers and BYPASSRLS roles still bypass.
- **`cycgraph_admin`** — a `BYPASSRLS` role for the platform plane. With `FORCE`
  the owner is subject, so cross-tenant sweeps (queue dequeue/reclaim, retention)
  need an explicit bypass. `withPlatform` runs on `getPlatformDb()` →
  `PLATFORM_DATABASE_URL` (the `cycgraph_admin` role) or the owner when unset.
- **Seed default KEPT** (not dropped): `WITH CHECK` under `cycgraph_app` is the
  fail-loud — a write whose `tenant_id` ≠ the GUC is rejected regardless of the
  default. Dropping it would break single-tenant / OSS / the queue's
  single-tenant dequeue for no added safety on the enforcing role.

Connections, end state: `DATABASE_URL` (owner → migrations); `APP_DATABASE_URL`
(`cycgraph_app`, RLS-subject → tenant plane / `withTenant`); `PLATFORM_DATABASE_URL`
(`cycgraph_admin`, BYPASSRLS → platform plane / `withPlatform`).

## Open follow-ups (flagged, not yet done)

- **`mcp_servers.id`** is still a tenant-supplied **global** PK; two tenants
  can't reuse the same server id. Namespacing (composite PK `tenant_id,id`)
  needs the registry adapter's id lookups updated — deferred.
- **Phase B control plane**: where `tenant_id` actually comes from (API key →
  tenant) and the per-request construction of a tenant-scoped adapter set.
- **Not validated on real Postgres locally** (no Docker in dev): 0017/0018 and
  the RLS tests are exercised by CI's `pgvector/pg16` job. The RLS tests use
  `SET LOCAL ROLE`, which needs the migration applied + a superuser/owner test
  connection (both true in CI).
```
