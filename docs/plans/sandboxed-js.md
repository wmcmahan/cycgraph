# sandboxed_js — Design Document

**Status**: Implemented 2026-08-04 (uncommitted). `@cycgraph/tools/sandbox`, 30 tests including the escape-probe checklist. One deviation from draft: `SharedArrayBuffer`/`Atomics` are deleted in the guest bootstrap (QuickJS exposes them; an escape probe caught it). `terminateMarginMs` exposed as an option (was a fixed const) so the worker backstop is testable.
**Created**: 2026-08-03
**Parent plan**: [tool-system.md](./tool-system.md) (Library roadmap, Tier 3)

## Goal

A code-interpreter tool for `@cycgraph/tools`: agents write JavaScript, the tool evaluates it against workflow data and returns a JSON result. This covers the long tail of computation that `calculator`/`json_transform`/`stats` can't express — custom aggregation, reformatting, small algorithms — without violating the no-host-execution mandate.

Non-goals: a Node runtime (no modules, no npm, no I/O), shell access of any kind, Python or other languages, long-running or async jobs.

## Why quickjs-emscripten

The engine is QuickJS compiled to WebAssembly, via the `quickjs-emscripten` package.

| Alternative | Verdict |
|---|---|
| `node:vm` | Not a security boundary — Node's own docs say so. Disqualified. |
| `worker_threads` alone | Full Node API inside the worker (fs, net, process). A scheduling boundary, not a security one. Disqualified. |
| `isolated-vm` | Real V8 isolates, but a native dependency with a compilation story on every install, and V8 flags/updates become our attack-surface maintenance. Heavy. |
| Container-per-call | The strongest boundary, but an infrastructure dependency — that's the separate `/exec` design in the parent plan, not a library tool. |
| `quickjs-emscripten` | Pure WASM, zero native deps. Sandbox is structural: WASM linear memory + no host imports beyond what we explicitly expose. Explicit memory limit, stack limit, and an interrupt handler for deadlines. |

The WASM boundary is the load-bearing property: guest code cannot address anything outside its linear memory by construction, so the worker process's environment (API keys, DB handles) is unreachable regardless of what the guest code does.

## Runtime model

```
Node process
└── V8 (Node's JS engine)
    ├── main thread — GraphRunner
    └── worker_threads worker — OS thread, own V8 isolate + event loop
        └── quickjs-emscripten (loaded inside the worker)
            └── WASM instance — QuickJS (a C-implemented JS engine) compiled to WebAssembly
                └── untrusted agent code, interpreted by QuickJS
```

QuickJS is a complete ECMAScript engine — the same category of thing as V8 — but a small C interpreter, and here it does not run natively: it executes as a guest of V8's WASM runtime. V8 never sees the agent's JavaScript, only WASM bytecode operating on a bounds-checked linear-memory `ArrayBuffer`. External capability exists only through imports handed to the module at instantiation, and it receives essentially none (emscripten plumbing plus the string-only log bridge). Even a memory-corruption bug in QuickJS's C code stays contained: corrupted linear memory is scrambled bytes, not native execution, because there are no syscalls to pivot to.

The worker is a `node:worker_threads` thread — same process, own isolate and event loop, structured-clone messaging, no `child_process` and nothing spawned, so it does not brush against the no-host-execution mandate. It exists because `evalCode` is synchronous: on the main thread a deadline-length evaluation would freeze the runner's event loop, and `worker.terminate()` is the outside-the-engine kill switch. Division of labor: **WASM decides what the code can touch; the worker decides what it can block and how it dies.** Neither alone suffices — a worker without WASM exposes the full Node API; WASM without the worker lets a hostile loop stall the runner.

## Threat model

Assume the code is attacker-authored. The model writes it, and the model's context contains tainted external content (`web_fetch` results, MCP output), so injection-to-code is the expected case, not the edge case.

| Threat | Control |
|---|---|
| Escape to host (fs, network, process, env) | Nothing is linked: no `std`/`os` QuickJS modules, no module loader, no host functions except the two below. `require`, `import`, `fetch`, `process` are simply undefined. |
| CPU exhaustion (infinite loop, catastrophic algorithm) | Primary: QuickJS interrupt handler checked against a wall-clock deadline (default 2s). Backstop: the evaluation runs inside a `worker_threads` worker the parent **terminates** at deadline + margin — same structural-timeout pattern as `text_extract`, and it keeps the runner's event loop unblocked. |
| Memory exhaustion | `runtime.setMemoryLimit` (default 64 MiB) and `setMaxStackSize` (default 512 KiB); the WASM heap is additionally bounded by the worker. |
| Output bombs | Result serialized guest-side to JSON and capped (default 1 MiB); log capture capped (100 entries × 1 KiB). Over-cap → tool error, not truncated data. |
| Data exfiltration | No I/O exists. The only egress is the return value, which lands in the LLM context and workflow memory — channels the engine already governs (write grants, taint). |
| Timing side channels (Spectre-class) | Accepted residual risk, documented: in-process WASM with only coarse `Date` timing available, no `SharedArrayBuffer`, no high-resolution timers exposed. An operator who cannot accept this uses the future container-backed `/exec` instead. |

