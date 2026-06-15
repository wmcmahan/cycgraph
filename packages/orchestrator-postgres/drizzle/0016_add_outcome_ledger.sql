-- Durable eval-gated learning ledger (backs @cycgraph/memory's OutcomeLedger).
--
-- `run_outcomes`      : one scored workflow run.
-- `run_outcome_facts` : run -> injected-fact join (the durable provenance
--                       link). Composite PK enforces within-run fact dedup.
-- `gate_decisions`    : append-only audit of every retention-gate decision,
--                       with its statistical evidence (observability surface).
--
-- Per-fact stats and the leave-one-out baseline are computed by SQL
-- aggregation (count / avg / var_samp) at query time — no materialised
-- stats — so they reproduce InMemoryOutcomeLedger exactly. `var_samp`
-- matches the in-memory (n-1) sample variance and is NULL for n < 2.
CREATE TABLE IF NOT EXISTS "run_outcomes" (
	"run_id" text PRIMARY KEY NOT NULL,
	"score" double precision NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "run_outcome_facts" (
	"run_id" text NOT NULL,
	"fact_id" text NOT NULL,
	CONSTRAINT "run_outcome_facts_run_id_fact_id_pk" PRIMARY KEY("run_id","fact_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gate_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fact_id" text NOT NULL,
	"decision" text NOT NULL,
	"reason" text,
	"evidence" jsonb,
	"trials" integer,
	"gated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "run_outcome_facts" ADD CONSTRAINT "run_outcome_facts_run_id_run_outcomes_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run_outcomes"("run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_run_outcomes_recorded_at" ON "run_outcomes" ("recorded_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_run_outcome_facts_fact" ON "run_outcome_facts" ("fact_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_gate_decisions_fact" ON "gate_decisions" ("fact_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_gate_decisions_gated_at" ON "gate_decisions" ("gated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_gate_decisions_decision" ON "gate_decisions" ("decision");
