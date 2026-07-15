---
title: Reflection
description: Distill a run's output into atomic lessons that future runs retrieve — agents that get smarter over time.
---

The **Reflection** pattern closes the compound-learning loop. After productive work in a graph, a `reflection` node distills source memory keys (notes, drafts, observations) into atomic `SemanticFacts` and persists them to your memory store via an injected `MemoryWriter`. Future runs retrieve those facts (filtered by tags) through `memoryRetriever` and feed them into agent prompts as a `## Relevant Memory` section.

The infrastructure under reflection — `@cycgraph/memory`'s temporal knowledge graph and the orchestrator's `memoryWriter` / `memoryRetriever` adapters — is the same. What reflection adds is the **node** that ties the workflow's runtime output to that store at the right point in the graph.

## How it works

```mermaid
flowchart LR
    subgraph R1["RUN 1 — cold start"]
        direction LR
        Goal1[Goal 1] --> Researcher1["🔬 Researcher\n(memoryQuery.tags)"]
        Researcher1 -- "research_notes" --> Reflect1["🪞 Reflection\n(rule_based)"]
    end

    Reflect1 -- "writes facts (tags + provenance)" --> Store[(MemoryStore)]

    subgraph R2["RUN 2 — with prior knowledge"]
        direction LR
        Goal2[Related Goal] --> Researcher2["🔬 Researcher"]
        Researcher2 -- "research_notes" --> Reflect2["🪞 Reflection"]
    end

    Store -- "memoryRetriever({ tags })" --> Researcher2

    Reflect2 -- "writes new facts" --> Store
```

Each run follows the same loop:
1. Productive nodes (research, write, analyse) produce output into workflow state.
2. The reflection node reads `sourceKeys` from state, extracts facts, attaches tags + provenance, and calls `memoryWriter`.
3. On the next run, agents whose nodes declare `memoryQuery: { tags: [...] }` have those facts rendered into a `## Relevant Memory` section in their system prompt.

## When to use this pattern

- **Long-running research agents** that should improve as they accumulate domain knowledge.
- **Support / triage workflows** where lessons from past tickets should inform new ones.
- **Compounding pipelines** where every run adds vetted facts to a shared knowledge graph.
- **Domain bootstrapping** — extract a corpus of starter facts from a seed conversation, then have agents query that corpus.

*(If you only need ephemeral per-run memory, just use `WorkflowState.memory` — no reflection node required. If you want cross-run learning specifically, this is the pattern.)*

## Implementation example

Reflection requires two pieces of infrastructure outside the graph: a memory store (where facts live) and a `MemoryWriter` adapter the runner calls. The graph itself just declares a `reflection` node.

### 1. Memory store + writer + retriever

```typescript
import {
  InMemoryMemoryStore,
  InMemoryMemoryIndex,
  retrieveMemory,
} from '@cycgraph/memory';
import type {
  MemoryWriter,
  MemoryRetriever,
} from '@cycgraph/orchestrator';

const memoryStore = new InMemoryMemoryStore();
const memoryIndex = new InMemoryMemoryIndex();

const LESSON_TAG = 'graph:research-v1';

// Tracks which write scopes have already been persisted. The runner passes
// the same `idempotency_key` (`run_id:node_id:iteration`) when a write
// repeats for the same node execution — after a node retry or crash
// recovery — and a writer that ignores it duplicates facts in long-term
// memory on every retry.
const writtenScopes = new Map<string, string[]>();

const memoryWriter: MemoryWriter = async (facts, options) => {
  const scope = options?.idempotency_key;
  if (scope && writtenScopes.has(scope)) {
    return { fact_ids: writtenScopes.get(scope)! }; // already written — dedupe
  }

  const ids: string[] = [];
  for (const fact of facts) {
    const stored = {
      id: crypto.randomUUID(),
      content: fact.content,
      source_episode_ids: [],
      entity_ids: [],
      provenance: {
        source: fact.provenance.source,
        created_at: new Date(),
        run_id: fact.provenance.run_id,
        node_id: fact.provenance.node_id,
      },
      valid_from: new Date(),
      tags: fact.tags,
    };
    await memoryStore.putFact(stored);
    ids.push(stored.id);
  }
  if (scope) writtenScopes.set(scope, ids);
  return { fact_ids: ids };
};

const memoryRetriever: MemoryRetriever = async (query, options) => {
  const result = await retrieveMemory(memoryStore, memoryIndex, {
    tags: query.tags ?? [],
    max_hops: 0,
    limit: options?.maxFacts ?? 20,
    min_similarity: 0,
    include_invalidated: false,
  });
  return {
    facts: result.facts.map((f) => ({ content: f.content, validFrom: f.valid_from })),
    entities: result.entities.map((e) => ({ name: e.name, type: e.entity_type })),
    themes: result.themes.map((t) => ({ label: t.label })),
  };
};
```

