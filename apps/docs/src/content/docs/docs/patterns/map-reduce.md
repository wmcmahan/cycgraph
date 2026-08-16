---
title: Map-Reduce
description: Process large datasets by mapping work across parallel agents and reducing results.
---

The **Map-Reduce** pattern is built for scale. It processes a massive collection of items by distributing the workload across a fleet of parallel worker nodes, and then aggregates their individual results via a final synthesizer node.

This cleanly bypasses the context window limits and slow latency of trying to process large lists sequentially.

## How it works

1. **Input**: A list of data items (documents, URLs, sub-topics) is present in the workflow's state memory.
2. **Fan Out (Map)**: The orchestrator launches a parallel worker agent for *each* item in the array simultaneously. Each worker receives just its single item as `map_item` in the `## Task Context` section of its prompt.
3. **Wait**: The map node halts workflow progression until every single parallel task has either completed or timed out.
4. **Aggregation (Synthesize)**: All the outputs from the workers are collected into a `mapper_results` array. A Synthesizer node reads this array and merges the fragments into a final, cohesive output.

## When to use this pattern

- **Document processing at scale**: summarize, classify, or extract from hundreds of documents that won't fit in a single context window.
- **Research fan-out**: break a broad topic into sub-topics and assign one researcher per sub-topic in parallel.
- **Bulk transformation**: translate, reformat, or annotate a list of items where each item is independent of the others.
- **Anything embarrassingly parallel**: if the work is naturally per-item and the items don't depend on each other, Map-Reduce is faster and cheaper than processing them sequentially in a loop.

## Implementation example

This example demonstrates a map-reduce pipeline where a Splitter breaks a broad topic into sub-topics, a Map node executes parallel Researchers for each sub-topic, and a Synthesizer merges the results. 

See the [full runnable code](https://github.com/wmcmahan/cycgraph/tree/main/packages/orchestrator/examples/map-reduce/map-reduce.ts).

### 1. The Splitter, Worker, and Synthesizer Agents

First, define the agent that produces the work list, the agent that processes individual items, and the agent that merges the results. Notice the specific variables their prompts address.

```typescript
import { agent } from '@cycgraph/orchestrator';

const splitter = agent({
  model: 'claude-sonnet-4-6',
  instructions: 'Break the goal into 3-6 independent sub-topics. Save them as a JSON array.',
  temperature: 0.3,
});

const researcher = agent({
  model: 'claude-sonnet-4-6',
  instructions: [
    'You are a research specialist focused on a single sub-topic.',
    'Your assigned sub-topic is provided as map_item in the Task Context section of your prompt.',
    'Produce concise, factual research notes about your specific sub-topic.',
  ].join(' '),
  temperature: 0.5,
});

const combiner = agent({
  model: 'claude-sonnet-4-6',
  instructions: [
    'You are a synthesis specialist.',
    'You receive parallel research results in mapper_results (an array of objects).',
    'Combine all research into a single, coherent summary that covers every sub-topic.',
  ].join(' '),
  temperature: 0.4,
});
```

### 2. The Map-Reduce Graph

Next, place the agents and configure the graph combining the `map` and `synthesizer` node types.

```typescript
import { node, mapReduce, synthesizer, graph } from '@cycgraph/orchestrator';

const split = node({
  id: 'splitter',
  agent: splitter,
  writes: 'topics',
});

const mapper = mapReduce('researcher', {
  id: 'mapper',
  reads: [split.writes],
  items: '$.memory.topics',
  concurrency: 5,
  onError: 'best_effort',
});

const worker = node({
  id: 'researcher',
  agent: researcher,
  writes: 'research',
});

const reduce = synthesizer({
  id: 'synthesizer',
  agent: combiner,
  reads: [mapper.results],
  writes: 'summary',
});

const workflow = graph({
  name: 'Fan-Out Map-Reduce',
  nodes: [split, mapper, worker, reduce],
  edges: [
    { from: split, to: mapper },
    { from: mapper, to: reduce },
  ],
  startNode: split,
  endNodes: [reduce],
});
```

## Core concepts

### Understanding map variables
When the map node launches your parallel workers, it hands each one a `## Task Context` section in its prompt with three fields. They arrive automatically. No `reads` entry is needed, because task context is a separate channel from the memory blackboard:
- `map_item`: The specific string, object, or number being processed by this worker.
- `map_index`: Which position in the array this item occupies (e.g. `0`, `1`, `2`).
- `map_total`: The total size of the input array.

### Model cost efficiency

Pair the right LLM tier with the right node.

- **The worker (Map)** fans out potentially hundreds of tasks simultaneously, so it should use the fastest, cheapest model available (e.g. `claude-haiku-4-5-20251001` or `gpt-4o-mini`). Workers do focused, narrow work, so complex reasoning is rarely required.
- **The synthesizer (Reduce)** receives the full array of outputs and *does* need heavy reasoning to deduplicate and find patterns across fragments. Use a frontier model (e.g. `claude-sonnet-4-6` or `gpt-4o`).
