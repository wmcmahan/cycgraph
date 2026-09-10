---
"@cycgraph/a2a": patch
---

The Agent Card cache is now keyed by agent card URL plus the headers the card was fetched with, so two registry entries that share one `agent_card_url` but use different credentials each resolve the card with their own auth instead of silently reusing the first caller's cached card.
