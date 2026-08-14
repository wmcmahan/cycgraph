---
"@cycgraph/orchestrator": minor
---

Terse authoring helpers for every node type.

`subgraph()` and `a2a()` were the only node types with a dedicated helper;
the other eleven went through `node({ type, xConfig })` with a nested config
block. Each type now has its own helper, leading with the thing it delegates
to where it has one:

    supervisor(brain,     { id, manages, maxIterations })
    mapReduce(worker,     { id, items, into, concurrency })
    runTool('fetch_data', { id, reads })
    voting([a, b, c],     { id, strategy, quorum })
    evolution(candidate,  { id, evaluator, populationSize })
    reflection(['notes'], { id, extractor, tags })
    verifier.llmJudge(judge, { id, target, threshold })
    verifier.expression(expr, { id })
    verifier.jsonPath(target, { id, path, assertion })
    approval({ id, prompt, reviewKeys, onReject })
    router({ id, reads })
    synthesizer({ id, reads, agent, writes })

Additive: `node()` remains, and is still the path for dynamic or generated
graphs. Helpers compile to the same snake_case wire nodes, so persisted
graphs, the architect, and existing consumers are unaffected.

Helpers omit `writes` for the types whose executor owns its result keys, so
an author cannot declare grants that disagree with what the node actually
writes. `synthesizer` keeps `writes`, because with an agent it authors output
like an agent node and only the agentless merge uses the implied key.
