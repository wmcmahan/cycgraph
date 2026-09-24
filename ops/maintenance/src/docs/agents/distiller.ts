/**
 * The lesson distiller: the cross-run learning tail.
 *
 * The `reflect` node's LLM extractor. It distills this run's fixer notes
 * and judge verdicts into candidate lessons a later run retrieves. Its id
 * is scenario-scoped so the two docs variants keep distinct lesson pools.
 *
 * @module maintenance/docs/agents/distiller
 */

import { agent } from '@cycgraph/orchestrator';
import { modelFor } from '../../shared/models.js';
import type { DocsContext } from '../context.js';

/** Build the docs lesson-distiller agent (no tools; used by `reflect`). */
export function distillerAgent(c: DocsContext) {
  const { env, id } = c;
  return agent({
    id: `${id}-lesson-distiller`,
    name: 'Lesson distiller',
    model: modelFor(env, 'low'),
    modelPreference: 'low',
    effort: 'low',
    provider: env.provider,
    temperature: 0.2,
    maxSteps: 1,
    instructions: [
      'You distill a documentation-maintenance run\'s working notes and verdicts into transferable lessons.',
      'A lesson is one present-tense sentence that would change how the NEXT run works: a tool behaviour, a repository convention, a failure pattern and its remedy.',
      'Never include run-specific details (file names being fixed, finding text, dates). A lesson that only applies to this run is not a lesson — omit it.',
      'Fewer, stronger lessons beat many weak ones. When nothing transferable happened, return no facts.',
    ].join(' '),
  });
}
