/**
 * check_proposal — validate the analyst's proposed edit.
 *
 * The edit is model-generated, so it is refused unless the FILE resolves
 * inside the maintenance source tree and the FIND text exists in that file
 * exactly once. Attempts are counted so a proposer that never shapes a
 * valid edit exits cleanly rather than on the iteration ceiling.
 *
 * @module maintenance/tune/tools/shape
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { tool } from '@cycgraph/orchestrator';
import { parseTuneProposal, resolveSourcePath } from '../proposal.js';
import type { TuneContext } from '../context.js';

/** The proposal-validating tool, bound to the run's context. */
export function shapeTool(c: TuneContext) {
  const { repoRoot, sourceDir } = c;
  return tool({
    name: 'check_proposal',
    description: 'Validate the proposed edit: the file is maintenance source and the find-text exists verbatim.',
    parameters: z.object({ proposal: z.unknown().optional(), shape_result: z.unknown().optional() }),
    timeoutMs: 30_000,
    execute: async ({ proposal, shape_result }) => {
      const round = ((shape_result as { round?: number } | undefined)?.round ?? 0) + 1;
      const { proposal: parsed, missing } = parseTuneProposal(String(proposal ?? ''));
      if (parsed === undefined) {
        return { valid: false, round, detail: `missing ${missing.join(', ')} — reply with HYPOTHESIS:, FILE:, then FIND:/REPLACE: blocks fenced by <<< and >>> lines` };
      }
      const at = resolveSourcePath(repoRoot, sourceDir, parsed.file);
      if (at === undefined) {
        return { valid: false, round, detail: `FILE must resolve inside ${sourceDir}/ — the tune loop edits workflow source only, got '${parsed.file}'` };
      }
      if (!existsSync(at)) {
        return { valid: false, round, detail: `'${parsed.file}' does not exist` };
      }
      const content = await readFile(at, 'utf8');
      const occurrences = content.split(parsed.find).length - 1;
      if (occurrences === 0) {
        return { valid: false, round, detail: 'FIND does not appear in the file — quote the exact current text, character for character' };
      }
      if (occurrences > 1) {
        return { valid: false, round, detail: `FIND appears ${occurrences} times — include enough surrounding text to match exactly once` };
      }
      return {
        valid: true,
        round,
        file: parsed.file,
        hypothesis: parsed.hypothesis,
        find: parsed.find,
        replace: parsed.replace,
        detail: `edit to ${parsed.file} shaped: ${parsed.hypothesis.slice(0, 120)}`,
      };
    },
  });
}