### 2. The graph

The researcher node carries `memoryQuery: { tags: [LESSON_TAG] }` so the retriever fires before its prompt. The reflection node lives after it and writes back with the same tag.

```typescript
import { createGraph, GraphRunner } from '@cycgraph/orchestrator';

const graph = createGraph({
  name: 'Learning Research Agent',
  description: 'Research with compound learning across runs',
  nodes: [
    {
      id: 'research',
      type: 'agent',
      agentId: RESEARCHER_ID,
      readKeys: ['goal', 'constraints'],
      writeKeys: ['research_notes'],
      memoryQuery: { tags: [LESSON_TAG], maxFacts: 20 },
    },
    {
      id: 'reflect',
      type: 'reflection',
      readKeys: ['research_notes'],
      writeKeys: ['research_notes_reflection'],
      reflectionConfig: {
        sourceKeys: ['research_notes'],
        extractor: { type: 'rule_based', minSentenceLength: 25 },
        tags: ['lesson', LESSON_TAG],
      },
    },
  ],
  edges: [{ source: 'research', target: 'reflect' }],
  startNode: 'research',
  endNodes: ['reflect'],
});

const runner = new GraphRunner(graph, state, { memoryWriter, memoryRetriever });
```

## Extractor variants

The `extractor` discriminator on `reflectionConfig` picks the strategy:

### `rule_based`

Deterministic sentence-level extraction. Splits the concatenated source memory values into sentences, filters by `minSentenceLength`, dedupes (case-insensitive), emits one fact per unique sentence. **No LLM call** — free and predictable.

```typescript
extractor: { type: 'rule_based', minSentenceLength: 25 }
```

Use when source content is already structured as discrete sentences (agent notes, bullet lists).

### `llm`

Calls an extractor agent that distills the source into a bounded list of atomic, generalisable lessons. Each fact lands with `provenance.source === 'agent'`.

```typescript
extractor: {
  type: 'llm',
  agentId: REFLECTOR_ID,
  maxFacts: 5,
  instruction: 'Extract methodology lessons only.',  // optional override
}
```

Use when source content is freeform prose, or when you need the LLM to filter what's worth keeping.

## Core concepts

### Tags scope retrieval

The `tags` field on `reflectionConfig` is applied to every fact written by the node. When a downstream node declares `memoryQuery: { tags: [...] }`, only facts carrying at least one matching tag come back. Namespace tags by graph (`graph:research-v1`), category (`methodology`, `failure`), or both. This lets multiple graphs share a memory store without polluting each other's retrieval.

### Entities and the knowledge graph

`reflectionConfig.entityKeys` declares memory keys whose values name entities the produced facts relate to. The reflection executor reads those values and includes them as entity references on each written fact so the lesson stays reachable via entity-driven retrieval (`memoryQuery: { entityIds: [...] }`).

### Sanitising facts before persistence

Reflection writes whatever the extractor produces. If your agents handle PII, customer data, or anything sensitive, those values can land in the long-lived memory store. The `factSanitizer` hook on `GraphRunnerOptions` runs once per fact between extraction and the writer call. Returning `null` drops the fact; returning a modified fact substitutes it.

Fact content is also injection-sanitized automatically before persistence (the same denylist applied to memory before prompt embedding), closing a cross-run stored-injection channel — tainted external text distilled into a "lesson" can't carry instruction-override payloads into a future run's prompt.

```typescript
import type { FactSanitizer } from '@cycgraph/orchestrator';

const EMAIL = /\S+@\S+\.\S+/g;
const PHONE = /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g;

const factSanitizer: FactSanitizer = (fact) => {
  let content = fact.content;
  if (EMAIL.test(content)) content = content.replace(EMAIL, '[email redacted]');
  if (PHONE.test(content)) content = content.replace(PHONE, '[phone redacted]');
  return { ...fact, content };
};

const runner = new GraphRunner(graph, state, {
  memoryRetriever,
  memoryWriter,
  factSanitizer,
});
```

