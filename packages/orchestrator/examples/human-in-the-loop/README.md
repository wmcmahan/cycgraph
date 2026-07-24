# Human-in-the-Loop

A 3-node linear workflow with an approval gate that pauses execution for human review. A Writer agent produces a draft, the workflow pauses at an approval gate for human review, and upon approval a Publisher agent finalizes the article. Demonstrates approval gates, workflow pausing/resuming, review data filtering, and the HITL resume flow.

## Graph

```mermaid
flowchart LR
    write["✍️ write\n(agent)"]
    review["👤 review\n(approval)"]
    publish["📰 publish\n(agent)"]

    write -- always --> review
    review -- approved --> publish
    review -. "rejected" .-> stop["🛑 rejected"]
```

## Lifecycle & State

```mermaid
sequenceDiagram
    participant U as Caller
    participant R as GraphRunner
    participant WN as write (agent)
    participant AN as review (approval)
    participant H as Human Reviewer
    participant PN as publish (agent)
    participant S as WorkflowState

    U->>R: runner1.run()
    R->>S: status = running
    Note over S: memory: {}

    R->>WN: execute (reads: goal, constraints)
    WN->>WN: LLM call → draft article
    WN->>S: reducer: set memory.draft
    Note over S: memory: { draft: "..." }

    R->>AN: execute (reads: draft)
    AN->>S: reducer: status = waiting
    Note over S: status: waiting, pending_approval: {...}

    R->>U: return pausedState (status: waiting)
    Note over U,H: Workflow is paused — state is persisted

    U->>H: show draft for review
    H->>U: "approved" + feedback

    U->>R: runner2 = new GraphRunner(pausedState)
    U->>R: runner2.applyHumanResponse({decision, data})
    R->>S: reducer: status = running, merge human response
    Note over S: memory: { draft, human_decision, human_response }

    U->>R: runner2.run()
    R->>PN: execute (reads: goal, draft, human_response)
    PN->>PN: LLM call → published article
    PN->>S: reducer: set memory.published

    R->>S: status = completed
    R->>U: return finalState
```

## Resume Flow

The HITL pattern uses a two-phase execution model:

1. **Phase 1 — Run to gate**: `runner.run()` executes nodes until the approval gate. The gate emits a `request_human_input` action, the reducer sets `status: 'waiting'`, and `run()` returns the paused state.

2. **Phase 2 — Resume after review**: Create a new `GraphRunner` with the paused state, call `applyHumanResponse()` to merge the human's decision, then call `run()` to continue from where it left off.

```typescript
// Phase 1: Run until approval gate
const runner1 = new GraphRunner(graph, initialState, opts);
const pausedState = await runner1.run();
// pausedState.status === 'waiting'

// Phase 2: Resume with human decision
const runner2 = new GraphRunner(graph, pausedState, opts);
runner2.applyHumanResponse({ decision: 'approved', data: 'LGTM' });
const finalState = await runner2.run();
// finalState.status === 'completed'
```

In production, the paused state is persisted to Postgres between phases. The worker loads the state, applies the human response, and resumes execution — which may happen minutes, hours, or days later.

## State Slicing

Each node only sees the keys it declares — the engine enforces zero-trust boundaries:

```mermaid
block-beta
    columns 3

    block:state["WorkflowState (blackboard)"]:3
        goal constraints draft human_decision human_response published
    end

    space:3

    block:wn["write node"]
        w_read["reads: goal, constraints"]
        w_write["writes: draft"]
    end

    block:an["review gate"]
        a_read["reviews: draft"]
        a_write["sets: status=waiting"]
    end

    block:pn["publish node"]
        p_read["reads: goal, draft, human_response"]
        p_write["writes: published"]
    end
```

## Run

```bash
cd packages/orchestrator
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/human-in-the-loop/human-in-the-loop.ts
```

The example prompts interactively in the terminal for approve/reject.

## Expected Output

```
[INFO] Starting human-in-the-loop workflow...
[INFO] Workflow started: <run-id>
[INFO]   Node started: write (agent)
[INFO]   Node complete: write (2100ms)
[INFO]   Node started: review (approval)
[INFO]   Node complete: review (1ms)
[INFO] Workflow paused — waiting for: human_approval

Approval gate prompt: "Please review the draft before publication."

╔══════════════════════════════════════════╗
║     HUMAN REVIEW REQUIRED                ║
╚══════════════════════════════════════════╝

Draft for review:

Open-source software has become a cornerstone of modern innovation ...

──────────────────────────────────────────

Approve this draft? (yes/no): yes
Any feedback for the publisher? (press Enter to skip): Add a stronger conclusion

Reviewer decision: approved

[INFO] Workflow started: <run-id>
[INFO]   Node started: publish (agent)
[INFO]   Node complete: publish (1850ms)
[INFO] Workflow complete: <run-id> (1851ms)

═══ Draft (pre-review) ═══
Open-source software has become a cornerstone of modern innovation ...

═══ Human Decision ═══
approved
Feedback: Add a stronger conclusion

═══ Published Article ═══
# Why Open-Source Software Matters for Innovation
Open-source software has become a cornerstone of modern innovation ...

═══ Stats ═══
  Nodes visited:  write → review → publish
  Tokens used:    2847
  Cost (USD):     $0.0171
```
