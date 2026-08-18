---
"@cycgraph/orchestrator": patch
---

Memoized forks now replay repeated executions in recorded order. A fingerprint
seen twice used to be poisoned out of the memo index, so a base run whose node
ran twice on identical inputs — a supervisor sending a worker back, a fix-loop
iterating — could not be reproduced by a null fork: both executions re-ran
live and resampled. Executions now queue per fingerprint, each hit consumes
one, and the queue starts at the fork point so a fork taken between two
identical executions is served the one the prefix has not already consumed.
