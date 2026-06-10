---
title: Adding an Eval Suite
description: Step-by-step guide to creating a new suite under @cycgraph/evals, with both deterministic and SUT-driven semantic tracks.
---

A **suite** in `@cycgraph/evals` is a per-package collection of golden trajectories with two optional execution tracks:

- A **deterministic** track that runs library code in-process and emits assertion results
- An **SUT-driven semantic** track that dispatches trajectories through the real package code and grades the observed output with an LLM judge

This guide walks through adding a new suite — covering the directory layout, the runner registration, and the recording integration.

## When to add a suite

- You're adding a new sibling package (e.g., `@cycgraph/audio-engine`) that needs its own regression gate
- An existing package has grown enough that its existing suite is unwieldy and warrants splitting
- You want a cross-cutting integration suite that exercises a multi-package flow (like the existing `integration` suite)

Don't add a suite to test a single feature — add a trajectory to an existing suite instead.

## Directory layout

```
packages/evals/src/suites/<your-suite>/
└── suite.ts           # runDeterministic + buildSutSuite exports
```

No `prompts.ts` or `assertions.ts` files — the SUT-driven contract declares metrics and trajectory IDs directly. The rubric metric IS the prompt.

## Step 1: declare the suite name in the schema

Add your suite name to `SuiteNameSchema` in `src/dataset/schema.ts`:

```typescript
export const SuiteNameSchema = z.enum([
  'context-engine', 'memory', 'orchestrator', 'integration',
  'your-suite',  // ← add it here
]);
```

Type narrowing through `SuiteName` will surface the rest of the changes you need.

## Step 2: define the suite module

The suite module exports two functions (both optional, but most suites implement at least one):

```typescript
// src/suites/your-suite/suite.ts

import type { TestCaseResults } from '../../assertions/drift-calculator.js';
import type { SutSuiteConfig } from '../sut-contract.js';
import { loadGoldenTrajectories } from '../../dataset/loader.js';
import { FAITHFULNESS } from '../../assertions/semantic-judge.js';

/** Deterministic track — no LLM needed. */
export async function runDeterministic(): Promise<TestCaseResults[]> {
  // ... run library calls, collect DeterministicResult arrays, return as
  // TestCaseResults entries with suite: 'your-suite'
}

/** SUT-driven semantic track — declares trajectories + metrics. */
export async function buildSutSuite(): Promise<SutSuiteConfig> {
  const trajectories = loadGoldenTrajectories('your-suite');
  return {
    name: 'your-suite',
    tests: trajectories.map(t => ({
      trajectoryId: t.id,
      description: t.description,
      metrics: [{ metric: FAITHFULNESS }],
      structuralAssertions: false,
    })),
  };
}
```

A suite that only has a deterministic track returns an empty SUT config (`{ name, tests: [] }`); the runner accepts that and skips the semantic phase for it.

### Deterministic-only example

```typescript
import {
  assertGreaterThanOrEqual, assertEqual,
} from '../../assertions/deterministic.js';

export async function runDeterministic(): Promise<TestCaseResults[]> {
  const results: TestCaseResults[] = [];

  results.push({
    suite: 'your-suite',
    zodResults: [],
    semanticResults: [],
    deterministicResults: [
      assertGreaterThanOrEqual('feature_x_threshold', 0.87, 0.80, 'X must hit 0.80'),
      assertEqual('feature_y_count', 5, 5, 'Y returns exactly 5 items'),
    ],
  });

  return results;
}

export async function buildSutSuite(): Promise<SutSuiteConfig> {
  return { name: 'your-suite', tests: [] };
}
```

### Semantic with multiple metrics

```typescript
import {
  ANSWER_RELEVANCY, FAITHFULNESS,
} from '../../assertions/semantic-judge.js';

export async function buildSutSuite(): Promise<SutSuiteConfig> {
  const trajectories = loadGoldenTrajectories('your-suite');
  return {
    name: 'your-suite',
    tests: trajectories.map(t => ({
      trajectoryId: t.id,
      description: t.description,
      metrics: [
        { metric: ANSWER_RELEVANCY, threshold: 0.85 },
        { metric: FAITHFULNESS },
      ],
      // Enable when the trajectory's golden declares expectedToolCalls
      structuralAssertions: t.expectedToolCalls !== undefined,
    })),
  };
}
```

