# Supervisor Routing

A 4-node cyclic hub-and-spoke workflow where a Supervisor agent dynamically routes work between Research, Write, and Edit specialists using LLM-powered decisions. Demonstrates the supervisor pattern, cyclic graphs, dynamic routing, and the `__done__` sentinel for termination.

## Graph

```mermaid
flowchart TD
    supervisor["🎯 supervisor\n(supervisor)"]
    research["🔬 research\n(agent)"]
    write["✍️ write\n(agent)"]
    edit["✏️ edit\n(agent)"]

    supervisor -- route --> research
    supervisor -- route --> write
    supervisor -- route --> edit
    research -- return --> supervisor
    write -- return --> supervisor
    edit -- return --> supervisor
    supervisor -. "__done__" .-> done["✅ complete"]
```

## Lifecycle & State

```mermaid
sequenceDiagram
    participant U as Caller
    participant R as GraphRunner
    participant SV as supervisor
    participant RN as research (agent)
    participant WN as write (agent)
    participant EN as edit (agent)
    participant S as WorkflowState

    U->>R: runner.run()
    R->>S: status = running
    Note over S: memory: {}

    R->>SV: execute (reads: team outputs)
    SV->>SV: LLM decides → route to "research"
    SV->>S: supervisor_history: [{to: "research"}]

    R->>RN: execute (reads: goal, constraints)
    RN->>RN: LLM call → research notes
    RN->>S: reducer: set memory.research_notes
    Note over S: memory: { research_notes: "..." }

    R->>SV: execute (reads: team outputs)
    SV->>SV: LLM decides → route to "write"
    SV->>S: supervisor_history: [..., {to: "write"}]

    R->>WN: execute (reads: goal, research_notes)
    WN->>WN: LLM call → draft article
    WN->>S: reducer: set memory.draft
    Note over S: memory: { research_notes: "...", draft: "..." }

    R->>SV: execute (reads: team outputs)
    SV->>SV: LLM decides → route to "edit"
    SV->>S: supervisor_history: [..., {to: "edit"}]

    R->>EN: execute (reads: goal, draft)
    EN->>EN: LLM call → polished article
    EN->>S: reducer: set memory.final_draft
    Note over S: memory: { ..., final_draft: "..." }

    R->>SV: execute (reads: team outputs)
    SV->>SV: LLM decides → route to "__done__"

    R->>S: status = completed
    R->>U: return finalState
```

## State Slicing

Each node only sees the keys it declares; the engine enforces zero-trust boundaries. The supervisor declares no grants of its own: its reads derive from what its managed nodes write, so it sees its team's outputs rather than the whole blackboard, and its routing writes (`handoff`, completion) are implied by the node type.

```mermaid
block-beta
    columns 4

    block:state["WorkflowState (blackboard)"]:4
        goal constraints research_notes draft final_draft
    end

    space:4

    block:sv["supervisor node"]
        sv_read["reads: derived (team outputs)"]
        sv_write["writes: routing (implied)"]
    end

    block:rn["research node"]
        r_read["reads: goal, constraints"]
        r_write["writes: research_notes"]
    end

    block:wn["write node"]
        w_read["reads: goal, research_notes"]
        w_write["writes: draft"]
    end

    block:en["edit node"]
        e_read["reads: goal, draft"]
        e_write["writes: final_draft"]
    end
```

## Run

```bash
cd packages/orchestrator
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/supervisor-routing/supervisor-routing.ts
```

## Expected Output

```
[INFO] Starting supervisor-routing workflow...
[INFO] Workflow started: <run-id>
[INFO]   Node started: supervisor (supervisor)
[INFO]   Node complete: supervisor (1200ms)
[INFO]   Node started: research (agent)
[INFO]   Node complete: research (2340ms)
[INFO]   Node started: supervisor (supervisor)
[INFO]   Node complete: supervisor (980ms)
[INFO]   Node started: write (agent)
[INFO]   Node complete: write (2100ms)
[INFO]   Node started: supervisor (supervisor)
[INFO]   Node complete: supervisor (870ms)
[INFO]   Node started: edit (agent)
[INFO]   Node complete: edit (1950ms)
[INFO]   Node started: supervisor (supervisor)
[INFO]   Node complete: supervisor (650ms)
[INFO] Workflow complete: <run-id> (10090ms)

═══ Supervisor Routing History ═══
  [iter 0] → research (Need factual research before writing)
  [iter 2] → write (Research complete, ready to draft)
  [iter 4] → edit (Draft needs polish)
  → __done__ (workflow completed)

═══ Research Notes ═══
• Solar energy capacity grew 26% globally in 2024 ...

═══ Draft ═══
The global power grid is undergoing a historic transformation ...

═══ Final Draft ═══
The way the world generates electricity is changing faster than ...

═══ Stats ═══
  Nodes visited:  supervisor → research → supervisor → write → supervisor → edit → supervisor
  Tokens used:    4821
  Cost (USD):     $0.0289
```
