/**
 * run_trials — measure the edit: control vs variant, as dry subprocesses.
 *
 * Both arms run from clones of the same committed base, differing only by
 * the patch, so what is measured is the real source change end to end. The
 * find-text is re-verified in the clone (it was validated against the
 * working tree). Trials run with the database credential stripped: they
 * must neither pollute the recorded corpus nor differ by lesson injection.
 *
 * @module maintenance/tune/tools/trial
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { tool } from '@cycgraph/orchestrator';
import { maintenanceRunEnv, maintenanceSecrets } from '../../shared/repo.js';
import { MaintainResultSchema, TUNABLE, resolveSourcePath, variantWins, type ArmResult } from '../proposal.js';
import type { TuneContext } from '../context.js';

const exec = promisify(execFile);

/** The trial-running tool, bound to the run's context. */
export function trialTool(c: TuneContext) {
  const { repoRoot, params: p, sourceDir } = c;
  return tool({
    name: 'run_trials',
    description: 'Run control and variant arms as dry subprocess runs and compare.',
    parameters: z.object({ shape_result: z.unknown().optional() }),
    timeoutMs: 3_600_000,
    execute: async ({ shape_result }) => {
      const shaped = shape_result as { valid?: boolean; file?: string; find?: string; replace?: string } | undefined;
      if (shaped?.valid !== true || shaped.file === undefined) {
        return { compared: false, detail: 'nothing shaped to trial' };
      }

      // Both arms run from clones of the same committed base, so they
      // cannot differ by uncommitted working-tree edits — only by the
      // patch. A clone is HEAD, and check_proposal validated against the
      // working tree, so the find-text is re-verified in the clone: a
      // silent String.replace no-op would measure two identical arms and
      // report an honest-looking null.
      const cloneAt = await mkdtemp(join(tmpdir(), 'cycgraph-tune-'));
      const cloneArm = async (name: string): Promise<string> => {
        const root = join(cloneAt, name);
        await exec('git', ['clone', '--quiet', '--no-hardlinks', '--', repoRoot, root]);
        if (!existsSync(join(root, 'node_modules'))) {
          await symlink(join(repoRoot, 'node_modules'), join(root, 'node_modules'));
        }
        return root;
      };
      const controlRoot = await cloneArm('control');
      const variantRoot = await cloneArm('variant');
      const editAt = resolveSourcePath(variantRoot, sourceDir, shaped.file);
      if (editAt === undefined) {
        await rm(cloneAt, { recursive: true, force: true });
        return { compared: false, detail: `'${shaped.file}' resolves outside ${sourceDir}/ — refusing to edit the clone` };
      }
      const original = await readFile(editAt, 'utf8');
      const occurrences = original.split(shaped.find!).length - 1;
      if (occurrences !== 1) {
        await rm(cloneAt, { recursive: true, force: true });
        return {
          compared: false,
          detail: `the find-text appears ${occurrences} time(s) at HEAD — it was validated against the working tree; commit or restate the proposal against committed source`,
        };
      }
      await writeFile(editAt, original.replace(shaped.find!, shaped.replace!));

      const arm = async (root: string): Promise<ArmResult> => {
        const result: ArmResult = { runs: 0, completed: 0, gatePassed: 0, avgTokens: 0, costUsd: 0 };
        let tokens = 0;
        let yieldSum = 0;
        let sawYield = false;
        for (let i = 0; i < p.trials; i++) {
          const resultAt = join(cloneAt, `result-${randomUUID().slice(0, 8)}.json`);
          try {
            await exec('npx', ['tsx', join(root, 'ops/maintenance/src/run.ts'), p.target, ...TUNABLE[p.target]!, '--repoRoot', repoRoot],
              {
                cwd: root,
                maxBuffer: 64 * 1024 * 1024,
                timeout: 1_500_000,
                // A trial is the maintenance process itself, so it runs with
                // the process configuration (`maintenanceRunEnv`) and the
                // run's credentials restored, not the workspace allow-list —
                // without them every arm crashes. No DB (dropped by
                // `maintenanceRunEnv`): trials must not pollute the corpus or
                // differ by lesson injection.
                env: { ...maintenanceRunEnv(), ...maintenanceSecrets(), MAINTAIN_RESULT_JSON: resultAt },
              });
          } catch {
            // A crashed trial counts as a run that did not complete.
          }
          result.runs += 1;
          try {
            const parsed = MaintainResultSchema.parse(JSON.parse(await readFile(resultAt, 'utf8')));
            if (parsed.status === 'completed') result.completed += 1;
            if (parsed.gate === true) result.gatePassed += 1;
            tokens += parsed.tokens;
            result.costUsd += parsed.cost_usd;
            if (parsed.yield !== undefined) { yieldSum += parsed.yield; sawYield = true; }
          } catch {
            // No result file: the subprocess died before reporting.
          }
        }
        result.avgTokens = result.runs === 0 ? 0 : Math.round(tokens / result.runs);
        if (sawYield) result.yield = yieldSum;
        return result;
      };

      try {
        // Interleaving would be fairer under drifting external state; arms
        // run whole for simplicity, control first.
        const control = await arm(controlRoot);
        const variant = await arm(variantRoot);
        const verdict = variantWins(control, variant);
        return {
          compared: true,
          control,
          variant,
          wins: verdict.wins,
          cost_only: verdict.costOnly === true,
          detail: verdict.detail,
          table: [
            `| arm | runs | completed | gate passed | output | avg tokens | cost |`,
            `| --- | --- | --- | --- | --- | --- | --- |`,
            `| control | ${control.runs} | ${control.completed} | ${control.gatePassed} | ${control.yield ?? '—'} | ${control.avgTokens} | $${control.costUsd.toFixed(2)} |`,
            `| variant | ${variant.runs} | ${variant.completed} | ${variant.gatePassed} | ${variant.yield ?? '—'} | ${variant.avgTokens} | $${variant.costUsd.toFixed(2)} |`,
          ].join('\n'),
        };
      } finally {
        await rm(cloneAt, { recursive: true, force: true });
      }
    },
  });
}
