# @cycgraph/evals

## 0.2.0

### Minor Changes

- e35b1ab: Extraction efficacy evaluation for `@cycgraph/memory` — the adversarial harness the extraction tier previously lacked. Three corpus partitions with distinct roles:

  - **Regression fences** (`extraction-corpus.ts`, gated): ratchet-floored metrics over an authored corpus, including the audit's fabrication classes (embedded verb stems, negations, substring entity suppression) pinned at 1.0.
  - **Measured ceilings**: the rule-based tier's known structural limits (list constructions, passive voice, all-caps orgs, sentence-start entities) reported as numbers, never failed — they move when the extractor improves.
  - **Implementation-blind corpus** (`extraction-corpus-blind.ts`, frozen before first contact): natural-text passages with meaning-space acceptance-set labels, measuring honest capability for both tiers. Baselines: rule-based captures 0.15 of asserted relationships on natural text (vs 1.0 on its fitted corpus); Claude Opus 4.8 measures 0.80–0.95 with perfect entity detection/typing.

  The LLM tier runs through `LLMExtractor` on either backend: Ollama (auto-skips without a local server) or the Claude API via the official SDK — double-gated on `ANTHROPIC_API_KEY` + `RUN_ANTHROPIC_EVALS=1` so a routine `npm test` can never spend API credits, with token-usage metrics for cost observability and a fallback-rate metric guarding against silently scoring the rule-based fallback. Anthropic-backend metrics carry ratchet floors set below measured baselines; fabrication-safety specs are tier-aware (negation-preserving edges like `never_worked_at` are faithful extraction, not fabrication). The deterministic memory suite gains the rule-based extraction cases and a cross-episode pipeline check (extraction → `EntityResolver` → `ConflictDetector`) proving conflicts invisible before resolution are found after it.

### Patch Changes

- Updated dependencies [e35b1ab]
  - @cycgraph/memory@0.6.0