The sanitizer **fails closed** by default: if it throws (a downed PII service, a buggy regex), the fact is dropped rather than persisted unredacted — a transient outage must not silently leak PII into durable, cross-run memory. Set `factSanitizerFailMode: 'pass'` on `GraphRunnerOptions` to restore fail-open behavior (write the original fact on error) when reflection availability matters more than redaction guarantees.

### Capping reflection cost with `budget`

LLM-based reflection (`extractor: { type: 'llm' }`) can run away on long source content. Combine `reflectionConfig.extractor.maxFacts` with a per-node `budget` to cap both output size and spend:

```typescript
{
  id: 'reflect',
  type: 'reflection',
  readKeys: ['research_notes'],
  writeKeys: ['reflect_reflection'],
  reflectionConfig: {
    sourceKeys: ['research_notes'],
    extractor: { type: 'llm', agentId: REFLECTOR_ID, maxFacts: 5 },
    tags: ['lesson'],
  },
  budget: {
    maxTokens: 20_000,
    maxCostUsd: 0.05,
  },
}
```

Breaching either cap throws `NodeBudgetExceededError` — the reflection fails fast and downstream code can decide whether to skip persistence or retry with cheaper settings.

### Cost considerations

- `rule_based` extraction is free (no LLM call). It's the right default for most reflection use cases.
- `llm` extraction costs one extractor call per run. Cap `maxFacts` (default 10) to bound output token cost.
- The retriever side is free if your memory store is in-process. Production stores (`DrizzleMemoryStore`) cost a single Postgres + pgvector query per node-with-`memoryQuery`.

### Production swap

The example uses `InMemoryMemoryStore`. Swap to the Postgres-backed adapter when lessons need to survive process restarts:

```typescript
import { DrizzleMemoryStore, DrizzleMemoryIndex } from '@cycgraph/orchestrator-postgres';

const memoryStore = new DrizzleMemoryStore(db);
const memoryIndex = new DrizzleMemoryIndex(db);
// memoryWriter and memoryRetriever stay identical
```

The Postgres schema has a `tags jsonb` column on `memory_facts` (migration `0013_add_fact_tags`) and uses tag intersection for retrieval.

## Eval-gated retention (verified lessons)

By default every reflection fact persists forever. Eval-gating closes the loop: a lesson is **kept only if runs that used it verifiably scored better**.

The lifecycle is tag-driven:

```
candidate ──(runs with it beat the baseline)──▶ verified
    │
    ├──(runs with it score worse)──▶ invalidated 'eval-gate:harmful'
    └──(max_trials, no lift)───────▶ invalidated 'eval-gate:no_lift'
```

Three pieces wire it together:

**1. Tag new lessons as candidates** — purely a config change:

```typescript
reflectionConfig: {
  sourceKeys: ['critique'],
  extractor: { type: 'rule_based', minSentenceLength: 25 },
  tags: ['lesson', 'graph:my-graph-v1', 'candidate'],  // ← on trial
}
```

**2. Pass fact IDs through your retriever and attribute outcomes** — the runner records which facts were injected into each run's prompts (`memory._lesson_provenance`). After scoring the run however you like (evals harness, business KPI, LLM judge), feed the ledger:

```typescript
import { getInjectedFactIds } from '@cycgraph/orchestrator';
import { InMemoryOutcomeLedger, retrieveGatedLessons } from '@cycgraph/memory';

const ledger = new InMemoryOutcomeLedger();

// Retriever: verified-first, with exploration slots so candidates accrue trials.
// Passing `id` through is what makes attribution work — see the foot-gun below.
const memoryRetriever: MemoryRetriever = async (query) => {
  const facts = await retrieveGatedLessons(store, {
    tags: query.tags ?? ['lesson'],
    max_facts: 10,
    candidate_slots: 4,
    rest_after_trials: 5,  // bench fully-trialled candidates: frees slots AND creates baseline runs
    ledger,                // in-progress-first — trial cohorts graduate instead of churning
  });
  return {
    facts: facts.map((f) => ({ content: f.content, validFrom: f.valid_from, id: f.id })),
    entities: [],
    themes: [],
  };
};

const finalState = await runner.run();
const score = await scoreRunSomehow(finalState);  // your metric, normalised to [0,1]
await ledger.recordOutcome({
  run_id: finalState.run_id,
  score,
  fact_ids: getInjectedFactIds(finalState),
});
```

