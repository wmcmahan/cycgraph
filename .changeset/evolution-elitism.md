---
"@cycgraph/orchestrator": minor
---

Fix: `evolution_config.elite_count` is now actually implemented (it was a no-op).

The schema and validator advertised `elite_count` and rejected `elite_count >= population_size`, but the executor never used it — every generation was bred entirely from scratch, so the per-generation best fitness could dip when a noisy generation produced worse candidates than the last.

Elitism now works as documented: the top `elite_count` candidates of each generation are carried forward **unchanged** into the next generation's pool — not re-generated and not re-scored. Two consequences:

- **Monotonic fitness.** The best-so-far re-enters every subsequent pool, so the next generation's best is always ≥ the current one. `${node}_fitness_history` never dips. (Set `elite_count: 0` to opt out and restore the old all-fresh behavior.)
- **Fewer LLM calls.** A carried elite occupies a population slot without a generation or evaluation call, so each generation after the first issues `population_size - elite_count` candidate calls instead of `population_size`.

`elite_count` defaults to `1`, so this changes default evolution behavior. The carried candidate is tagged `is_elite: true` in the `${node}_population` summary. `elite_count` is internally clamped to `population_size - 1` so at least one fresh candidate is always generated.
