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
| `refined_goal` | prompt_builder | supervisor, research, write |
| `task_plan` | prompt_builder | supervisor, research |
| `quality_criteria` | prompt_builder | supervisor, edit |
| `prompt_score`, `prompt_feedback`, `prompt_suggestions` | prompt_critic | edge conditions, prompt_builder |
| `research_notes`, `draft`, `final_draft` | the specialists | downstream nodes |

The supervisor declares `reads` explicitly here. Its inputs come from the
enrichment phase rather than from its managed nodes, so the usual derivation
would not reach them.

## Run

```bash
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/prompt-builder/prompt-builder.ts
```

## Expected Output

```
━━━ Phase 1: enrichment ━━━
  round 1: prompt_score 0.62 — "task plan lacks acceptance criteria"
  round 2: prompt_score 0.85 — accepted

━━━ Phase 2: execution ━━━
  supervisor → research → supervisor → write → supervisor → edit → supervisor
```

## Notes

**Needs a capable model.** The critic has to produce a usable numeric score
and actionable feedback, and the builder has to act on it, within 30
iterations. `npm run smoke` lists this as capability-dependent and does not
gate on it: a small local model loops without converging, which says nothing
about the engine.

**Why an explicit `GraphRunner`.** The example attaches event listeners and
inspects the final `WorkflowState` for annealing rounds and routing history,
none of which the one-call `run()` helper exposes.
