---
"@cycgraph/evals": patch
---

`writeGoldenDataset` now only starts from an empty manifest when `golden/manifest.json` does not exist; a manifest that exists but fails JSON or schema validation throws instead of being silently replaced. This prevents a corrupt or out-of-date manifest from wiping every other suite's dataset registration on the next write. The manifest is read and validated before the compressed dataset is written, so a failed write also leaves the existing `.sqlite.gz` and its recorded checksum in sync.
