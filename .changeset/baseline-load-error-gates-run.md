---
"@cycgraph/evals": patch
---

`runEvals` now surfaces a failed baseline load as `baselineLoadError` instead of swallowing it: baseline comparison and the baseline rewrite are both skipped, and the CLI exits `1`. A corrupt snapshot or unknown schema version can no longer be reported as a clean run with no regression.
