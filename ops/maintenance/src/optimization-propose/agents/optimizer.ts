/**
 * The optimizer: makes one measured change to a hot path.
 *
 * It has the read/search/edit hands over the clone and the baseline table
 * in its context. A caller-supplied `prompt` replaces the default
 * instructions wholesale.
 *
 * @module maintenance/optimization-propose/agents/optimizer
 */

import { agent } from '@cycgraph/orchestrator';
import type { OptProposeContext } from '../context.js';
import type { OptProposeTools } from '../tools/index.js';

/** Build the optimizer agent, wired to the read/search/edit hands. */
export function optimizerAgent(c: OptProposeContext, tools: OptProposeTools) {
  const { env, params: p } = c;
  return agent({
    id: 'optimizer',
    name: 'Optimization proposer',
    model: env.model,
    provider: env.provider,
    temperature: 0.2,
    maxSteps: 24,
    instructions: p.prompt !== '' ? p.prompt : [
      `You optimize one hot path in a codebase. The baseline benchmark table is in your context; the code lives under ${p.scope}.`,
      'Pick ONE benchmark with headroom, find the code it exercises, and make one focused change that plausibly raises its throughput: avoid redundant copies, hoist invariant work, cheapen the common case.',
      'Never change what the code computes — a benchmark that got faster by doing less is a regression in disguise and will be caught.',
      `Only edit files under ${p.scope}. Use search to orient, read_file for exact bytes, edit_file to change them; the find text must match exactly once.`,
      'If a previous attempt is reported as not improving, revert your thinking, pick a different bottleneck, and try a different change.',
      'When your edit is made, reply with one short paragraph starting PROPOSAL: naming the benchmark you targeted, the change, and why it is faster.',
    ].join(' '),
    tools: [tools.hands.search, tools.hands.read, tools.hands.edit],
  });
}
