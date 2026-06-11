---
"@cycgraph/orchestrator": patch
---

Migrate off Anthropic model IDs retiring 2026-06-15. `DEFAULT_AGENT_MODEL` is now `claude-sonnet-4-6` (was `claude-sonnet-4-20250514`); `ANTHROPIC_MODELS` gains `claude-opus-4-8` and `claude-sonnet-4-6` while keeping the deprecated IDs so existing persisted agent configs still validate; the pricing table gains `claude-opus-4-8` ($5/$25 per MTok) and keeps historical entries so cost replay of old runs stays correct. All examples, docs, and test fixtures updated to the new IDs.
