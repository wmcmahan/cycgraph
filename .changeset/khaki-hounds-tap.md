---
"@cycgraph/orchestrator": patch
---

`strictKeys` turns a dangling read from a warning into an error.

A `read_keys` entry that no node writes resolves to an empty value at run time: the node produces something plausible from nothing and passes any assertion that only checks the key exists. The validator has always warned, but a warning on every run is a warning nobody reads.

Now that declared `inputs` count as producible, the check is unambiguous — a key that is neither produced by a node nor declared as an input is a mistake rather than a seeded value the validator cannot see. `strictKeys: true` on a graph makes it an error, refused at preflight with a message naming the fix. Reflection `source_keys` are held to the same standard.

Default stays warn-only, so nothing changes for existing graphs.
