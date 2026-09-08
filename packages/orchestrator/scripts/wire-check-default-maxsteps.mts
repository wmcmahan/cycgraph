import { agent, graph, node, tool, run } from '../src/index.js';
import { z } from 'zod';

const bodies: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  if (String(url).includes('anthropic')) {
    bodies.push(String(init?.body ?? ''));
    return new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'captured' } }), { status: 401 });
  }
  return realFetch(url, init);
}) as any;

const fixer = agent({
  id: 'wire-fixer',
  name: 'Wire fixer',
  model: 'claude-opus-5',
  provider: 'anthropic',
  temperature: 0.1,
  // no maxSteps — registry default, same as the docs fixer
  instructions: 'You correct one stale claim. '.repeat(200),
  tools: [tool({
    name: 'search',
    description: 'search',
    parameters: z.object({ q: z.string() }),
    execute: async () => ({ hits: [] }),
  })],
});
const fix = node({ id: 'fix', agent: fixer, reads: [], writes: 'out' });
const g = graph({ name: 'wire', description: 'w', nodes: [fix], edges: [], startNode: fix, endNodes: [fix] });

process.env.ANTHROPIC_API_KEY = 'sk-ant-fake';
await run(g, { goal: 'x'.repeat(2000) }).catch(() => {});
console.log('requests captured:', bodies.length);
for (const [i, b] of bodies.entries()) {
  const marks = (b.match(/cache_control/g) ?? []).length;
  console.log(`request ${i}: cache_control marks = ${marks}, bytes = ${b.length}`);
}
