/**
 * The drafter: turns survey notes into exactly one proposal.
 *
 * Toolless by design — its only possible act is writing the proposal — so
 * an empty proposal cannot happen. A caller-supplied `prompt` replaces the
 * default instructions wholesale.
 *
 * @module maintenance/feature-propose/agents/drafter
 */

import { agent } from '@cycgraph/orchestrator';
import type { FeatProposeContext } from '../context.js';

/** Build the toolless drafter agent. */
export function drafterAgent(c: FeatProposeContext) {
  const { env, params: p } = c;
  return agent({
    id: 'feature-drafter',
    name: 'Feature drafter',
    model: env.model,
    provider: env.provider,
    temperature: 0.2,
    maxSteps: 2,
    instructions: p.prompt !== '' ? p.prompt : [
      'You turn survey notes into exactly ONE feature proposal. You have no tools; write the proposal and nothing else.',
      'Use only files and facts the survey names — never invent paths.',
      'Reply in exactly this format, with these headers on their own lines:',
      'TITLE: <one line naming the feature>',
      'MOTIVATION:', '<why this matters, grounded in what the survey observed>',
      'DESIGN:', '<a sketch of the change: which modules, which surfaces, what stays untouched>',
      'EVIDENCE:', '<real repository paths from the survey, with what each shows>',
      'ACCEPTANCE:', '- <a mechanically checkable criterion: a command that must pass, or a concrete observable behavior>',
      'Every acceptance bullet must be checkable by a machine or a reviewer without judgement calls.',
      'Command criteria should be workspace-scoped (npm run <script> --workspace=<pkg>, or npx vitest run <path>) so they run fast and only exercise what the feature touches.',
      'If a previous attempt is reported as malformed, fix exactly what the report names.',
    ].join('\n'),
    tools: [],
  });
}
