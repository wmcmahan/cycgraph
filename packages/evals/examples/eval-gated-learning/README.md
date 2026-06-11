# Eval-Gated Learning

The "verified lessons" loop, end to end — including an adversarial test:
**we poison the memory store on purpose, and the retention gate heals it.**

## The three acts

| Act | Runs | What happens |
|---|---|---|
| Clean learning | 1–3 | Reflection writes lessons tagged `candidate`; scores climb; the gate **promotes** lessons whose runs beat the leave-one-out baseline → `verified` |
| Sabotage | 4–6 | Three poisoned candidate lessons are seeded ("omit counterarguments", "never cite sources", "no confidence labels"); the gated retriever trials them; scores dip |
| Recovery | 7–9 | The gate **evicts** the poison (`invalidated_by: 'eval-gate:harmful'`) on outcome evidence alone; scores recover with no human touching the store |

## The mechanism

1. **Provenance** — the orchestrator records which fact IDs were injected
   into each run's prompts (`memory._lesson_provenance`); read them with
   `getInjectedFactIds(finalState)`.
2. **Attribution** — after scoring each run (same external scorers as the
   [compound-learning benchmark](../compound-learning-benchmark/)), the
   score is recorded against those facts:
   `ledger.recordOutcome({ run_id, score, fact_ids })`.
3. **The gate** — `evaluateRetention(store, ledger, policy)` compares each
   candidate's mean run score against the leave-one-out baseline:
   lift ≥ margin → promote; drop ≥ margin → evict as harmful; no lift by
   `max_trials` → evict as useless.
4. **Gated retrieval** — `retrieveGatedLessons()` fills the prompt budget
   verified-first, reserving exploration slots filled **in-progress-first**
   (pass the `ledger`) so candidates — including the poison — accrue the
   trials the gate needs instead of churning through the slots. The demo's
   writer also dedupes lesson content: an unbounded candidate pool rotates
   faster than evidence can accrue.

The agents never see the rubric, the scores, or the gate. The only path
from "this lesson hurts" to "this lesson is gone" is measured outcomes.

## Run it

```bash
# from the repo root
npm install && npm run build
ANTHROPIC_API_KEY=sk-ant-... npx tsx packages/evals/examples/eval-gated-learning/eval-gated-learning.ts
```

~10 minutes, under $1. Writes `results.json` (per-run scores, injected
fact IDs, every gate report) and `chart.svg` (fitness per run; red dots
mark runs that had poison in the prompt).

## What a real run looks like

From the committed `results.json` (your numbers will vary — this is a
live experiment, not a fixture):

```
clean learning runs     avg fitness: 0.813
poison-trialled runs    avg fitness: 0.521   ← poison craters run 4 to 0.25
post-eviction runs      avg fitness: 0.764
poisoned lessons evicted: 3/3 (all gone after run 5, exactly min_trials later)
lessons promoted to verified: 4
```

**Known property, stated plainly:** the lift heuristic is correlational.
A genuine lesson co-injected with poison in a disaster run can be
co-evicted (one was, in the run above). Higher `min_trials` reduces
this at the cost of slower verdicts, and eviction is a soft delete —
recoverable via `findFacts({ include_invalidated: true })`.

## The foot-gun to know about

Your `memoryRetriever` adapter must pass `id` through on each fact —
that's the thread provenance hangs on. An adapter that returns
`{ content, validFrom }` only will run fine but record nothing, and the
gate will hold every candidate forever.
