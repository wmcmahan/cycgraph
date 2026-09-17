# @cycgraph/studio

## 0.2.1

### Patch Changes

- edee786: The playground now registers only the A2A scenario agents the scenario server currently advertises, so a machine with no model no longer gets an Agent Card resolution error when a model-backed scenario is invoked.
- Updated dependencies [ee094fc]
- Updated dependencies [e70416c]
- Updated dependencies
- Updated dependencies [68853cb]
- Updated dependencies [3b21c32]
- Updated dependencies [05b3718]
- Updated dependencies [59d7061]
- Updated dependencies [68853cb]
  - @cycgraph/orchestrator@1.3.8
  - @cycgraph/a2a@1.1.5
  - @cycgraph/tools@1.4.2

## 0.2.0

### Minor Changes

- faf06f3: Branch delivery helpers now live in `@cycgraph/tools/git` and are
  re-exported here unchanged, joined by the new `publishBranch` (push the
  branch and open the PR, falling back to a pre-filled create-PR URL when
  `gh` is unavailable). `resolveApplyRepo` now checks whether the
  repository tracks the target workflow's own source file when the catalog
  knows it, instead of always asking whether the playground is tracked;
  `config.applyRepo` still bypasses detection. The watch tick now
  refreshes its corpus before sensing: runs any process recorded into the
  shared persistence are imported into the artifact tree first, so
  headless and CI runs against the same database join the improvement
  loop without a manual `import`.

### Patch Changes

- Updated dependencies [faf06f3]
  - @cycgraph/tools@1.2.0

## 0.1.1

### Patch Changes

- 2adb2f1: First release of the cycgraph studio: install as a dev dependency, declare your graphs in a project-root `cycgraph.config`, and run `cycgraph-studio` — the dashboard, counterfactual forking, insights, and the tune/improve ladder over your own workflows. TypeScript configs and graph modules load through tsx's runtime loader under the plain-node bin, sharing one module cache so inline agents and tools thread correctly. The dashboard is a Next.js app statically exported at build time and served by the studio's own node server — React and Next are build-time tools, never consumer dependencies.
- Updated dependencies [2adb2f1]
- Updated dependencies [2adb2f1]
- Updated dependencies [2adb2f1]
- Updated dependencies [2adb2f1]
- Updated dependencies [2adb2f1]
- Updated dependencies [2adb2f1]
  - @cycgraph/orchestrator@1.2.3
  - @cycgraph/tools@1.1.1
  - @cycgraph/evals@0.3.1
  - @cycgraph/orchestrator-postgres@4.1.2
