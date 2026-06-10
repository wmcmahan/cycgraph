---
title: Adding a SUT Handler
description: Extend the System-Under-Test layer to cover a new trajectory tag family.
---

The SUT (System-Under-Test) layer in `@cycgraph/evals` is what makes recording possible — it wraps the real library APIs and returns observable output for each trajectory. When you add a new trajectory tag family that the existing handlers don't cover, you extend the SUT to handle it.

This guide walks through both kinds of extension:

- **Deterministic suites** (memory, context-engine) — add a tag-routed handler function
- **Orchestrator suite** — add a new reference graph builder + planner case

## Pattern 1: Deterministic SUT handler

The memory and context-engine SUTs follow the same shape — a tag-matching dispatcher that resolves the trajectory's input through one of several library entry points.

### Anatomy of a handler

```typescript
// src/sut/memory-sut.ts (excerpt)

interface MemoryHandler {
  name: string;
  matches(tags: Set<string>): boolean;
  run(input: string): Promise<unknown>;
}

const segmentationHandler: MemoryHandler = {
  name: 'segmentation',
  matches: (tags) => tags.has('segmentation') || tags.has('episodes'),
  async run(input) {
    const messages = parseMessages(input);
    const segmenter = new SimpleEpisodeSegmenter({
      gap_threshold_ms: 30 * 60 * 1000,
    });
    const episodes = await segmenter.segment(messages);
    return {
      episodes: episodes.length,
      topics: episodes.map(e => e.topic),
      message_counts: episodes.map(e => e.messages.length),
    };
  },
};
```

### Step 1: Pick a tag family

Look at the trajectory tags that have no handler today. The `record-goldens.ts --plan-only` script lists skipped trajectories with their tags:

```text
[10/18] SKIP  0252e64a Subgraph: 1-hop returns direct neighbors — No memory handler for tags [subgraph, graph] yet
```

That tells you the family is `subgraph`/`graph`.

### Step 2: Write the handler

Add a new `Handler` constant in the suite's SUT file:

```typescript
const subgraphHandler: MemoryHandler = {
  name: 'subgraph',
  matches: (tags) => tags.has('subgraph') || tags.has('graph'),
  async run(input) {
    const { seed_entities, max_hops, valid_at } = parseSubgraphInput(input);
    const { store } = await buildSeededMemoryGraph();
    const result = await extractSubgraph(store, seed_entities, {
      max_hops, valid_at,
    });

    return {
      entities: result.entities.map(e => e.id),
      relationships: result.relationships.map(r => ({
        type: r.relation_type,
        source: r.source_id,
        target: r.target_id,
      })),
    };
  },
};
```

Things to keep in mind:

- **Output shape matters.** This object becomes the new `expectedOutput` for every trajectory the handler runs. Keep it stable across versions — adding fields is safer than removing them.
- **Parsers should tolerate input shape variants.** Trajectory inputs are JSON strings authored at different times; be permissive about what you accept (`input.max_hops ?? 1`).
- **Side effects belong inside the handler, not at module scope.** Build a fresh store per call so concurrent recordings don't interfere.

### Step 3: Register the handler

Add the handler to the `HANDLERS` array. Order matters when one trajectory's tags could match multiple handlers — earlier entries win:

```typescript
const HANDLERS: MemoryHandler[] = [
  segmentationHandler,
  temporalHandler,
  extractionHandler,
  subgraphHandler,       // ← new
  consolidationHandler,
  conflictHandler,
];
```

### Step 4: Use shared fixtures where appropriate

If your handler needs a seeded store (entities, relationships, facts), put the seeding logic in `src/sut/fixtures/`. The memory suite uses `buildSeededMemoryGraph()` for subgraph / consolidation / conflict handlers so all three share one canonical world.

```typescript
// src/sut/fixtures/memory-graph.ts
export async function buildSeededMemoryGraph(): Promise<{
  store: InMemoryMemoryStore;
  index: InMemoryMemoryIndex;
}> {
  // ... fresh store + index every call
}
```

### Step 5: Write tests

For each new handler, add a `describe` block to the suite's test file:

```typescript
describe('runMemorySut — subgraph', () => {
  it('extracts a 1-hop neighborhood from the seeded fixture', async () => {
    const input = JSON.stringify({ seed_entities: ['e-alice'], max_hops: 1 });
    const result = await runMemorySut({
      trajectory: makeTrajectory(['subgraph', 'graph'], input),
    });
    expect(result.status).toBe('completed');
    const parsed = JSON.parse(result.output);
    expect(parsed.entities).toContain('e-alice');
  });
});
```

Run them:

```bash
npx vitest run test/sut/memory-sut.test.ts
```

### Step 6: Confirm planner coverage

```bash
npx tsx scripts/record-goldens.ts --suite memory --plan-only
```

The previously-skipped trajectories should now show as supported.

## Pattern 2: Orchestrator reference graph

