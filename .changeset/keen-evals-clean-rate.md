---
"@cycgraph/evals": minor
---

`SweepInputs.cleanRunRate` decides which question a budget-exhaustion finding asks: failing runs still motivate the correctness sweep (more room), but a loop that exhausts its budget while every run passes has a stop condition doing its job, so the finding stands aside and the profile's cost sweep claims the knob.
