---
"@cycgraph/orchestrator": patch
---

An open node circuit breaker no longer counts its own refusal as an execution failure, so it stops resetting the recovery clock on every attempt and can actually transition to half-open once `timeout_ms` elapses. `CircuitBreakerOpenError` is now non-retryable, so a refused node fails fast instead of sleeping through its remaining retry backoffs, and node failure statistics no longer include attempts that ran no work.
