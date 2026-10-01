---
"@cycgraph/orchestrator": patch
---

Agents that run out of steps now still answer, a declared `finalAnswer` check covers fallback text, and a response the AI SDK cannot read is retried and logged with its cause.

- **Continuations offer no tools when the turn is out of steps.** When an agent's turn reached `maxSteps`, or its continuation had only one step left, the continuation still offered tools. The model often spent that step on another tool call and wrote no text, so the agent ended with its earlier narration or nothing. The continuation now runs with `toolChoice: 'none'` and asks the agent to answer from what it has already found. A continuation with steps to spare still offers tools.
- **`finalAnswer` checks the fallback text.** When a turn ends on an empty step, the agent's last spoken text is the fallback answer. For an agent with a `finalAnswer` check, that fallback is now checked first: if it passes it is the answer, and if it fails the agent gets the invalid-answer continuation. An answer that still fails after the one continuation is kept and logged as `final_answer_unresolved`. Agents without a check, and agents that end with an answer, behave as before.
- **"Failed to process successful response" is retried and diagnosable.** The AI SDK raises this when a provider returns HTTP 200 but the response cannot be read, such as an empty body, and marks it non-retryable because of the 200 status. The retry policy now treats such 2xx failures as retryable within the node's existing `failure_policy`. Failed agent calls and failed continuations now log the error's name, its cause chain, the status code, the provider's request id, and a truncated response body.
