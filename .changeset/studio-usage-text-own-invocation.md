---
"@cycgraph/studio": patch
---

The CLI usage text now renders the host's own banner and invocation instead of a hardcoded `cycgraph playground` / `npm run play -- ` prefix, so an unrecognized `cycgraph-studio` subcommand prints examples as `npm run studio -- ...` as the README documents. The `watch` follow-up hint and the empty-ledger `proposals` hint are spelled from the same resolved invocation. Hosts embedding the CLI can name their own invocation through the new `usage` field on `CliHarness`, which commands now read from `CliContext.usage`.
