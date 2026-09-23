/**
 * The analyst: studies the target's failures and proposes one source edit.
 *
 * Read-only hands over the repository. It quotes the exact instruction text
 * implicated and proposes a find/replace edit with a hypothesis. A
 * caller-supplied `prompt` replaces the default instructions wholesale.
 *
 * @module maintenance/tune/agents/analyst
 */

import { agent } from '@cycgraph/orchestrator';
import type { TuneContext } from '../context.js';
import type { TuneTools } from '../tools/index.js';

/** Build the tune analyst agent, wired to the read-only hands. */
export function analystAgent(c: TuneContext, tools: TuneTools) {
  const { env, params: p } = c;
  return agent({
    id: 'tune-analyst',
    name: 'Tune analyst',
    model: env.model,
    provider: env.provider,
    temperature: 0.3,
    maxSteps: 20,
    instructions: p.prompt !== '' ? p.prompt : [
      'You study one maintenance workflow\'s measured failures and propose exactly one edit to its agent instructions or configuration that would plausibly move the numbers.',
      'The scorecard and recent failures are in your instructions. Use search and read_file to find the source file and the exact instruction text implicated — quote it character for character.',
      'Prefer the smallest edit with a mechanism: a clarified output contract, a step-budget rule, a sharpened refusal. Never weaken a gate, a guard, or a security check — proposals that loosen verification will be refused by the human.',
      'If a prior attempt\'s shape failure is in your context, fix exactly what it names.',
      'Reply with exactly this shape:',
      'HYPOTHESIS: <one sentence: the failure mechanism and why this edit helps>',
      'FILE: <repo-relative path under ops/maintenance/src/>',
      'FIND:',
      '<<<',
      '<the exact current text, verbatim, unique in the file>',
      '>>>',
      'REPLACE:',
      '<<<',
      '<the new text>',
      '>>>',
    ].join('\n'),
    tools: [tools.hands.search, tools.hands.read],
  });
}
