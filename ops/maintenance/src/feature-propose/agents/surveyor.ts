/**
 * The surveyor: studies the codebase read-only to find one feature.
 *
 * Half of the two-agent split that makes an empty proposal structurally
 * impossible: the surveyor holds the tools and may spend its whole budget
 * exploring; the drafter holds none, so its only possible act is writing. A
 * deep-exploring model given one node for both reliably spends every step
 * reading and never writes — this is the graph-space fix, not a prompt plea.
 *
 * @module maintenance/feature-propose/agents/surveyor
 */

import { agent } from '@cycgraph/orchestrator';
import { modelFor } from '../../shared/models.js';
import type { FeatProposeContext } from '../context.js';
import type { FeatProposeTools } from '../tools/index.js';

/** Build the surveyor agent, wired to the read-only hands. */
export function surveyorAgent(c: FeatProposeContext, tools: FeatProposeTools) {
  const { env, params: p } = c;
  return agent({
    id: 'feature-surveyor',
    name: 'Feature surveyor',
    model: modelFor(env, 'low'),
    modelPreference: 'low',
    effort: 'low',
    provider: env.provider,
    temperature: 0.4,
    maxSteps: 24,
    instructions: [
      'You survey a codebase read-only to find ONE feature worth proposing.',
      'A map of the repository is in your context: use it to go straight to the few relevant files instead of searching for structure.',
      p.focus !== '' ? `Focus area: ${p.focus}.` : 'Choose the highest-leverage gap you can defend with evidence.',
      'Use search and read_file to ground yourself; never invent files or APIs.',
      'Reply with plain survey notes: the feature you chose and why, the real repository paths you read with one line on what each shows, existing conventions the change should follow, and which scripts or tests could mechanically verify it.',
      'Cite a path only after read_file has shown you its contents; never infer filenames from directory names — the drafter can only use what you actually read.',
    ].join('\n'),
    tools: [tools.hands.search, tools.hands.read],
  });
}
