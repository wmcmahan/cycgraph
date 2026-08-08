# Eval Suites

Example eval suites demonstrating the `@cycgraph/orchestrator` eval framework. Each suite authors a graph with the facade vocabulary (`node()` placements compiled by `graph()`), seeds input data, and asserts against the final workflow state.

## Available Suites

| Suite | What It Tests |
|-------|--------------|
| [linear-completion](./linear-completion.ts) | 2-node tool pipeline runs to completion with results in memory |
| [supervisor-routing](./supervisor-routing.ts) | Router dispatches to a worker node and completes |
| [hitl-approval](./hitl-approval.ts) | Approval gate pauses workflow in `waiting` status |

## Writing Your Own

```typescript
import { graph, node, type EvalSuite } from '@cycgraph/orchestrator';

const work = node({ id: 'my_node', type: 'tool', toolId: 'my_tool', reads: ['*'], writes: ['*'] });

const myGraph = graph({ name: 'My Graph', nodes: [work] });

export const suite: EvalSuite = {
  name: 'My Suite',
  cases: [
    {
      name: 'Case description',
      graph: myGraph,
      input: { goal: 'Do something' },
      assertions: [
        { type: 'status_equals', expected: 'completed' },
        { type: 'node_visited', node_id: 'my_node' },
        { type: 'memory_contains', key: 'result' },
        { type: 'memory_matches', key: 'score', pattern: '', mode: 'exact', expected: 42 },
        { type: 'token_budget_respected' },
        // LLM-as-judge (requires API key):
        { type: 'llm_judge', criteria: 'Is the output clear?', threshold: 0.8, evaluator_agent_id: 'eval-agent' },
      ],
    },
  ],
};
```

Run with `runEval()`:

```typescript
import { runEval } from '@cycgraph/orchestrator';
import { suite } from './my-suite.js';

const report = await runEval(suite);
console.log(`Score: ${(report.overall_score * 100).toFixed(1)}%`);
```
