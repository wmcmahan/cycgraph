import { agent } from '@cycgraph/orchestrator';

import { MODEL, PROVIDER } from '../../../_model.js';

export const briefAgent = agent({
  model: MODEL,
  provider: PROVIDER,
  instructions: 'Turn the findings into a short executive brief: one headline, three takeaways.',
});
