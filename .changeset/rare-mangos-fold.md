---
"@cycgraph/orchestrator": patch
---

A tool declared inline on a node no longer has to be declared again on the runner.

`node({ tools: [probe] })` names the tool; `GraphRunner` then also required it on `GraphRunnerOptions.tools`, and omitting the second half failed preflight. `run()` threaded the closure for you, so only the explicit path carried the papercut.

`GraphRunner` now registers the inline tools a facade-authored graph carries. Gap-filling only: a tool supplied on options shadows an inline one of the same name, so an explicit override still overrides. Agents are deliberately not threaded — a caller supplying its own registry usually does so to change an agent's model, and auto-registering would fight that.
