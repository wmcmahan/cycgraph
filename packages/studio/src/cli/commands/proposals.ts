/**
 * The proposal ladder: `proposals` lists the ledger; `trial`, `apply`,
 * `merged`, and `revert` move one record along it. Publishing stays a
 * printed script — the one act the system never performs.
 *
 * @module cli/commands/proposals
 */

import { join, resolve } from 'node:path';
import { applyProposal, resolveApplyRepo } from '../../improve/apply.js';
import { findProposal, listProposals, setProposalStatus, writeEpoch } from '../../improve/proposals.js';
import { resolveStack } from '../../stack/index.js';
import { fail, type CliContext } from '../context.js';
import { renderProposals } from '../render.js';

export async function proposalsCommand(ctx: CliContext): Promise<void> {
  const { args, config } = ctx;
  const workflow = args[0] && !args[0].startsWith('--') ? args[0] : undefined;
  renderProposals(await listProposals(config.artifactRoot, workflow));
}

export async function trialCommand(ctx: CliContext): Promise<void> {
  const { args, config } = ctx;
  const target = args[0];
  if (!target) fail(`\`trial\` needs a proposal id or unambiguous prefix. \`proposals\` lists them.`);
  const result = await setProposalStatus(config.artifactRoot, target, 'trial');
  if ('error' in result) fail(result.error);
  process.stdout.write(`  ${result.record.id} → trial (runtime overlay; \`apply\` writes it into source)\n`);
}

export async function applyCommand(ctx: CliContext): Promise<void> {
  const { args, config } = ctx;
  const target = args[0];
  if (!target) fail(`\`apply\` needs a proposal id or unambiguous prefix. \`proposals\` lists them.`);
  const record = await findProposal(config.artifactRoot, target);
  if (!record) fail(`no proposal matching '${target}'`);
  if (record.status === 'pr' || record.status === 'applied') fail(`${record.id} is already ${record.status}`);

  const repoAt = args.indexOf('--repo');
  const requested = resolve(repoAt >= 0 ? args[repoAt + 1] ?? '.' : join('..', '..'));
  const stack = await resolveStack(config);
  try {
    const sourcePath = ctx.catalog.find(record.workflow)?.sourcePath;
    const repo = repoAt >= 0
      ? { root: requested, fixture: false }
      : config.applyRepo
        ? { root: config.applyRepo, fixture: false }
        : await resolveApplyRepo(requested, process.cwd(), sourcePath);
    if (repo.fixture) {
      process.stdout.write(`  the repository does not track the workflow's source — using a fixture at ${repo.root}\n`);
    }
    const outcome = await applyProposal(stack, repo.root, record, (line) => {
      process.stdout.write(`  ${line}\n`);
    }, sourcePath);

    process.stdout.write(`\n${outcome.diff || '  (diff shown at commit)'}\n`);
    process.stdout.write(`  to open the PR:\n${outcome.prCommand.split('\n').map((l) => `    ${l}`).join('\n')}\n`);
    process.stdout.write(`  after it merges: \`merged ${record.id}\`\n`);
  } finally {
    await stack.close();
  }
}

export async function mergedCommand(ctx: CliContext): Promise<void> {
  const { args, config } = ctx;
  const target = args[0];
  if (!target) fail(`\`merged\` needs a proposal id. \`proposals\` lists them.`);
  const result = await setProposalStatus(config.artifactRoot, target, 'applied');
  if ('error' in result) fail(result.error);
  await writeEpoch(config.artifactRoot);
  process.stdout.write(`  ${result.record.id} → applied (corpus epoch recorded)\n`);
}

export async function revertCommand(ctx: CliContext): Promise<void> {
  const { args, config } = ctx;
  const target = args[0];
  if (!target) fail(`\`revert\` needs a proposal id or unambiguous prefix. \`proposals\` lists them.`);
  const record = await findProposal(config.artifactRoot, target);
  if (!record) fail(`no proposal matching '${target}'`);

  if (record.status === 'applied') {
    const result = await setProposalStatus(config.artifactRoot, record.id, 'reverted');
    if ('error' in result) fail(result.error);
    await writeEpoch(config.artifactRoot);
    process.stdout.write(`  ${record.id} → reverted. The change lives in git now — \`git revert\` the merge to take it out.\n`);
    return;
  }

  const next = record.status === 'trial' || record.status === 'pr' ? 'proposed' : 'reverted';
  const result = await setProposalStatus(config.artifactRoot, record.id, next);
  if ('error' in result) fail(result.error);
  if (record.status === 'pr') {
    process.stdout.write(`  ${record.id} → proposed. The workspace at ${record.workspace ?? '?'} is disposable.\n`);
  } else {
    process.stdout.write(`  ${record.id} → ${result.record.status}\n`);
  }
}
