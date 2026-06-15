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

**It self-verifies.** After the run it prints an `Assertions` block and
**exits non-zero** if the mechanism didn't behave as claimed — every poison
lesson evicted on trial evidence, fitness recovered after eviction, genuine
lessons promoted. A broken run fails loudly instead of printing a happy
summary, so you can gate a script on its exit code. The same invariants
live in [`verdict.ts`](./verdict.ts) (`computeVerdict`).

## Reproducible proof (no API key, runs in CI)

The live run is real but non-deterministic and costs money, so it can't
gate CI. The *gate* half of it is locked by a deterministic test —
[`packages/evals/test/eval-gated-learning-gate.test.ts`](../../test/eval-gated-learning-gate.test.ts) —
which drives the **same real `@cycgraph/memory` gate, ledger, and store**
with fixed synthetic outcomes (poison runs score low, genuine runs score
high). It asserts the poison is evicted and the genuine lessons promoted,
in <1s, on every push. (Provenance attribution from prompts — the other
half — is unit-tested in `@cycgraph/orchestrator`'s lesson-provenance
suite.) Run it with `npm test --workspace=packages/evals`.

## What a real run looks like

From the committed `results.json` (your numbers will vary — this is a
live experiment, not a fixture):

```
clean learning runs     avg fitness: 0.958
poison-trialled runs    avg fitness: 0.750   ← poison craters run 4 to 0.50
post-eviction runs      avg fitness: 0.972
poisoned lessons evicted: 3/3 (all gone after run 5, exactly min_trials later)
lessons promoted to verified: 6
```

**Known property, stated plainly:** the lift heuristic is correlational.
Genuine lessons co-injected with poison in a disaster run can be
co-evicted (three were, in the run above). Higher `min_trials` — or the
`inference` decision rule — reduces this at the cost of slower verdicts,
and eviction is a soft delete — recoverable via
`findFacts({ include_invalidated: true })`.

## Margin rule vs inference rule (read this before copying the config)

This demo pins `decision_rule: 'margin'` — the fast point-estimate rule —
because its narrative fits in 11 runs with 2-trial cohorts, and the poison
effect is enormous. The production default is `'inference'`: a Welch test
with false-discovery and sequential (peeking) control. Under the inference
rule this evidence **holds everything**: a 2-vs-2 comparison has ~1 degree
of freedom, and the gate correctly refuses to rule on that little evidence,
no matter how big the observed lift. That's not a claim to take on faith —
the deterministic test above asserts it directly: fed identical thin
evidence, the margin rule evicts all 3 poison while the inference rule
evicts **0** and holds all 5 candidates.

That's the trade in one sentence: the margin rule decides fast and is
trigger-happy on noise; the inference rule is statistically honest and
needs real evidence volume (≈4–5-trial cohorts and a dozen-plus baseline
runs for large effects). For your own workloads, measure the trade before
choosing: [`gate-operating-characteristics`](../gate-operating-characteristics/)
runs the real pipeline against lessons of known effect in under a second.

## The foot-gun to know about

Your `memoryRetriever` adapter must pass `id` through on each fact —
that's the thread provenance hangs on. An adapter that returns
`{ content, validFrom }` only will run fine but record nothing, and the
gate will hold every candidate forever.