## Step 3: register in the runner's static dispatch

The runner uses a static import map (not a dynamic path) to load suites. Add a case in both dispatchers in `src/runner/runner.ts`:

```typescript
async function getDeterministicEntrypoint(
  suiteName: SuiteName,
): Promise<DeterministicSuiteModule | null> {
  switch (suiteName) {
    // ... existing cases
    case 'your-suite':
      return await import('../suites/your-suite/suite.js') as DeterministicSuiteModule;
  }
}

async function loadSutSuiteConfig(
  suiteName: SuiteName,
): Promise<SutSuiteConfig> {
  switch (suiteName) {
    // ... existing cases
    case 'your-suite': {
      const mod = await import('../suites/your-suite/suite.js');
      return mod.buildSutSuite();
    }
  }
}
```

Static imports are intentional — they make missing suites a compile error rather than a runtime mystery and they're bundler-friendly.

## Step 4: add the suite to default loading (optional)

If your suite should run by default (no `--suite` filter), update the default in `runEvals`:

```typescript
const suitesToLoad = config.suites
  ?? (['context-engine', 'memory', 'orchestrator', 'your-suite'] as SuiteName[]);
```

Otherwise users need to opt in via `--suite your-suite`.

## Step 5: seed golden trajectories

Hand-author your first trajectories in `scripts/seed-golden-v2.ts` (or a new seed script for your suite):

```typescript
const yourSuiteTrajectories: GoldenTrajectory[] = [
  t('your-suite', 'Test: descriptive name',
    'input content',
    'expected output',
    ['tag1', 'tag2']),
  // ...
];

writeGoldenDataset('your-suite', yourSuiteTrajectories, '3.0.0');
```

Run the seed script:

```bash
npx tsx packages/evals/scripts/seed-golden-v2.ts
```

This creates `golden/data/your-suite-v1.sqlite.gz` and updates the manifest.

## Step 6: extend the recording planner

Hand-authored expected outputs are fine to start. When you're ready to ground them in real behavior, extend `src/sut/recording-planner.ts` to classify your suite's trajectories:

```typescript
function planYourSuiteTrajectory(trajectory: GoldenTrajectory): RecordingPlan {
  if (isYourSuiteTrajectorySupported(trajectory)) {
    return { trajectory, supported: true };
  }
  return { trajectory, supported: false, skipReason: '...' };
}

// In planForTrajectory:
case 'your-suite':
  return planYourSuiteTrajectory(trajectory);
```

Then build a `src/sut/your-suite-sut.ts` with handlers for each tag family — see [Adding a SUT Handler](/docs/guides/adding-sut-handler/).

## Step 7: write tests

Every suite should have a test that confirms:

1. The deterministic track passes on known-good fixtures
2. `buildSutSuite()` returns a config referencing valid trajectory IDs
3. Each handler dispatches correctly for its tag family
4. The trajectories round-trip through the schema

Look at `test/suites/memory.test.ts` for the canonical pattern.

## Step 8: verify end-to-end

```bash
# Type check + build
npm run build --workspace=packages/evals

# Run only your suite
npm run evals --workspace=packages/evals -- --deterministic-only --suite your-suite

# Confirm trajectories load
npx tsx packages/evals/scripts/record-goldens.ts --suite your-suite --plan-only

# Full semantic gate with stub or local LLM
npm run evals --workspace=packages/evals -- --suite your-suite
```

## Related

- [Eval Harness](/docs/concepts/eval-harness/) — overall architecture
- [Adding a SUT Handler](/docs/guides/adding-sut-handler/) — extending the recording layer
- [Eval Assertions](/docs/concepts/eval-assertions/) — choosing the right assertion family