The orchestrator suite uses **reference graphs** instead of handlers — a trajectory's tags map to a graph builder (single-agent, supervisor, branching, retry), and the SUT runs that graph against a real LLM.

### Step 1: Pick a graph shape

If your new tag family fits an existing graph (most do), skip to the planner change. Add a new graph only when the topology genuinely differs — e.g., a swarm graph, an evaluator-optimizer loop, a HITL graph.

Most variations belong inside the agent's prompt or tool fixtures rather than the graph topology. For example, `branching` reuses a single-agent graph with a structured-output prompt; `retry` reuses single-agent with a stateful flaky tool.

### Step 2: Build the graph

Follow the pattern from `src/sut/graphs/supervisor.ts`:

```typescript
// src/sut/graphs/your-graph.ts

import {
  InMemoryAgentRegistry, createGraph, createWorkflowState,
} from '@cycgraph/orchestrator';
import type { Graph, WorkflowState, AgentRegistry } from '@cycgraph/orchestrator';

export interface YourGraphOptions {
  input: string;
  model?: string;
  outputKey?: string;
}

export interface YourGraphArtifacts {
  graph: Graph;
  initialState: WorkflowState;
  agentRegistry: AgentRegistry;
  outputKey: string;
}

export function buildYourGraph(opts: YourGraphOptions): YourGraphArtifacts {
  // ... register agents, build graph, return artifacts
}
```

Every builder returns the same `{graph, initialState, agentRegistry, outputKey}` shape so the recording dispatcher can call them uniformly.

### Step 3: Add a tool-fixture profile if needed

If your graph uses MCP-typed tools, add a `OrchestratorToolKind` and a `resolveToolFixtures` case in `scripts/record-goldens.ts`. Stateful fixtures (closures over counters) MUST be re-created per sample — that's why fixture resolution happens inside the per-sample dispatcher rather than in the planner.

```typescript
case 'your_tool_kind':
  return {
    toolResponses: {
      your_tool: createYourTool(),
    },
    toolDescriptions: {
      your_tool: 'Description shown to the LLM',
    },
  };
```

### Step 4: Route trajectories to the new graph

Update `src/sut/recording-planner.ts`:

```typescript
function planOrchestratorTrajectory(trajectory: GoldenTrajectory): RecordingPlan {
  const tags = new Set(trajectory.tags ?? []);

  if (tags.has('your-new-tag')) {
    return {
      trajectory,
      supported: true,
      graphKind: 'your-graph',
      toolKind: 'your_tool_kind',
    };
  }

  // ... existing rules
}
```

Add `'your-graph'` to the `OrchestratorGraphKind` union type at the top of the file.

### Step 5: Dispatch in the recording script

Update `runOrchestratorSample` in `scripts/record-goldens.ts` to handle `plan.graphKind === 'your-graph'`:

```typescript
if (plan.graphKind === 'your-graph') {
  const artifacts = buildYourGraph({
    input: plan.trajectory.input,
    model,
  });
  return runOrchestratorSut({
    graph: artifacts.graph,
    initialState: artifacts.initialState,
    agentRegistry: artifacts.agentRegistry,
    toolResponses,
    toolDescriptions,
    outputKey: artifacts.outputKey,
  });
}
```

### Step 6: Test the planner classification

Add a case to `test/sut/recording-planner.test.ts`:

```typescript
it('routes your-new-tag trajectories to your-graph', () => {
  const plan = planForTrajectory(
    'orchestrator',
    makeTrajectory('orchestrator', ['your-new-tag']),
  );
  expect(plan.graphKind).toBe('your-graph');
});
```

### Step 7: Smoke-test recording

```bash
ANTHROPIC_API_KEY=sk-ant-... \
  npx tsx scripts/record-goldens.ts --suite orchestrator
```

If everything's wired correctly, the previously-skipped trajectory now shows `REC` and contributes to the diff report.

## Anti-patterns

- **Sharing mutable state between handler calls.** Build fresh stores/fixtures per `run()` invocation. Test concurrent runs to confirm.
- **Hard-coding output shapes that include nondeterministic values.** UUIDs and timestamps will diverge across samples and fail the stability check. Either strip them from the output or pin them at the input.
- **Adding a "supervisor + tools" graph when "single-agent + tools" suffices.** Topology variations are expensive to test; prefer reusing graphs with different prompt/tool configs.
- **Putting LLM-bound code in a deterministic handler.** Memory and context-engine handlers should never call an LLM, even indirectly. If you need LLM judgment, the trajectory belongs in the orchestrator suite.

## Related

- [Eval Harness](/docs/concepts/eval-harness/) — overall architecture
- [Recording Goldens](/docs/guides/recording-goldens/) — how the SUT layer plugs into recording
- [Adding an Eval Suite](/docs/guides/adding-eval-suite/) — when you need a whole new suite, not just a new handler
