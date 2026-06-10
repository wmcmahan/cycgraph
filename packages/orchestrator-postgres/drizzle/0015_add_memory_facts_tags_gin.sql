-- GIN index on memory_facts.tags backs the `tags ?| array[...]` tag filter
-- (the reflection-loop retrieval hot path). Without it, tag-scoped fact
-- retrieval pages the whole table client-side before every prompt that
-- declares a `memory_query` with tags.
--
-- Note: created non-concurrently to match this repo's transactional migration
-- runner. On a large, live memory_facts table prefer running
--   CREATE INDEX CONCURRENTLY "idx_memory_facts_tags" ON "memory_facts" USING gin ("tags");
-- out-of-band instead (CONCURRENTLY cannot run inside a transaction).
CREATE INDEX IF NOT EXISTS "idx_memory_facts_tags" ON "memory_facts" USING gin ("tags");