## Tool contract

```typescript
import { createSandboxedJsTool } from '@cycgraph/tools/sandbox';

const sandboxedJs = createSandboxedJsTool({
  deadlineMs: 2_000,        // interrupt-handler deadline; worker terminated at deadline + 3s
  memoryLimitBytes: 64 * 1024 * 1024,
  maxCodeBytes: 50 * 1024,
  maxInputBytes: 1024 * 1024,
  maxResultBytes: 1024 * 1024,
});
```

Parameters (LLM-facing):

| Field | Type | Description |
|---|---|---|
| `code` | `string` | JavaScript program. The completion value of the last expression is the result; `console.log` is captured. |
| `input` | `unknown` (optional) | JSON data exposed to the code as the global `input`. |

Result: `{ result, logs }` — `result` is the JSON-serialized completion value (`null` when undefined), `logs` the captured console output.

Guest environment, exhaustively: ECMAScript core (Object/Array/JSON/Math/Date/RegExp/etc.), the `input` global (host-serialized JSON, parsed guest-side), and a `console.log` bridged to a capped host-side collector. That bridge is the **only** host function crossing the boundary, and it accepts strings only. Nothing else: no timers, no dynamic `import`, no `eval` of external resources (QuickJS `eval` of strings stays inside the same sandbox and inherits the same limits, so it is not blocked).

Execution model: synchronous, single evaluation. Promises may be constructed but nothing yields — v1 rejects a Promise completion value with a clear error rather than dangling. Async support is a possible v2 behind the same deadline machinery.

Taint: `taints: false` by default — the result is computation over data the workflow already holds, and derived taint from tainted read keys is already propagated by the agent executor. A `taints: true` factory flag exists for operators who want sandbox output always marked.

## Failure modes

All surface as normal tool errors the model can react to: syntax error (with message), runtime exception (message, no guest stack into the LLM beyond the message), deadline exceeded ("terminated after Nms"), memory limit hit, result over cap, unserializable result, Promise completion value.

## Packaging

New subpath `@cycgraph/tools/sandbox`, so the ~1 MiB WASM binary is loaded only by consumers who want it (same isolation rationale as `/memory`). `quickjs-emscripten` becomes a dependency; the singlefile sync variant is used so no separate `.wasm` asset shipping is needed. Version pinned with `^`; engine upgrades reviewed like any security-relevant bump.

## Security review checklist (gate before merge)

- [ ] Guest probes confirm `require`, `process`, `fetch`, `import()`, `os`, `std` are undefined; no host function reachable except the log bridge.
- [ ] Log bridge rejects non-string arguments and enforces entry/count caps host-side.
- [ ] Infinite loop (`for(;;);`) aborts at the interrupt deadline; a busy loop that defeats interrupts (if any construct is found) is caught by worker termination.
- [ ] Memory bomb (`const a=[];for(;;)a.push(new Array(1e6))`) errors at the memory limit without killing the worker process uncontrolled.
- [ ] Result and log caps enforced; over-cap is an error, not silent truncation.
- [ ] Worker teardown disposes the QuickJS runtime and context (no WASM heap leak across calls); one runtime per call, never shared between executions.
- [ ] `input` is serialized host-side and parsed guest-side — no object graph crosses the boundary by reference.
- [ ] defineTool timeout backstop exceeds deadline + termination margin so the outer race never fires first in normal operation.

## Test plan

Functional: arithmetic/transform results, `input` round-trip, log capture and ordering, last-expression completion value, `null` for undefined. Limits: loop → deadline abort; memory bomb → limit error; oversized code/input/result → cap errors. Escape probes: a test that asserts each forbidden global is `undefined` from inside the guest. Integration: registered on a real `GraphRunner` tool node, result in `${id}_result`.

## Open questions

1. Async v2: worth it, or does synchronous cover the realistic use? (Lean: ship sync, revisit on demand.)
2. Should `Date`/`Math.random` be stubbed for reproducibility? (Lean: no — tool results are event-log recorded, replay replays actions; nondeterminism is fine, same argument as `current_time`.)
3. Per-call worker spawn cost (~10–30 ms with WASM init) — acceptable for v1; a warm-worker pool is a later optimization with its own isolation questions (runtime reuse is explicitly forbidden by the checklist above, so pooling would pool *processes*, not runtimes).
