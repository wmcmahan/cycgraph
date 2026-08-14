# Evolution with Deterministic Fitness — Regex Matcher

The classic [evolution](../evolution/) example uses an LLM-as-judge to score candidates. That works for subjective creative tasks (taglines, copy, prose) but suffers from judge variance — fitness scores can plateau or jitter even when the actual outputs improve.

This example shows the **deterministic-fitness path**: a `fitnessFunction` callback on `GraphRunnerOptions` replaces the LLM judge entirely. The score for each candidate is computed by running the produced regex against a fixed corpus — no LLM, no variance, no judge tokens.

Result: a visibly clean fitness climb across generations, ending with a regex that classifies all 14 test cases correctly.

## Graph

Evolves a regex that matches HTTP 4xx status codes (`400`–`499`) **except** the three most common — `401`, `403`, `404` — and rejects everything else.

- **Matches**: `400`, `402`, `405`, `406`, `408`, `409`, `410`, `418`, `422`, `429`, `451`, `499`
- **Rejects**: `401`, `403`, `404`, `200`, `301`, `500`, `304`, `100`, `4000` (too long), `40` (too short), `xyz`

### Why this task, and an honest note about fitness shape

The exclusion list is hard for a regex engine: the candidate has to encode a negative. The naive `^4\d{2}$` catches every 4xx but lets `401`, `403`, `404` through. A correct regex needs either negative lookahead (`^4(?!01|03|04)\d{2}$`) or explicit enumeration.

**Honest disclosure**: modern LLMs (Haiku 4.5, Sonnet, Opus) are good enough that they typically write the *correct* exclusion regex on generation 0. Empirically we couldn't find any well-specified regex task — IPv4 octet bounds, dates, status codes with exclusions — that current-generation models *don't* one-shot. The fitness-history "climb" demos you might have seen on weaker models from 2023 don't reproduce on 2026 models.

Rather than fight that with synthetic tasks, this example **runs all `max_generations` regardless of fitness** (the threshold is set above 1.0). The visible output is then:

- 4 generations × 4 candidates = 16 parallel LLM calls
- Parent regex and per-test reasoning propagated to every subsequent generation via the `parent` / `parent_reasoning` Task Context fields
- Temperature annealed from 1.0 to 0.3 across generations
- Deterministic fitness function called for every candidate
- Cost-tracking that aggregates across all generations

That's the proof the engine works mechanically. The fitness bars may all be 1.0 — that just means Haiku is too capable for *this* task. Generation-over-generation climbing requires either a substantially weaker candidate model, an LLM-unsolvable task, or both.

### Where this pattern *does* show climbing

If your downstream use case involves:
- Tasks the candidate model genuinely cannot one-shot (highly domain-specific code generation, novel rule-system synthesis)
- Population-based prompt optimisation where the variance across candidates is the point
- Searches over large discrete spaces where the LLM has to enumerate (selecting subsets, configuration tuning)

…then the engine wiring exposed by this example is exactly what you want, and the fitness climbing emerges naturally.

Fitness = `correctly classified / total` (23 test cases).

### Model

The example uses `claude-haiku-4-5-20251001` to keep cost low. Stronger models work the same way.

## Run

```bash
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/evolution-regex/evolution-regex.ts
```

Expected output:

```
═══ Target corpus ═══
Should MATCH:
  ✓ 400
  ✓ 402
  ...
Should REJECT:
  ✗ 401
  ✗ 403
  ✗ 404
  ...

═══ Evolution Results ═══
Status: completed

Winning regex:
  ^4(?!01|03|04)\d{2}$
  Fitness: 1.0

Fitness history (best per generation):
  Gen 1: 0.870 ███████████████████████████████████
  Gen 2: 1.000 ████████████████████████████████████████

Per-test detail for the winner:
  ✓ match  400
  ...
  ✓ reject 401
  ✓ reject 403
  ✓ reject 404

Tokens used: ~3,500
Cost (USD):  $0.0040

(Fitness scoring used a deterministic function — no LLM judge tokens.)
```

Exact numbers vary across runs — LLM output is non-deterministic. The shape (under-1.0 first generation → climb → 1.0) is what proves evolution is wiring through correctly.

## The key code

```typescript
import { agent, node, graph, state, agentsForGraph, GraphRunner, InMemoryAgentRegistry } from '@cycgraph/orchestrator';
import type { FitnessFunction } from '@cycgraph/orchestrator';

const SHOULD_MATCH = ['400', '402', '405', /* ... */];
const SHOULD_REJECT = ['401', '403', '404', '200', /* ... */];

const fitnessFunction: FitnessFunction = async (output) => {
  const candidate = (output as { candidate_output?: string }).candidate_output ?? '';

  let regex: RegExp;
  try { regex = new RegExp(candidate); }
  catch { return { score: 0, reasoning: 'Invalid regex' }; }

  let hits = 0;
  for (const s of SHOULD_MATCH) if (regex.test(s)) hits++;
  for (const s of SHOULD_REJECT) if (!regex.test(s)) hits++;

  const total = SHOULD_MATCH.length + SHOULD_REJECT.length;
  return { score: hits / total };
};

// The candidate is authored as a facade agent() and placed in an evolution node.
// `candidateAgentId` accepts the agent() value directly — graph() resolves it.
const candidate = agent({ model: 'claude-haiku-4-5-20251001', instructions: '…' });
const evolve = node({
  id: 'evolve',
  type: 'evolution',
  agent: candidate,
  reads: ['*'],
  writes: '*',
  evolutionConfig: { candidateAgentId: candidate, populationSize: 4, maxGenerations: 4 },
});
const g = graph({ name: 'Regex Evolution', nodes: [evolve], edges: [], startNode: evolve, endNodes: [evolve] });

// A JS fitnessFunction can't ride on the serializable graph, so run through an
// explicit GraphRunner. Re-pin the candidate's write ceiling to `candidate_output`
// (a facade agent() carries no permissions, and evolution grants each candidate
// write_keys ['*'], so the ceiling is what routes its text to that key).
const registry = new InMemoryAgentRegistry();
for (const config of agentsForGraph(g)) {
  registry.register({ ...config, permissions: { readKeys: ['*'], writeKeys: ['candidate_output'] } });
}
const runner = new GraphRunner(g, state({ workflowId: g.id, goal: '…' }), { registry, fitnessFunction });
```

The evolution node config drops `evaluatorAgentId` entirely — the runner-supplied `fitnessFunction` takes over.

## When to use this pattern

- Tasks with a **verifiable** answer: code, regex, SQL, math, JSON-shape conformance.
- When you've seen the LLM judge plateau or jitter and want clean, monotonic climbing.
- When token budget for evaluation is a concern — deterministic fitness is free.

Stick with the LLM-as-judge `evaluatorAgentId` for tasks with no objective answer (creative writing, design rationale, subjective quality).
