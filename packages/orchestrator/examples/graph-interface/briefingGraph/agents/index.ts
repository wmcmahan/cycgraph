import { agent } from '@cycgraph/orchestrator';

const MODEL = 'claude-sonnet-4-6';

export const briefAgent = agent({
  model: MODEL,
  instructions: 'Turn the findings into a short executive brief: one headline, three takeaways.',
});
