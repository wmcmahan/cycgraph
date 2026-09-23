/**
 * check_shape — validate the proposal's structure and evidence.
 *
 * The structural gate: a proposal missing a section, or whose evidence
 * names no file the repository actually has, is refused. Attempts are
 * counted here so a drafter that never shapes a valid proposal exits the
 * graph cleanly rather than dying on the iteration ceiling.
 *
 * @module maintenance/feature-propose/tools/shape
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { tool } from '@cycgraph/orchestrator';
import { parseProposal, pathTokens } from '../../shared/proposal.js';
import type { FeatProposeContext } from '../context.js';

/** The proposal-validating tool, bound to the clone. */
export function shapeTool(c: FeatProposeContext) {
  const { workspaceAt } = c;
  return tool({
    name: 'check_shape',
    description: 'Validate the proposal\'s structure and that its evidence names real files.',
    parameters: z.object({ proposal: z.unknown().optional(), shape_result: z.unknown().optional() }),
    execute: async ({ proposal, shape_result }) => {
      const round = ((shape_result as { round?: number } | undefined)?.round ?? 0) + 1;
      if (String(proposal ?? '').trim() === '') {
        return {
          valid: false,
          round,
          title: '',
          acceptance_count: 0,
          evidence_paths: [],
          missing: ['everything'],
          detail: 'the reply was empty — you likely spent every step exploring; read at most a handful of files, then write the full proposal in the required format',
        };
      }
      const parsed = parseProposal(String(proposal ?? ''));
      const evidencePaths = pathTokens(parsed.evidence)
        .filter((token) => existsSync(join(workspaceAt, token)));
      const evidenceOk = evidencePaths.length > 0;
      const valid = parsed.missing.length === 0 && evidenceOk;
      return {
        valid,
        round,
        title: parsed.title,
        acceptance_count: parsed.acceptance.length,
        evidence_paths: evidencePaths,
        missing: parsed.missing,
        // A refusal in CI is only diagnosable from the run log, so an
        // invalid proposal carries its own head.
        ...(valid ? {} : { proposal_head: String(proposal ?? '').slice(0, 400) }),
        detail: valid
          ? `well-formed: '${parsed.title}' with ${parsed.acceptance.length} acceptance criteria`
          : parsed.missing.length > 0
            ? `missing sections: ${parsed.missing.join(', ')}`
            : 'evidence names no file the repository actually has — cite real paths',
      };
    },
  });
}
