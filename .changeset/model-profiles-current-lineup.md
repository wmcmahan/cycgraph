---
"@cycgraph/context-engine": patch
---

Model capability profiles now know the current lineups: the 1M-context Claude 4.6+/5 family, the 1M DeepSeek V4 API models, GPT-6 (1.05M) and GPT-5 (400K), and Grok (500K), each with token ratios. Compression budgets on these models resolve to their real context ceilings instead of the conservative 200K/128K family defaults, so long-context runs stop over-compressing.
