-- ════════════════════════════════════════════════════════════════════════
-- Multi-tenancy — EXPAND phase (additive, zero-behavior-change).
--
-- This is step 1 of an expand → thread → enforce sequence (see
-- src/MULTI_TENANCY.md):
--   • EXPAND (this file): add the `tenants` table and a `tenant_id` column to
--     every tenant-owned table, backfilled to the seed tenant via a column
--     DEFAULT. RLS is NOT enabled here — the column default keeps existing
--     single-tenant adapter writes working unchanged, so this migration is
--     safe to apply to a live DB on its own.
--   • THREAD: adapters are updated to run inside withTenant() and set
--     `tenant_id` explicitly.
--   • ENFORCE (0018): enable + FORCE row-level security, create the
--     `cycgraph_app` role, and DROP the transitional column default so an
--     unscoped write errors instead of silently landing in the seed tenant.
--
-- The seed tenant id MUST equal SEED_TENANT_ID in src/constants.ts.
-- ════════════════════════════════════════════════════════════════════════

-- Tenant registry: the FK anchor + GDPR cascade-delete unit.
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint

-- Seed tenant: owns all pre-tenancy rows. Must exist before the FK-bearing
-- ADD COLUMN ... DEFAULT statements below can validate.
INSERT INTO "tenants" ("id", "slug", "name", "status")
VALUES ('00000000-0000-0000-0000-000000000001', 'default', 'Default Tenant', 'active')
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- ── tenant_id columns (NOT NULL, default-backfilled to the seed tenant) ──
-- The DEFAULT both backfills existing rows and is the transitional scaffold
-- for un-threaded adapters; 0018 drops it.

ALTER TABLE "graphs" ADD COLUMN "tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workflow_states" ADD COLUMN "tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workflow_events" ADD COLUMN "tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workflow_checkpoints" ADD COLUMN "tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workflow_jobs" ADD COLUMN "tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "embeddings" ADD COLUMN "tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "usage_records" ADD COLUMN "tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "memory_entities" ADD COLUMN "tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "memory_relationships" ADD COLUMN "tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "memory_episodes" ADD COLUMN "tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "memory_themes" ADD COLUMN "tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "memory_facts" ADD COLUMN "tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "memory_entity_facts" ADD COLUMN "tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "run_outcomes" ADD COLUMN "tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "run_outcome_facts" ADD COLUMN "tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "gate_decisions" ADD COLUMN "tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint

-- ── agents.name: global UNIQUE → UNIQUE per tenant ──
-- Two tenants may both have a "Research Agent".
ALTER TABLE "agents" DROP CONSTRAINT IF EXISTS "agents_name_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agents_tenant_name" ON "agents" ("tenant_id","name");--> statement-breakpoint

-- ── Tenant-scoped composite indexes (tenant_id leading) ──
CREATE INDEX "idx_graphs_tenant_updated" ON "graphs" ("tenant_id","updated_at");--> statement-breakpoint
CREATE INDEX "idx_workflows_tenant" ON "workflows" ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_runs_tenant_created" ON "workflow_runs" ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_workflow_runs_tenant_status" ON "workflow_runs" ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "idx_workflow_states_tenant" ON "workflow_states" ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_events_tenant" ON "workflow_events" ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_checkpoints_tenant" ON "workflow_checkpoints" ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_jobs_tenant_status" ON "workflow_jobs" ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "idx_mcp_servers_tenant" ON "mcp_servers" ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_documents_tenant" ON "documents" ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_embeddings_tenant" ON "embeddings" ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_usage_records_tenant_created" ON "usage_records" ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_memory_entities_tenant" ON "memory_entities" ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_memory_rels_tenant" ON "memory_relationships" ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_memory_episodes_tenant" ON "memory_episodes" ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_memory_themes_tenant" ON "memory_themes" ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_memory_facts_tenant" ON "memory_facts" ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_mef_tenant" ON "memory_entity_facts" ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_run_outcomes_tenant" ON "run_outcomes" ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_run_outcome_facts_tenant" ON "run_outcome_facts" ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_gate_decisions_tenant" ON "gate_decisions" ("tenant_id");
