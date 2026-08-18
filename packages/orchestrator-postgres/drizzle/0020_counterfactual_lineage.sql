-- ════════════════════════════════════════════════════════════════════════
-- Counterfactual replay — run lineage.
--
-- `workflow_runs.parent_run_id` already exists, and subgraph child runs have
-- used it since before forking existed. A counterfactual run sets the same
-- column, so the column alone can no longer say what a row is. `run_kind`
-- disambiguates, and analytics, retention, and the outcome ledger filter on it
-- so forks stay out of production numbers unless asked for.
--
-- The remaining three columns make a fork reproducible from its row: where in
-- the parent's log it diverged, what it changed, and which sweep it belongs to.
--
-- Additive and backfill-free: every existing row is a primary run, which is
-- what the DEFAULT gives them.
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE "workflow_runs"
  ADD COLUMN IF NOT EXISTS "run_kind" text NOT NULL DEFAULT 'primary';
--> statement-breakpoint

ALTER TABLE "workflow_runs"
  ADD COLUMN IF NOT EXISTS "fork_sequence_id" integer;
--> statement-breakpoint

ALTER TABLE "workflow_runs"
  ADD COLUMN IF NOT EXISTS "fork_mutations" jsonb;
--> statement-breakpoint

ALTER TABLE "workflow_runs"
  ADD COLUMN IF NOT EXISTS "fork_group_id" uuid;
--> statement-breakpoint

-- Mirrors the TypeScript enum. A row whose kind the engine does not know would
-- be silently excluded from every filtered query, so reject it at the write.
ALTER TABLE "workflow_runs"
  DROP CONSTRAINT IF EXISTS "workflow_runs_run_kind_check";
--> statement-breakpoint

ALTER TABLE "workflow_runs"
  ADD CONSTRAINT "workflow_runs_run_kind_check"
  CHECK ("run_kind" IN ('primary', 'subgraph', 'counterfactual'));
--> statement-breakpoint

-- Listing one run's forks, and excluding forks from primary-run analytics.
CREATE INDEX IF NOT EXISTS "idx_workflow_runs_kind_parent"
  ON "workflow_runs" ("run_kind", "parent_run_id");
--> statement-breakpoint

-- Partial: only sweep members carry a group.
CREATE INDEX IF NOT EXISTS "idx_workflow_runs_fork_group"
  ON "workflow_runs" ("fork_group_id")
  WHERE "fork_group_id" IS NOT NULL;
