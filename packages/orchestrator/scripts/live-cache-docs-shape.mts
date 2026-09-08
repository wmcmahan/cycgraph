// Live repro of the docs-fixer shape: authoring agent, NO explicit
// maxSteps (registry default), search tool, opus-5, two-plus steps.
import { agent, graph, node, tool, run } from '../dist/index.js';
import { z } from 'zod';

const realFetch = globalThis.fetch;
let req = 0;
globalThis.fetch = (async (url: any, init?: any) => {
  const isApi = String(url).includes('anthropic.com');
  const marks = isApi ? (String(init?.body ?? '').match(/cache_control/g) ?? []).length : 0;
  const response = await realFetch(url, init);
  if (isApi) console.log(`request ${req++}: marks=${marks} status=${response.status}`);
  return response;
}) as any;

const fixer = agent({
  id: 'live-fixer',
  name: 'Live fixer',
  model: 'claude-opus-5',
  provider: 'anthropic',
  temperature: 0.1,
  instructions: 'You verify claims about files. Use the search tool twice with different queries (one at a time, never in parallel), then reply DONE. Context ballast, ignore: ' + 'the quick brown fox. '.repeat(400),
  tools: [tool({
    name: 'search',
    description: 'search the corpus',
    parameters: z.object({ q: z.string() }),
    execute: async ({ q }) => ({ hits: [`${q}: nothing found`] }),
  })],
});
const fix = node({ id: 'fix', agent: fixer, reads: [], writes: 'out' });
const g = graph({ name: 'live-cache', description: 'probe', nodes: [fix], edges: [], startNode: fix, endNodes: [fix] });

process.env.LOG_LEVEL = 'info';
await run(g, { goal: 'Verify the claim that alpha.md exists, searching step by step.' });
