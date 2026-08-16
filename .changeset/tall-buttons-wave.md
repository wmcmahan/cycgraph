---
"@cycgraph/orchestrator": patch
"@cycgraph/orchestrator-postgres": patch
---

Remaining `mcai` naming replaced with `cycgraph`.

The MCP connection manager identified itself to every remote server as `mcai-<serverId>` during the initialize handshake, so third-party servers saw the pre-rename name. It is now `cycgraph-<serverId>`. The Postgres adapter's log tag is `[cycgraph/orchestrator-postgres]`.

The default database name is deliberately unchanged: it is internal infrastructure rather than anything a third party sees, and renaming it would strand existing volumes.
