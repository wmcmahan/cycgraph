-- ════════════════════════════════════════════════════════════════════════
-- Multi-tenancy — STRUCTURAL hardening (B.2 / ADR 001 Gate #1).
--
-- 0018 enabled RLS and the tenant plane runs as the non-owner `cycgraph_app`
-- role, so isolation is already enforced for that connection. This migration
-- closes the remaining gap — a tenant-plane query accidentally routed through
-- the *owner* connection — by FORCING RLS, and gives the platform plane an
-- explicit BYPASSRLS role so its legitimate cross-tenant sweeps still work.
--
-- ROLE MODEL after this migration:
--   • cycgraph_app   (0018, non-owner)      → tenant plane, SUBJECT to RLS
--                                             (withTenant / APP_DATABASE_URL)
--   • cycgraph_admin (here, BYPASSRLS)       → platform plane, BYPASSES RLS
--                                             (withPlatform / PLATFORM_DATABASE_URL):
--                                             queue dequeue/reclaim, retention GC
--   • table owner / superuser                → migrations. Superusers ALWAYS
--                                             bypass RLS (even FORCE); a
--                                             non-superuser owner is now SUBJECT
--                                             (that is the point of FORCE).
--
-- The seed-tenant column DEFAULT from 0017 is intentionally KEPT: under
-- cycgraph_app the policy WITH CHECK already rejects any write whose tenant_id
-- != the GUC (so a forgot-the-tenant write fails regardless of the default),
-- and the default keeps single-tenant / OSS / the queue's single-tenant dequeue
-- working. Dropping it would break those for no added safety on the app role.
--
-- NOTE: FORCE only changes behaviour for a NON-superuser owner. CI connects as
-- the `postgres` superuser, which bypasses RLS — so the existing
-- `SET LOCAL ROLE cycgraph_app` RLS tests remain the enforcement proof.
-- ════════════════════════════════════════════════════════════════════════

-- ── Platform role (BYPASSRLS) ──
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cycgraph_admin') THEN
    CREATE ROLE "cycgraph_admin" NOLOGIN BYPASSRLS;
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO "cycgraph_admin";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "cycgraph_admin";--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "cycgraph_admin";--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "cycgraph_admin";--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO "cycgraph_admin";--> statement-breakpoint

-- ── FORCE RLS on every tenant-owned table ──
-- (Not `tenants` itself: tenant CREATION is a platform/owner op, and FORCE there
--  would require a GUC to insert a brand-new tenant. cycgraph_app reads of
--  `tenants` are already scoped by the 0018 `tenant_self` policy.)
ALTER TABLE "graphs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workflows" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workflow_runs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workflow_states" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workflow_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workflow_checkpoints" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workflow_jobs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agents" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mcp_servers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "documents" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "embeddings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "usage_records" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memory_entities" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memory_relationships" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memory_episodes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memory_themes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memory_facts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memory_entity_facts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "run_outcomes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "run_outcome_facts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "gate_decisions" FORCE ROW LEVEL SECURITY;
