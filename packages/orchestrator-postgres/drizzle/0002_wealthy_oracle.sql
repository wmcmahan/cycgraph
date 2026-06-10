CREATE TABLE "workflow_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"sequence_id" integer NOT NULL,
	"event_type" text NOT NULL,
	"node_id" text,
	"action" jsonb,
	"internal_type" text,
	"internal_payload" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_events" ADD CONSTRAINT "workflow_events_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_workflow_events_run_seq" ON "workflow_events" USING btree ("run_id","sequence_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_events_run_type" ON "workflow_events" USING btree ("run_id","event_type");