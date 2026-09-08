# Prompt Builder

A vague user goal is turned into structured instructions before any real work
starts. A critic scores the instructions, and a below-threshold score sends
them back for another pass. Only once they clear the bar does the supervisor
begin routing.

Two loops in one graph: a self-annealing refinement loop, then a supervisor
cycle.

## Graph

```
prompt_builder → prompt_critic ──[prompt_score >= 0.8]──→ supervisor ⇄ research
                      │                                                ⇄ write
                      └──[prompt_score < 0.8]──→ prompt_builder        ⇄ edit
                                                 (refine with feedback)
```

Cyclic in two places, so `startNode` and `endNodes` are passed explicitly.

## Lifecycle & State

| Key | Written by | Read by |
| --- | --- | --- |
| `refined_goal` | prompt_builder | prompt_critic, research, write, edit |
| `task_plan` | prompt_builder | prompt_critic, research, write |
| `quality_criteria` | prompt_builder | prompt_critic, write, edit |
| `prompt_score` | prompt_critic | edge conditions |
| `prompt_feedback`, `prompt_suggestions` | prompt_critic | prompt_builder (refinement rounds) |
| `research_notes`, `draft`, `final_draft` | the specialists | downstream nodes and the supervisor's derived view |

The supervisor declares no grants of its own: its reads derive from what its
managed nodes write. The enrichment keys reach the specialists instead — each
one reads `refined_goal` and its slice of the plan directly.

## Run

```bash
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/prompt-builder/prompt-builder.ts
```

## Expected Output

```
═══ Self-Annealing Prompt Enrichment ═══
  Rounds: 2 (builder → critic iterations)
  Final prompt score: 0.85

═══ Supervisor Routing History ═══
  [iter 1] → research (...)
  [iter 2] → write (...)
  [iter 3] → edit (...)
  → __done__ (workflow completed)
```

The refined goal, task plan, critic feedback, drafts, and run stats print in
full between these two blocks.

## Notes

**Needs a capable model.** The critic has to produce a usable numeric score
and actionable feedback, and the builder has to act on it, within 30
iterations. `npm run smoke` lists this as capability-dependent and does not
gate on it: a small local model loops without converging, which says nothing
about the engine.

**Why an explicit `GraphRunner`.** The example attaches event listeners and
inspects the final `WorkflowState` for annealing rounds and routing history,
none of which the one-call `run()` helper exposes.
