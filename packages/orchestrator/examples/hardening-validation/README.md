# Hardening Validation

Two scenarios that assert engine guarantees against a live model rather than a
mock. Each check prints PASS or FAIL and the process exits non-zero if any
fail, so this doubles as the smoke suite's strongest single entry.

It runs on a local model by default, so the assertions cost nothing to verify.

## Graph

Two independent runs.

```
scenario 1:  supervisor ⇄ research (calls a taints:true tool)
                        ⇄ write

scenario 2:  parent
               └── sub (subgraph node)
                     └── analyst (agent exists ONLY in a run-scoped registry,
                                  tool threaded via GraphRunnerOptions.tools)
```

Scenario 1's supervisor declares no `reads`. Deriving them from its managed
nodes is one of the things under test.

## Lifecycle & State

| Scenario | Assertion |
| --- | --- |
| 1 | both workers produced output |
| 1 | the custom tool was actually invoked |
| 1 | a fact only the tool knows survived into the final draft |
| 1 | the security policy saw the supervisor's **derived** reads as tainted |
| 2 | the parent completed through the subgraph |
| 2 | the child resolved its agent from the scoped registry and called the threaded tool |
| 2 | the child's result reached parent memory through the output mapping |

## Run

```bash
npx tsx examples/hardening-validation/hardening-validation.ts

# any pulled model:
OLLAMA_MODEL=qwen2.5:7b npx tsx examples/hardening-validation/hardening-validation.ts
```

Needs `ollama serve` and a pulled model. No API key.

## Expected Output

```
  PASS  workflow completed with both worker outputs — notes=298 chars, draft=387 chars
  PASS  custom tool was actually invoked — lookup_docs called 1x
  PASS  canned tool fact survived to the final draft — The Zephyr-9 protocol uses…
  PASS  security policy saw DERIVED supervisor reads as tainted — [{"nodeId":"supervisor",…}]
  PASS  parent workflow completed through the subgraph — status=completed
  PASS  child resolved its agent from the SCOPED registry and called the threaded tool
  PASS  canned rate reached the parent memory via output mapping

━━━ 7/7 live checks passed ━━━
```

## Notes

**Why the facts are canned.** Both tools return values no model could know
(`Zephyr-9`, a fixed exchange rate). If the fact appears in the output, the
tool ran and its result flowed through. A model cannot fake its way to a PASS.

**It can flake on small models.** Two checks depend on the model actually
calling a tool, which a 7B model does not do every time. A failure here is
worth re-running once before treating it as a regression.

**Scenario 2 uses the raw `createGraph` API** rather than the authoring
facade, deliberately: it is the only example covering the wire-level path.
