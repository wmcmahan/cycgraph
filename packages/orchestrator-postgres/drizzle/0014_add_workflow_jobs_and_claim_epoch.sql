-- Durable workflow job queue (SQS-style visibility-timeout semantics)
CREATE TABLE "workflow_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"run_id" uuid NOT NULL,
	"graph_id" uuid NOT NULL,
	"initial_state" jsonb,
	"human_response" jsonb,
	"priority" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"visibility_timeout_ms" integer DEFAULT 300000 NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"worker_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"visible_at" timestamp with time zone,
	"last_heartbeat_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
CREATE INDEX "idx_workflow_jobs_dequeue" ON "workflow_jobs" ("status","priority","created_at");
--> statement-breakpoint
CREATE INDEX "idx_workflow_jobs_run_id" ON "workflow_jobs" ("run_id");
--> statement-breakpoint
CREATE INDEX "idx_workflow_jobs_reclaim" ON "workflow_jobs" ("status","visible_at");
--> statement-breakpoint
-- Run fencing token: bumped on every job claim; fenced writers reject stale epochs
ALTER TABLE "workflow_runs" ADD COLUMN "claim_epoch" integer DEFAULT 0 NOT NULL;
