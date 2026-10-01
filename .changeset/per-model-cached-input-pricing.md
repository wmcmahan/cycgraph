---
"@cycgraph/orchestrator": patch
---

Price prompt-cache reads at each model's published cached-input rate. `ModelPricing` gains an optional `cachedInputPerMToken`; models without one keep the previous rule of 10% of the input price. The built-in table now sets it for the 16 models whose providers charge a different rate. Cost and USD budgets previously undercounted cache-heavy runs on models that charge more (`gpt-4o`, `gpt-4o-mini`, `o1` and `o3-mini` at 50%, `o3` and `o4-mini` at 25%, Grok 4.3 to 4.7 at 15% to 25%) and overcounted them on models that charge less (Claude Opus 5.5 at 5%, Claude Fable 5.1 at 2.5%, GPT-6.1 Sol at 5%, DeepSeek V4 Pro and Flash at about 3% and 2%). Rate cards loaded with `setModelPricing` or `loadPricingTable` accept the field and reject a non-finite or negative value.
