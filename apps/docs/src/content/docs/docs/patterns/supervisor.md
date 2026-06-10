---
title: Supervisor
description: LLM-powered dynamic routing — a supervisor delegates tasks to managed nodes iteratively.
---

The **Supervisor** pattern introduces an LLM as the "brain" of your workflow, capable of making dynamic routing decisions on the fly. 

Unlike traditional static workflows where every step is hardcoded, the Supervisor pattern allows the orchestrator to act iteratively—delegating subtasks, reviewing the results, and deciding what needs to happen next until the overarching goal is fully achieved.

## How it works

```mermaid
flowchart TB
    Goal(["Goal"]) --> Sup["Supervisor"]
    Sup --> |"Delegates"| Researcher["Research Agent"]
    Researcher --> |"Returns results"| Sup
    Sup --> |"Delegates"| Writer["Writer Agent"]
    Writer --> |"Returns draft"| Sup
    Sup --> |"Goal complete"| Done(["✓ __done__"])
```

1. **Initial Goal**: The workflow receives an open-ended goal (e.g., "Write a comprehensive report").
2. **First Routing Decision**: The Supervisor assigns the first step to the most appropriate specialist node in its `managed_nodes` list (e.g., `research`).
3. **Execution & Return**: The `research` node executes, and control returns directly to the Supervisor via a cyclic return edge.
4. **Subsequent Routing**: The Supervisor reviews the new state of the memory, decides what is missing, and delegates again (e.g., to `write`).
5. **Completion**: Once the goal is met, the Supervisor routes the final execution to the `__done__` sentinel, terminating the graph.

## Implementation example

This example demonstrates a supervisor routing between three specialists: a researcher, a writer, and an editor. See the [full runnable code](https://github.com/wmcmahan/mc-ai/tree/main/packages/orchestrator/examples/supervisor-routing/supervisor-routing.ts).

### 1. The Supervisor prompt

The agent powering the supervisor should be instructed to act as a manager. It evaluates the current state and identifies the single best next worker to delegate to.

```typescript
const SUPERVISOR_ID = registry.register({
  name: 'Supervisor Agent',
  model: 'claude-sonnet-4-20250514',
  provider: 'anthropic',
  system_prompt: [
    'You are a project supervisor coordinating a team of specialists to produce a high-quality article.',
    'You have three team members: "research" (gathers facts), "write" (produces drafts), and "edit" (polishes prose).',
    'Review the current state and decide which specialist should work next.',
    'Typical flow: research → write → edit, but you may loop back if quality is insufficient.',
    'When the final_draft is polished and ready, route to "__done__" to complete the workflow.',
  ].join(' '),
  // We keep the temperature low so routing decisions are deterministic
  temperature: 0.3,
  tools: [],
  permissions: {
    read_keys: ['*'], // The supervisor needs to see everything to make good routing decisions
    write_keys: ['*'],
  },
});
```

### 2. The Supervisor node

The `supervisor` node type requires a `supervisor_config` block defining which node IDs it is permitted to route work to.

```typescript
import { createGraph } from '@cycgraph/orchestrator';

const graph = createGraph({
  name: 'Supervisor Routing',
  nodes: [
    {
      id: 'supervisor',
      type: 'supervisor',
      agent_id: SUPERVISOR_ID,
      read_keys: ['*'],
      write_keys: ['*'],
      supervisor_config: {
        managed_nodes: ['research', 'write', 'edit'],
        max_iterations: 10,
      },
    },
    // ... define the 'research', 'write', and 'edit' agent nodes ...
  ],
  // ...
});
```

### 3. The Cyclic edges

Supervisors require a **hub-and-spoke topology**. You must define unconditional edges from the supervisor to every managed node, and from every managed node securely back to the supervisor.

```typescript
const graph = createGraph({
  // ... nodes ...
  edges: [
    // Supervisor → specialists (outbound)
    { source: 'supervisor', target: 'research' },
    { source: 'supervisor', target: 'write' },
    { source: 'supervisor', target: 'edit' },

    // Specialists → supervisor (cyclic return)
    { source: 'research', target: 'supervisor' },
    { source: 'write', target: 'supervisor' },
    { source: 'edit', target: 'supervisor' },
  ],
  start_node: 'supervisor',
  end_nodes: [],  // Termination is handled dynamically by routing to __done__
});
```

## Nested delegation

Because Supervisors are just nodes in a graph, they can be configured to manage *other* Supervisors. This allows for hierarchical delegation—for instance, a "Product Director" supervisor that delegates high-level milestones to "Engineering Manager" and "Marketing Manager" supervisors, who each manage their own team of specialist worker agents.
