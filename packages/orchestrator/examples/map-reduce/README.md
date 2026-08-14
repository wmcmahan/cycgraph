# Fan-Out Map-Reduce

Parallel research with LLM-powered synthesis. A Splitter decomposes a topic, a Map node fans out to parallel Researcher workers, and a Synthesizer merges everything into a unified summary.

## Graph

```mermaid
flowchart LR
  splitter["Splitter<br/>(agent)"]
  mapper["Mapper<br/>(map)"]
  r1["Researcher<br/>(worker)"]
  r2["Researcher<br/>(worker)"]
  rN["Researcher<br/>(worker)"]
  synthesizer["Synthesizer<br/>(synthesizer + agent)"]

  splitter --> mapper
  mapper -.->|fan-out| r1 & r2 & rN
  r1 & r2 & rN -.->|collect| mapper
  mapper --> synthesizer
```

## Sequence Diagram

```mermaid
sequenceDiagram
  participant S as Splitter
  participant M as Mapper
  participant R1 as Researcher 1
  participant R2 as Researcher 2
  participant RN as Researcher N
  participant Syn as Synthesizer

  S->>M: topics = ["topic1", "topic2", ..., "topicN"]
  par Fan-out
    M->>R1: task context map_item = "topic1"
    M->>R2: task context map_item = "topic2"
    M->>RN: task context map_item = "topicN"
  end
  R1-->>M: research notes
  R2-->>M: research notes
  RN-->>M: research notes
  M->>Syn: mapper_results = [{index, updates}, ...]
  Syn->>Syn: Produce unified summary
```

## Lifecycle & State

```
┌─────────────┐     ┌──────────────────────────────────────┐     ┌──────────────┐
│  Splitter    │     │  Map Node (internal fan-out)          │     │  Synthesizer  │
│             │     │                                      │     │              │
│ reads:      │     │  items_path: $.memory.topics         │     │ reads:       │
│  goal       │     │                                      │     │  goal        │
│  constraints│     │  ┌────────┐ ┌────────┐ ┌────────┐   │     │  mapper_     │
│             │     │  │Worker 1│ │Worker 2│ │Worker N│   │     │   results    │
│ writes:     │     │  │        │ │        │ │        │   │     │              │
│  topics     │     │  │_map_   │ │_map_   │ │_map_   │   │     │ writes:      │
│  (array)    │     │  │ item   │ │ item   │ │ item   │   │     │  summary     │
└──────┬──────┘     │  │_map_   │ │_map_   │ │_map_   │   │     └──────────────┘
       │            │  │ index  │ │ index  │ │ index  │   │
       └───────────>│  └────────┘ └────────┘ └────────┘   │
                    │                                      │
                    │  writes: mapper_results, mapper_count│
                    └──────────────┬───────────────────────┘
                                   │
                                   └──────────────────────>
```

## Agents

| Agent | Model | Temp | Reads | Writes |
|-------|-------|------|-------|--------|
| Splitter | claude-sonnet-4 | 0.5 | `goal`, `constraints` | `topics` |
| Researcher | claude-sonnet-4 | 0.5 | `goal` (+ map item via Task Context) | `research` |
| Synthesizer | claude-sonnet-4 | 0.4 | `goal`, `mapper_results`, `mapper_count` | `summary` |

## Run

```bash
cd packages/orchestrator
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/map-reduce/map-reduce.ts
```

## Notes

- **Map node**: Resolves items via JSONPath (`$.memory.topics`), fans out to a worker node in parallel
- **Worker injection**: Each worker receives `map_item`, `map_index`, `map_total` in the `## Task Context` section of its prompt
- **Results convention**: Map stores results as `mapper_results` (array), `mapper_count`, `mapper_errors`, `mapper_error_count`
- **Synthesizer + agent_id**: Delegates to an LLM agent for intelligent synthesis (vs. simple concatenation)
- **Error strategy**: `best_effort` — partial failures don't block the overall workflow
