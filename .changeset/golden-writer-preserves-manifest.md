---
"@cycgraph/evals": patch
---

`writeGoldenDataset` now only starts from an empty manifest when `golden/manifest.json` does not exist; a manifest that exists but fails JSON or schema validation throws instead of being silently replaced. This prevents a corrupt or out-of-date manifest from wiping every other suite's dataset registration on the next write.