**3. Run the gate periodically:**

```typescript
import { evaluateRetention } from '@cycgraph/memory';

const report = await evaluateRetention(store, ledger, {
  min_trials: 3,          // evidence required before any decision
  promote_margin: 0.05,   // lift over leave-one-out baseline → verified
  evict_margin: 0.05,     // drop below baseline → evicted as harmful
  max_baseline_runs: 40,  // undecided by then → retired as no-lift
  // (max_trials alone can't fire here: rest_after_trials freezes trials)
});
// report.promoted / report.evicted / report.held — each with `evidence`
```

Eviction is a soft delete (`invalidated_by`), recoverable via `findFacts({ include_invalidated: true })`. The lift heuristic is correlational — facts are co-injected and run difficulty varies — so `min_trials` and the margins are the guardrails, not a causal proof.

### How much evidence does the gate need?

By default the gate uses real statistical inference (`decision_rule: 'inference'`), not a raw mean comparison: a Welch-style test on the lift against the leave-one-out baseline, with Benjamini–Hochberg control across the candidates tested in a pass and **alpha-spending across doubling baseline brackets** so that gating after every run doesn't inflate false positives (the peeking problem — our simulator measured a 25% false-decision rate without this control, 0–2% with it).

The trade-off is resolution. Measured operating characteristics with 5-trial cohorts at judge-noise SD 0.1:

<img src="/blog/gate-detection.svg" alt="Detection rate vs run volume per effect size" width="720" style="max-width:100%;height:auto;border:1px solid #e5e5e5;border-radius:8px;" />

| True effect | What happens |
|---|---|
| ±0.3 | correctly decided 94–100% of the time |
| ±0.2 | decided ~54–70%; the rest retired as `no_lift` |
| ±0.1 and below | mostly **retired, not falsely decided** (false decisions: 0–4%) |

The detectable-effect floor scales roughly with `promote_margin + 2.6 · noise_sd / √trials_per_cohort`. To resolve smaller effects: raise `rest_after_trials` (more evidence per cohort), reduce judge noise (more judge samples — `requiredTrials()` does the arithmetic), or accept that small effects get retired. **Measure your own policy before trusting it** — `gateOperatingCharacteristics()` runs the real pipeline against lessons of known effect in under a second; see `packages/evals/examples/gate-operating-characteristics/`.

Tuning fields on `RetentionPolicySchema`: `decision_rule` (`'inference'` | `'margin'`), `promote_confidence` / `evict_confidence` (default 0.9), `noise_floor_sd` (set to your judge's per-run SD), `multiple_comparison` (`'bh'` | `'none'`), `sequential_control` (`'doubling'` | `'none'`), and `max_baseline_runs` (closes the decision window for candidates the bracket penalty has made undecidable — pair it with `rest_after_trials`, since frozen trials mean `max_trials` alone can never fire). Every decision in the report carries an `evidence` object (`lift`, `se`, `df`, `p_promote`, `p_evict`, `alpha_bracket`) so "why was this held?" is inspectable.

**Foot-guns:**

- A retriever adapter that strips `id` from facts records no provenance — gating silently degrades to today's keep-everything behaviour.
- `candidate_slots: 0` means candidates are never retrieved, never accrue trials, and are held forever.
- Supervisor-node retrieval **is** provenance-tracked: the supervisor carries a `_lesson_provenance` entry on its `handoff`/`set_status` action and the matching reducer merges it append-only, so facts injected into a routing prompt are attributable to the run's outcome just like agent nodes.

## Runnable examples

- `packages/orchestrator/examples/learning-research-agent/` — the basic loop: a research workflow that runs twice on related goals and prints a side-by-side comparison of lessons injected / extracted / tokens / cost / duration.
- `packages/evals/examples/eval-gated-learning/` — the full gated loop, adversarially tested: three poisoned lessons are seeded into the store mid-experiment and the retention gate evicts them on outcome evidence alone, with a fitness chart showing the dip and recovery.
