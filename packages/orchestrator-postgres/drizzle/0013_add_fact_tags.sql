-- The `@cycgraph/memory` tables were historically created with `drizzle-kit
-- push` and never captured in a migration, so a from-scratch `migrate` had no
-- `memory_*` tables for the `tags` column below (or migration 0015's GIN index)
-- to attach to. Create them here, before the ALTER, so the chain applies
-- cleanly on a fresh database. (`memory_facts.tags` is added by the ALTER at the
-- end; its GIN index by migration 0015.)
CREATE TABLE "memory_entities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"entity_type" text NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb,
	"embedding" vector(1536),
	"provenance" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invalidated_at" timestamp with time zone,
	"superseded_by" uuid
);
--> statement-breakpoint
CREATE TABLE "memory_themes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"description" text DEFAULT '',
	"fact_ids" jsonb DEFAULT '[]'::jsonb,
	"embedding" vector(1536),
	"provenance" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_episodes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"topic" text NOT NULL,
	"messages" jsonb NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"embedding" vector(1536),
	"fact_ids" jsonb DEFAULT '[]'::jsonb,
	"provenance" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_relationships" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"relation_type" text NOT NULL,
	"weight" real DEFAULT 1 NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone,
	"provenance" jsonb NOT NULL,
	"invalidated_by" text
);
--> statement-breakpoint
CREATE TABLE "memory_facts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"source_episode_ids" jsonb DEFAULT '[]'::jsonb,
	"entity_ids" jsonb DEFAULT '[]'::jsonb,
	"theme_id" uuid,
	"embedding" vector(1536),
	"provenance" jsonb NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone,
	"invalidated_by" text,
	"access_count" integer DEFAULT 0,
	"last_accessed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "memory_entity_facts" (
	"fact_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	CONSTRAINT "memory_entity_facts_fact_id_entity_id_pk" PRIMARY KEY("fact_id","entity_id")
);
--> statement-breakpoint
ALTER TABLE "memory_relationships" ADD CONSTRAINT "memory_relationships_source_id_memory_entities_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."memory_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_relationships" ADD CONSTRAINT "memory_relationships_target_id_memory_entities_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."memory_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_facts" ADD CONSTRAINT "memory_facts_theme_id_memory_themes_id_fk" FOREIGN KEY ("theme_id") REFERENCES "public"."memory_themes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entity_facts" ADD CONSTRAINT "memory_entity_facts_fact_id_memory_facts_id_fk" FOREIGN KEY ("fact_id") REFERENCES "public"."memory_facts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entity_facts" ADD CONSTRAINT "memory_entity_facts_entity_id_memory_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."memory_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_memory_entities_type" ON "memory_entities" USING btree ("entity_type");--> statement-breakpoint
CREATE INDEX "idx_memory_entities_embedding" ON "memory_entities" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "idx_memory_themes_embedding" ON "memory_themes" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "idx_memory_episodes_started" ON "memory_episodes" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "idx_memory_episodes_embedding" ON "memory_episodes" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "idx_memory_rels_source" ON "memory_relationships" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "idx_memory_rels_target" ON "memory_relationships" USING btree ("target_id");--> statement-breakpoint
CREATE INDEX "idx_memory_rels_type" ON "memory_relationships" USING btree ("relation_type");--> statement-breakpoint
CREATE INDEX "idx_memory_facts_theme" ON "memory_facts" USING btree ("theme_id");--> statement-breakpoint
CREATE INDEX "idx_memory_facts_valid" ON "memory_facts" USING btree ("valid_from","valid_until");--> statement-breakpoint
CREATE INDEX "idx_memory_facts_embedding" ON "memory_facts" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "idx_mef_entity" ON "memory_entity_facts" USING btree ("entity_id");--> statement-breakpoint
ALTER TABLE "memory_facts" ADD COLUMN "tags" jsonb DEFAULT '[]'::jsonb NOT NULL;
