# Verifier Fix-Loop

A 3-node compound-systems workflow showing how a **deterministic verifier**
gates an LLM extraction and routes failures back to a fixer that uses the
verifier's feedback to correct itself.

```
  ┌─────────┐      ┌──────────────┐   not passed   ┌───────┐
  │ extract │ ───▶ │ verify_email │ ─────────────▶ │  fix  │
  └─────────┘      └──────────────┘                └───────┘
                      │       ▲                        │
               passed │       └───── loop back ────────┘
                      ▼
                ┌──────────┐
                │   done   │  (end node)
                └──────────┘
```

## Notes

This is the canonical compound-AI-systems pattern in one screen of code.
A frontier model called once can still emit `"customer_email": "not
provided"` or hallucinate a placeholder string. A regex verifier catches
that deterministically — no LLM call, no judgment call, no guesswork —
and a fixer agent re-runs with the verifier's reasoning attached.

Three properties this demonstrates:

1. **Deterministic verifiers are free.** The `jsonpath` verifier uses
   `jsonpath-plus` (already a runtime dep) plus a regex. Zero tokens,
   no latency, infallible on the property it checks.
2. **Verifier-generator asymmetry.** The verifier doesn't need to be
   smarter than the generator — it only needs to recognize a wrong
   answer. Recognizing is strictly easier than producing.
3. **Reliability compounds.** A 90%-per-step generator with one
   verifier-loop pass reaches ~99% end-to-end on the verified property.

## Graph

| Node | Type | Role |
|---|---|---|
| `extract` | `agent` | Reads `email_text`, emits a structured `purchase_order` |
| `verify_email` | `verifier` (`jsonpath`) | Asserts `$.customer_email` matches an email regex |
| `fix` | `agent` | Re-extracts using `verify_email_verification.reasoning` |

Edges:

- `extract → verify_email` (always)
- `verify_email → fix` when `not memory.verify_email_verification_passed`
- `verify_email → done` when `memory.verify_email_verification_passed`
- `fix → verify_email` (always — loops back)

**Both outcomes need an explicit edge.** An end node terminates before its
edges are evaluated, so the verifier cannot both be terminal and branch.
Success routes to a `done` node instead, which is the end node.

**Conditions use the bare truthy form.** filtrex has no boolean literals, so
`memory.x == false` compares against an undefined property: it is false when
the value IS false, and true when the key is missing — the exact inverse of
the intent. The graph validator warns about this at load time.
`max_iterations` remains the loop safeguard.

## Lifecycle & State

After every `verify_email` execution, the verifier writes two keys:

```jsonc
// memory.verify_email_verification
{
  "type": "jsonpath",
  "passed": false,
  "reasoning": "assertion matches /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/ at $.customer_email failed (value=\"not provided\")",
  "extracted_value": "not provided",
  "evaluated_at": "2026-05-27T22:00:00.000Z"
}

// memory.verify_email_verification_passed
false
```

The flat `_passed` boolean is what edges route on (filtrex handles flat
properties well). The structured object is what the fixer reads to produce
a better attempt.

## Run

```bash
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/verifier-fix-loop/verifier-fix-loop.ts
```

Expected output on a clean run (the model usually nails it first try):

```
═══ Extracted Purchase Order ═══
{
  "customer_email": "j.harper@example.org",
  "order_id": "A-7821",
  "total_usd": 59.99,
  "items": [
    { "name": "small notebook", "quantity": 2, "unit_price_usd": 12.50 },
    { "name": "brown leather pen case", "quantity": 1, "unit_price_usd": 34.99 }
  ]
}

═══ Verification Outcome ═══
  Passed: true
  Reasoning: assertion matches /^[^@\s]+@[^@\s]+\.[^@\s]+$/ at $.customer_email passed
  Extracted email: "j.harper@example.org"

═══ Loop Stats ═══
  Total iterations:  2
  Tokens used:       ~800
  Cost (USD):        $0.0050
```

On a run where the model misses the email on the first attempt
(`"not provided"`, null, or a hallucinated address), you'll see
`Total iterations: 4` instead, with one trip through the `fix` node.

## Extending this pattern

This example uses **one** verifier on **one** field. Real compound systems
chain multiple verifiers, mixing deterministic and probabilistic:

- `jsonpath` assertions for structural invariants (totals > 0, IDs present)
- `expression` (filtrex) for cross-field invariants
- `llm_judge` for semantic claims that can't be expressed structurally

Each variant lives in `VerifierConfigSchema` as a discriminated union —
pick the cheapest verifier that can detect each failure mode.
