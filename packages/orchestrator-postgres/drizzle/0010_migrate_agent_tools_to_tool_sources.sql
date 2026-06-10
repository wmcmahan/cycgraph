-- Migration: Convert agents.tools from string[] to ToolSource[] format
--
-- Before: tools column contains JSON arrays of strings, e.g.:
--   ["web_search", "save_to_memory", "architect_draft_workflow"]
--
-- After: tools column contains JSON arrays of ToolSource objects, e.g.:
--   [{"type":"builtin","name":"save_to_memory"}, {"type":"mcp","server_id":"web-search"}]
--
-- Conversion rules:
--   - "save_to_memory" → {"type":"builtin","name":"save_to_memory"}
--   - "architect_*"    → {"type":"builtin","name":"<original>"}
--   - anything else    → {"type":"mcp","server_id":"<original>"}
--
-- This migration is idempotent: rows already in ToolSource[] format are skipped.

UPDATE agents
SET tools = (
  SELECT jsonb_agg(
    CASE
      -- Already converted (has "type" key) — keep as-is
      WHEN jsonb_typeof(elem) = 'object' AND elem ? 'type'
        THEN elem
      -- Built-in tools
      WHEN elem #>> '{}' IN ('save_to_memory', 'architect_draft_workflow', 'architect_publish_workflow', 'architect_get_workflow')
        THEN jsonb_build_object('type', 'builtin', 'name', elem #>> '{}')
      -- Everything else → MCP server reference (tool name becomes server_id)
      ELSE jsonb_build_object('type', 'mcp', 'server_id', elem #>> '{}')
    END
  )
  FROM jsonb_array_elements(tools) AS elem
)
WHERE jsonb_typeof(tools) = 'array'
  AND jsonb_array_length(tools) > 0
  -- Only convert rows that still contain plain strings (not already ToolSource objects)
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(tools) AS e
    WHERE jsonb_typeof(e) = 'string'
  );
