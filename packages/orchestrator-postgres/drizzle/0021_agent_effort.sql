-- ════════════════════════════════════════════════════════════════════════
-- Agent effort — provider-neutral reasoning-effort level.
--
-- Stores the agent config's `effort` ('low' | 'medium' | 'high' | 'xhigh' |
-- 'max'); the executor translates it to the provider's own option at call
-- time. Nullable: absent means the provider's default behaviour, exactly as
-- before the column existed. The CHECK keeps corruption out at the write,
-- since a stray value would otherwise reach the provider translation.
-- ════════════════════════════════════════════════════════════════════════
ALTER TABLE "agents" ADD COLUMN "effort" text;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_effort_check" CHECK ("effort" IS NULL OR "effort" IN ('low', 'medium', 'high', 'xhigh', 'max'));
