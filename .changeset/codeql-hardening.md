---
"@cycgraph/orchestrator": patch
"@cycgraph/context-engine": patch
"@cycgraph/evals": patch
"@cycgraph/studio": patch
"@cycgraph/tools": patch
---

Resolve CodeQL findings: the state view's dot-notation merge and the studio flag parser refuse `__proto__`, `constructor` and `prototype` path segments; the heuristic scorer, judge-response parser, bundle id slug, and HTML-to-markdown whitespace cleanup no longer use regexes with polynomial backtracking; the studio API sends a fixed label instead of `String(err)` for non-Error throws; and the improve workspace passes `--` to `git clone` so a repository path cannot be read as an option.
