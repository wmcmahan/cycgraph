# Eval Loop

A 3-node cyclic workflow demonstrating **conditional edges** and **iterative refinement**. A Writer drafts content, an Evaluator scores it, and the graph either loops back for revision or forwards to a Publisher once quality is met.

Unlike the built-in annealing node (which encapsulates the loop internally), this example uses explicit nodes connected by conditional edges — making the cycle visible in the graph topology.

## Graph

```mermaid
flowchart LR
    writer["✍️ writer\n(agent)"]
    evaluator["🔍 evaluator\n(agent)"]
    publisher["📰 publisher\n(agent)"]

    writer -- always --> evaluator
    evaluator -- "number(score) < 0.8" --> writer
    evaluator -- "number(score) >= 0.8" --> publisher
```

## Lifecycle & State

```mermaid
sequenceDiagram
    participant U as Caller
    participant R as GraphRunner
    participant W as writer (agent)
    participant E as evaluator (agent)
    participant P as publisher (agent)
    participant S as WorkflowState

    U->>R: runner.run()
    R->>S: status = running
    Note over S: memory: {}

    loop until score >= 0.8
        R->>W: execute (reads: goal, constraints, feedback, suggestions, draft)
        W->>W: LLM call → write/revise draft
        W->>S: reducer: set memory.draft
        R->>R: persist state, follow edge (always)

        R->>E: execute (reads: goal, constraints, draft)
        E->>E: LLM call → score + feedback
        E->>S: reducer: set memory.score, feedback, suggestions
        R->>R: evaluate edges
        Note over R: score < 0.8 → writer<br/>score >= 0.8 → publisher
    end

    R->>P: execute (reads: goal, draft)
    P->>P: LLM call → polished final version
    P->>S: reducer: set memory.final_output
    R->>S: status = completed
    R->>U: return finalState
```

## Conditional Edges

The cycle is driven by two conditional edges from the evaluator:

| Edge | Condition | Behavior |
|------|-----------|----------|
| `evaluator → writer` | `number(memory.score) < 0.8` | Loop back — draft needs improvement |
| `evaluator → publisher` | `number(memory.score) >= 0.8` | Quality gate passed — publish |

Conditions are [filtrex](https://github.com/joewalnes/filtrex) expressions evaluated against `WorkflowState`. Edge order matters: the runner takes the first matching edge, so the loop-back edge is listed before the exit edge.

The `number()` wrapper coerces the score to a numeric type. This is important because `save_to_memory` uses `z.unknown()` and LLMs often serialize numbers as strings — without coercion, filtrex's strict mode rejects the comparison.

## State Slicing

```mermaid
block-beta
    columns 3

    block:state["WorkflowState (blackboard)"]:3
        goal constraints draft score feedback suggestions final_output
    end

    space:3

    block:wn["writer"]
        w_read["reads: goal, constraints,\nfeedback, suggestions, draft"]
        w_write["writes: draft"]
    end

    block:en["evaluator"]
        e_read["reads: goal, constraints, draft"]
        e_write["writes: score, feedback,\nsuggestions"]
    end

    block:pn["publisher"]
        p_read["reads: goal, draft"]
        p_write["writes: final_output"]
    end
```

## Run

```bash
cd packages/orchestrator
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/eval-loop/eval-loop.ts

# or free, against a local model:
CYCGRAPH_MODEL=qwen2.5:7b npx tsx examples/eval-loop/eval-loop.ts
```

## Expected Output

```
[INFO] Starting eval-loop workflow...
[INFO] Workflow started: <run-id>
[INFO]   Node started: writer (agent)
[INFO]   Node complete: writer (2100ms)
[INFO]   Node started: evaluator (agent)
[INFO]   Node complete: evaluator (1800ms)
[INFO]   Node started: writer (agent)
[INFO]   Node complete: writer (2400ms)
[INFO]   Node started: evaluator (agent)
[INFO]   Node complete: evaluator (1600ms)
[INFO]   Node started: publisher (agent)
[INFO]   Node complete: publisher (1500ms)
[INFO] Workflow complete: <run-id> (9400ms)

═══ Results ═══
  Iterations: 2 evaluation round(s)
  Final score: 0.85
  Path: writer → evaluator → writer → evaluator → publisher

═══ Evaluator Feedback (last round) ═══
The draft effectively covers qubits, superposition, and entanglement ...

═══ Published Output ═══
Quantum computing is a revolutionary approach to computation ...

═══ Stats ═══
  Tokens used: 4210
  Cost (USD):  $0.0253
```
