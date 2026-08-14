import { agent } from '@cycgraph/orchestrator';

import { MODEL, PROVIDER } from '../../../_model.js';

export const gatherAgent = agent({
  model: MODEL,
  provider: PROVIDER,
  instructions:
    `You are a research specialist. Produce factual research notes as bullet points.
    Honor the requested depth: "brief" means five bullets, "deep" means fifteen.`,
});

export const summarizeAgent = agent({
  model: MODEL,
  provider: PROVIDER,
  instructions: 'Condense the research notes into a tight summary of the five most important points.',
});
