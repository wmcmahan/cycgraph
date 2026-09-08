# Context Engine + Memory

A 2-node linear workflow that integrates persistent memory (`@cycgraph/memory`) and context compression (`@cycgraph/context-engine`) with the orchestrator. Demonstrates the full memory lifecycle: seed prior knowledge, run a workflow with memory-augmented prompts, ingest output back into memory, consolidate duplicates, and detect conflicts.

## Graph

```mermaid
flowchart LR
    research["🔬 research\n(agent)"]
    write["✍️ write\n(agent)"]

    research -- always --> write
```

Both nodes declare `memoryQuery: { tags: ['llm-knowledge'], maxFacts: 10 }`, which is what activates `memoryRetriever` for them. Seeded facts are tagged `llm-knowledge` at ingest, so retrieval is scoped to that corpus. Compressed context arrives via `contextCompressor`.

## Lifecycle & State

```mermaid
sequenceDiagram
    participant U as Caller
    participant M as MemoryStore
    participant CE as ContextEngine
    participant R as GraphRunner
    participant RN as research (agent)
    participant WN as write (agent)

    Note over M: Seed: prior conversation → episodes → facts → themes

    U->>R: runner.run()

    R->>M: memoryRetriever(query)
    M-->>R: facts, entities, themes
    R->>CE: contextCompressor(memory)
    CE-->>R: compressed string + metrics

    R->>RN: execute (reads: goal, constraints + memory context)
    RN->>RN: LLM call → research notes

    R->>M: memoryRetriever(query)
    R->>CE: contextCompressor(memory)

    R->>WN: execute (reads: goal, research_notes + memory context)
    WN->>WN: LLM call → polished draft

    R-->>U: return finalState

    Note over M: Ingest: workflow output → episodes → facts → themes
    Note over M: Consolidate: dedup, decay, theme cleanup
    Note over M: Conflict detection: negation, supersession
```

## What it demonstrates

### Memory system (`@cycgraph/memory`)

| Feature | Where |
|---------|-------|
| `SimpleEpisodeSegmenter` | Groups messages into topic-coherent episodes by time gap |
| `RuleBasedExtractor` | Extracts atomic facts, entities (person, org, concept), and relationships from episodes |
| `ConsolidatingThemeClusterer` | Clusters facts into themes with merge pass to prevent proliferation |
| `retrieveMemory` | Hierarchical top-down retrieval: themes → facts → episodes → entities |
| `MemoryConsolidator` | Deduplicates near-identical facts, decays old facts, cascades to themes |
| `ConflictDetector` | Detects negation, supersession, and semantic contradiction between facts |

### Context engine (`@cycgraph/context-engine`)

| Feature | Where |
|---------|-------|
| `createIncrementalPipeline` | Caches unchanged segments between turns; tracks per-segment output hashes |
| `createFormatStage` | Auto-detects data shape and serializes to token-efficient format |
| `createExactDedupStage` | Hash-based identical content removal |
| `createFuzzyDedupStage` | Trigram Jaccard similarity with MinHash LSH pre-filter |
| `createAllocatorStage` | Priority-weighted token budget distribution |
| `logger` option | Pipeline warnings routed to the example's structured logger |
| `timeoutMs` | Pipeline-level timeout to bound compression latency |

### Orchestrator integration

| Adapter | Purpose |
|---------|---------|
| `contextCompressor` | Compresses serialized memory before prompt injection; falls back to `JSON.stringify` if absent |
| `memoryRetriever` | Retrieves relevant facts from the knowledge graph for prompt augmentation |
| `memory_query` | Per-node directive (`memoryQuery` in the facade) that activates the retriever; without it the retriever sits dormant |

## Run

```bash
cd packages/orchestrator
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/context-and-memory/context-and-memory.ts

# or free, against a local model:
CYCGRAPH_MODEL=qwen2.5:7b npx tsx examples/context-and-memory/context-and-memory.ts
```

## Expected Output

```
═══ Context Engine + Memory Example ═══

Step 1: Seeding memory from prior conversation...
  Seeded memory with 4 messages from a prior conversation
  Facts extracted: 8
  Entities detected: 5
  Themes clustered: 3

Step 2: Running research-and-write workflow...
  contextCompressor: incremental pipeline (format + dedup + allocator)
  memoryRetriever: hierarchical top-down retrieval

  Node started: research (agent)
  Context compressed: 32.4% reduction (3ms)
  Node complete: research (2450ms)
  Node started: write (agent)
  Context compressed: 28.1% reduction (1ms)
  Node complete: write (1920ms)

Step 3: Ingesting workflow output into memory...

Step 4: Running memory consolidation...
  Deduped: 2, Decayed: 0, Themes cleaned: 1

Step 5: Running conflict detection...
  Conflicts found: 0

═══ Research Notes ═══
• Transformers use self-attention to process sequences in parallel ...

═══ Final Draft ═══
Large language models are AI systems trained on vast amounts of text ...

═══ Memory System State ═══
  Active facts:    14
  Entities:        9
  Themes:          4

═══ Workflow Stats ═══
  Tokens used:     1680
  Cost (USD):      $0.0101
```
