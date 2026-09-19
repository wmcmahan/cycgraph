---
"@cycgraph/a2a": patch
---

An A2A delivery whose timeout or caller abort fires just as a request is issued no longer starts that request: the abort bound now takes the call as a thunk, so the aborted SDK call it used to abandon can no longer reject unhandled and crash the host process. The settle loop also re-checks the deadline after its backoff sleep instead of issuing one last doomed poll.
