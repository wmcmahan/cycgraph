/**
 * run_acceptance — run the ticket's runnable acceptance criteria.
 *
 * The mechanical judge: every runnable criterion is re-validated and
 * executed, the tree must have changed, nothing may have mutated during the
 * run (a test that writes source files is gaming the judge), and a tune
 * ticket's approved replacement must be present verbatim. With local checks
 * off (the product) nothing runs here — the criteria are left for CI.
 *
 * @module maintenance/implement-ticket/tools/accept
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { tool } from '@cycgraph/orchestrator';
import { changedIn } from '@cycgraph/tools/git';
import { runAcceptanceCommands } from '../../shared/proposal.js';
import { checksEnv } from '../../shared/repo.js';
import type { ImplementContext } from '../context.js';

const exec = promisify(execFile);

/** The acceptance-running tool, bound to the clone. */
export function acceptTool(c: ImplementContext) {
  const { workspaceAt, maintenance } = c;
  const localChecks = maintenance.runLocalChecks;
  return tool({
    name: 'run_acceptance',
    description: 'Run the ticket\'s runnable acceptance criteria in the workspace.',
    parameters: z.object({ pick_result: z.unknown().optional() }),
    timeoutMs: 1_800_000,
    execute: async ({ pick_result }) => {
      const pick = pick_result as
        { issue_number?: number; title?: string; runnable?: string[]; manual?: string[];
          tune_edit?: { file: string; replace: string } } | undefined;
      const changed = await changedIn(workspaceAt);
      // Snapshot before running: acceptance executes agent-authored code,
      // and a test that writes source files is using the judge as a write
      // hand. Any mutation of the tree during acceptance is refused as
      // gaming, exactly like a deletion satisfying a detector.
      const treeBefore = changed.join('\n');
      // The runnable list arrives as a model-relayed tool argument, so every
      // command is re-validated at execution — never trusted from the pick
      // step's output. With local checks off (the product) nothing runs
      // here; the criteria are left for CI.
      const failed = localChecks
        ? await runAcceptanceCommands(pick?.runnable ?? [], async (safe) => {
          await exec('sh', ['-c', safe], { cwd: workspaceAt, env: checksEnv(), maxBuffer: 64 * 1024 * 1024, timeout: 900_000 });
        })
        : [];
      const treeAfter = (await changedIn(workspaceAt)).join('\n');
      const mutated = treeAfter !== treeBefore;
      // A tune ticket's judge is exactness: the approved, measured
      // replacement text must be present in the named file.
      let tuneEditMissing = false;
      if (pick?.tune_edit !== undefined) {
        const content = await readFile(join(workspaceAt, pick.tune_edit.file), 'utf8').catch(() => '');
        tuneEditMissing = pick.tune_edit.replace !== '' && !content.includes(pick.tune_edit.replace);
      }
      const passed = failed.length === 0 && changed.length > 0 && !mutated && !tuneEditMissing;
      const closes = pick?.issue_number !== undefined ? `Closes #${pick.issue_number}. ` : '';
      return {
        passed,
        changed_count: changed.length,
        mutated_by_tests: mutated,
        failed,
        manual: pick?.manual ?? [],
        // The proposal title names the feature, so the commit inherits it.
        ...(pick?.title !== undefined && pick.title !== '' ? { subject: `feat: ${pick.title}` } : {}),
        detail: changed.length === 0
          ? `${closes}nothing was changed`
          : mutated
            ? `${closes}running the acceptance criteria itself modified the tree — tests must not write source files; make the changes with your editing tools instead`
            : tuneEditMissing
              ? `${closes}the approved replacement text is not present in ${pick?.tune_edit?.file ?? 'the named file'} — the exact measured edit was not applied`
              : failed.length > 0
                ? `${closes}acceptance failed: ${failed.map((f) => f.command).join('; ')}`
                : pick?.tune_edit !== undefined
                  ? `${closes}the approved tuning edit landed verbatim`
                  : localChecks
                    ? `${closes}all ${pick?.runnable?.length ?? 0} runnable acceptance criteria passed; ${pick?.manual?.length ?? 0} left for review`
                    : `${closes}${pick?.runnable?.length ?? 0} runnable criteria deferred to CI; ${pick?.manual?.length ?? 0} left for review`,
      };
    },
  });
}
