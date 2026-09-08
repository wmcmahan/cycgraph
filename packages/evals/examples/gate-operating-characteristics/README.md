# Gate Operating Characteristics

The "when can you trust the retention gate?" measurement. Runs the **real**
eval-gating pipeline (store → gated retrieval → ledger → `evaluateRetention`)
against synthetic lessons of *known* true effect, and reports how often the
gate reaches the right verdict — per effect size, run volume, and noise level.

No LLM, no API key, fully deterministic (seeded PRNG): ~half a second.

```bash
# from the repo root
npm install && npm run build
npx tsx packages/evals/examples/gate-operating-characteristics/gate-operating-characteristics.ts
```

Outputs `results.json`, `detection.svg` (detection rate vs run volume per
effect size), and `false-positives.svg` (the null-effect false-decision rate:
margin rule vs statistical inference).

## How to read the committed results

With the documented configuration (5-trial cohorts, `minTrials: 3`,
doubling sequential control, noise SD 0.1):

| True effect | Verdict measured | Rate by 25–100 runs |
|---|---|---|
| ±0.3 | correctly promoted / evicted-harmful | 94–100% |
| ±0.2 | correctly decided | ~54–70% (rest retired as no-lift) |
| ±0.1 | correctly decided | ≤16% — mostly retired, **not falsely decided** |
| ±0.05 and 0 | false decisions | **0–4%** |

The shape is deliberate: the gate is **conservative**. Below its resolution
(≈ |0.2| for 5-trial cohorts at this noise) it retires lessons as
`eval-gate:no_lift` instead of guessing. Want resolution on smaller effects?
The lever is evidence per cohort: raise `restAfterTrials` (detectable lift
shrinks roughly with `margin + 2.6·noise_sd/√trials`) or cut judge noise with
more judge samples — `requiredTrials()` in `@cycgraph/memory` does this
arithmetic for you.

## Why the gate needs sequential control (found by this simulator)

The first version of the inference gate re-tested every candidate on every
pass. On null-effect lessons it false-decided **25%** of the time at a
"90% confidence" setting — the classic peeking problem: many looks at
drifting data, each at full α. The shipped gate spends its error budget
across doubling baseline brackets (test at baseline 2, 4, 8, … runs with a
halving threshold), which caps total error by union bound no matter how
often you gate. The measured null false-decision rate after the fix: 0–2%.

Two more design facts this simulator surfaced, both now engine behavior:

- **The decision window is finite.** A rested candidate's evidence is frozen
  while the bracket threshold keeps tightening — past a few brackets it can
  never reach a verdict. `maxBaselineRuns` closes that window explicitly
  (retire as no-lift) instead of holding forever.
- **Co-injection blinds the gate.** Two opposite-effect lessons trialled in
  the same runs cancel in the outcome data and both get retired. That's the
  confound the leave-one-out heuristic cannot remove — stagger candidate
  arrivals (the trial-cohort retrieval does this naturally) or accept
  reduced resolution.

## Use it on YOUR policy

The point of shipping this as a library function is that none of the numbers
above are universal — they depend on your margins, confidences, cohort size,
and judge noise. Before trusting a policy in production:

```ts
import { gateOperatingCharacteristics } from '@cycgraph/memory';

const rows = await gateOperatingCharacteristics({
  effects: [-0.2, -0.1, 0, 0.1, 0.2],
  runCounts: [25, 100],
  noiseSds: [yourMeasuredJudgeSd],
  replicates: 50,
  seed: 1,
  retrieval: yourRetrievalConfig,
  policy: yourPolicy,
});
```

If the row for "effect you care about × runs you'll actually have" doesn't
show the detection rate you need, the gate will not deliver it in production
either — change the policy, not the expectation.
