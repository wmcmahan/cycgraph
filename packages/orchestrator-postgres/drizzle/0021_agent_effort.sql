-- ════════════════════════════════════════════════════════════════════════
-- Agent effort — provider-neutral reasoning-effort level.
--
-- Stores the agent config's `effort` ('low' | 'medium' | 'high' | 'xhigh' |
-- 'max'); the executor translates it to the provider's own option at call
-- time. Nullable: absent means the provider's default behaviour, exactly as
-- before the column existed.
-- ════════════════════════════════════════════════════════════════════════
ALTER TABLE "agents" ADD COLUMN "effort" text;
