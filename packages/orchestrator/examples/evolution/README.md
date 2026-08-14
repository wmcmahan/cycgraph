# Evolution

Population-based Darwinian selection. Each generation produces N candidates in
parallel, scores them, keeps the best, and breeds the next generation from the
winner plus the scorer's critique of it, until the output stops improving.

Scoring here is a deterministic function, not an LLM judge, so runs are
reproducible and cost nothing beyond candidate generation.

## Graph

```
evolve  (evolution node)
  ├── generation 1: 4 candidates in parallel → score → keep best
  ├── generation 2: bred from the winner + its critique → …
  └── stops on fitness_threshold, stagnation, or max_generations
```

A single node. The fan-out, scoring, selection, and breeding all happen inside
the evolution executor rather than as separate graph nodes.

## Lifecycle & State

| Key | Written by | Contents |
| --- | --- | --- |
| `evolve_winner` | evolution node | the best candidate and its output |
| `evolve_winner_fitness` | evolution node | the winning score |
| `evolve_winner_reasoning` | evolution node | the scorer's critique of the winner |
| `evolve_fitness_history` | evolution node | best fitness per generation |

The node also writes `evolve_generation`, `evolve_population`, and
`evolve_budget_stopped`; this example reads the four above.

All are implied write grants, so the node declares no `writes`.

## Run

```bash
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/evolution/evolution.ts

# or free, against a local model:
CYCGRAPH_MODEL=qwen2.5:7b npx tsx examples/evolution/evolution.ts
```

## Expected Output

```
  Gen 1: 0.75  ████████████████████████████
  Gen 2: 0.88  ███████████████████████████████████
  Gen 6: 0.95  ██████████████████████████████████████
  → stopped before the spec: the best candidate plateaued at a local optimum.

Winning tagline (fitness 0.95, 55 chars):
  Crashes? Cycgraph recovers agents fast, ensures uptime.
```

## Notes

**Why the fitness function is deterministic.** A capable model one-shots any
task you can fully describe in a prompt, which leaves nothing to evolve. This
example scores on an exact character and word count, something models cannot
do in one pass. A first attempt lands a few characters off, and each generation
reads the previous best plus "you're at 53 chars, target 55" and converges.

**How big a climb to expect.** A strong model writes a near-spec tagline almost
immediately, around 0.95 at generation 0, so the visible climb is short. It
improves a step or two, then either hits the spec or stalls one character
short and stagnation detection stops the run. A dramatic many-generation climb
needs a task that is genuinely hard across the board: verifiable code, real
search, actual optimization. A tagline demo cannot show that.

What it does show end to end is the full loop: a diverse parallel population,
selection of the best, feedback-driven refinement, elitism keeping the curve
from dipping, and early stopping.

**LLM-as-judge variant.** Set `evaluator` on the `evolution()` spec to an
`agent()` value and drop `fitnessFunction`. On a strong model a simple judged
task tends to ace generation 0, which is why this example does not use one.
