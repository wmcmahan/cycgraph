# @cycgraph/evals

## 0.3.4

### Patch Changes

- 8cbfbce: `runOrchestratorSut` now cancels a run that exceeds `timeoutMs` and waits for it to settle before returning. A timed-out trajectory can no longer keep making LLM and tool calls in the background while the next test reconfigures the process-global agent factory and provider registry.
- Updated dependencies [042d9b2]
- Updated dependencies [4ac1d2b]
- Updated dependencies [c42b3d6]
- Updated dependencies [75642e7]
- Updated dependencies [63297fa]
- Updated dependencies [8cbfbce]
- Updated dependencies [c43e1fa]
  - @cycgraph/orchestrator@1.6.0
  - @cycgraph/context-engine@0.7.6

## 0.3.3

### Patch Changes

- f5f50cd: `runEvals` now surfaces a failed baseline load as `baselineLoadError` instead of swallowing it: baseline comparison and the baseline rewrite are both skipped, and the CLI exits `1`. A corrupt snapshot or unknown schema version can no longer be reported as a clean run with no regression.
- 68de445: `writeGoldenDataset` now only starts from an empty manifest when `golden/manifest.json` does not exist; a manifest that exists but fails JSON or schema validation throws instead of being silently replaced. This prevents a corrupt or out-of-date manifest from wiping every other suite's dataset registration on the next write. The manifest is read and validated before the compressed dataset is written, so a failed write also leaves the existing `.sqlite.gz` and its recorded checksum in sync.
- Updated dependencies [1ea53ff]
- Updated dependencies [004bede]
- Updated dependencies [ad1a8fe]
- Updated dependencies [7301997]
  - @cycgraph/context-engine@0.7.3
  - @cycgraph/orchestrator@1.3.9

## 0.3.2

### Patch Changes

- 9671a03: `migrate-golden` writes migrated datasets under the next MAJOR schema version derived from the manifest (via the new `nextMajorSchemaVersion` export) instead of a hardcoded `1.0.0`, which overwrote the retained v1 rollback file and downgraded the manifest entry.
- Updated dependencies [9671a03]
- Updated dependencies [9671a03]
- Updated dependencies [9671a03]
  - @cycgraph/context-engine@0.7.2
  - @cycgraph/orchestrator@1.3.4
  - @cycgraph/memory@0.8.1

## 0.3.1

### Patch Changes

- 2adb2f1: The package is now published: `@cycgraph/studio` depends on its sweep, insight, and verdict machinery, so installing the studio pulls it from the registry.
- 2adb2f1: Insights and sweeps understand namespaced child nodes: profile and outlier denominators count top-level nodes only (a child's time is already inside its container's), child boundaries appear as first-class profile rows, and temperature sweeps recognize a `/`-namespaced agent or supervisor row as agent-backed without a parent-graph lookup.
- Updated dependencies [2adb2f1]
- Updated dependencies [2adb2f1]
  - @cycgraph/orchestrator@1.2.3

## 0.3.0

### Minor Changes

- ad0f9c0: `SweepInputs.cleanRunRate` decides which question a budget-exhaustion finding asks: failing runs still motivate the correctness sweep (more room), but a loop that exhausts its budget while every run passes has a stop condition doing its job, so the finding stands aside and the profile's cost sweep claims the knob.

### Patch Changes

- Updated dependencies [ad0f9c0]
- Updated dependencies [ad0f9c0]
  - @cycgraph/orchestrator@1.2.2

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
