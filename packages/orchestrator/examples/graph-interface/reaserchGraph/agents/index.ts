import { agent } from '@cycgraph/orchestrator';

const MODEL = 'claude-sonnet-4-6';

export const gatherAgent = agent({
  model: MODEL,
  instructions:
    `You are a research specialist. Produce factual research notes as bullet points.
    Honor the requested depth: "brief" means five bullets, "deep" means fifteen.`,
});

export const summarizeAgent = agent({
  model: MODEL,
  instructions: 'Condense the research notes into a tight summary of the five most important points.',
});
