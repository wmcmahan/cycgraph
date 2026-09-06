/**
 * Headless runner: the one entry point CI and a laptop share.
 *
 *   npm run maintain --workspace=ops/maintenance -- <workflow> [--flag value]...
 *
 * Picks a workflow by id, parses flags through its own params schema,
 * resolves the environment from env vars (`maintenanceEnvFromProcess`),
 * runs the graph recorded, and exits nonzero unless the run completed.
 * No studio, no playground: orchestrator and tools only, so a CI
 * checkout needs nothing beyond this package's own dependency tree.
 *
 * @module maintenance/run
 */

import { createProviderRegistry, registerOllamaProvider, runRecorded } from '@cycgraph/orchestrator';
import type { EventLogWriter, GraphRunnerMiddleware, PersistenceProvider, ProviderRegistry } from '@cycgraph/orchestrator';
import { createOpenAI } from '@ai-sdk/openai';
import { coreUpkeep } from './core-workflow.js';
import { docsMaintenance, repoDocsMaintenance, websiteDocsMaintenance } from './docs-workflow.js';
import { issueFix } from './issue-fix.js';
import { optPropose } from './opt-workflow.js';
import { featPropose } from './feat-propose.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { maintenanceEnvFromProcess } from './env.js';
import { resolveRepo } from './repo.js';
import type { MaintenanceEnv, MaintenanceWorkflow } from './types.js';

const WORKFLOWS: Record<string, () => MaintenanceWorkflow> = {
  'docs-maintenance': () => docsMaintenance(),
  'repo-docs': repoDocsMaintenance,
  'website-docs': websiteDocsMaintenance,
  'core-upkeep': coreUpkeep,
  'issue-fix': issueFix,
  'opt-propose': optPropose,
  'feat-propose': featPropose,
};

const NUMBER_FLAGS = new Set(['batch', 'skip', 'maxIssues', 'issueNumber', 'minImprovement', 'attempts']);
const BOOLEAN_FLAGS = new Set(['commit', 'publish', 'lint', 'file', 'allowStale']);
const LIST_FLAGS = new Set(['checks']);

function parseFlags(args: string[]): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === undefined || !flag.startsWith('--') || value === undefined) {
      throw new Error(`flags come in pairs: --name value (got '${flag ?? ''}')`);
    }
    const name = flag.slice(2);
    raw[name] = NUMBER_FLAGS.has(name) ? Number(value)
      : BOOLEAN_FLAGS.has(name) ? value !== 'false'
        : LIST_FLAGS.has(name) ? value.split(',').map((s) => s.trim()).filter(Boolean)
          : value;
  }
  return raw;
}

interface Durability {
  persistence?: PersistenceProvider;
  eventLog?: EventLogWriter;
  kind: 'postgres' | 'in-memory';
  close: () => Promise<void>;
}

/**
 * Record into shared Postgres when `DATABASE_URL` is set, so the run
 * joins the corpus the studio's watcher imports and measures; without
 * it the run records in-memory and is gone with the process. Imported
 * dynamically so the runner works without a database driver loaded.
 */
async function durabilityFromEnv(): Promise<Durability> {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    return { kind: 'in-memory', close: async () => {} };
  }
  const { createTenantScope, closeDb, SEED_TENANT_ID } = await import('@cycgraph/orchestrator-postgres');
  const scope = createTenantScope({ tenant_id: SEED_TENANT_ID });
  return {
    persistence: scope.persistence,
    eventLog: scope.eventLog,
    kind: 'postgres',
    close: () => closeDb(),
  };
}

/** A registry with Ollama wired, for local models; hosted models inherit the built-ins. */
function providersFor(env: MaintenanceEnv): ProviderRegistry | undefined {
  if (env.provider !== 'ollama') return undefined;
  const baseURL = process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434';
  const providers = createProviderRegistry();
  registerOllamaProvider(providers, () => {
    const provider = createOpenAI({ baseURL: `${baseURL}/v1`, apiKey: 'ollama' });
    return (modelId) => provider.chat(modelId);
  });
  return providers;
}

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * Whether the repository is behind its origin's default branch, after a
 * fetch. A stale local repository re-finds work that is already merged
 * and delivers a duplicate, so a run against one is refused rather than
 * wasted. Offline is not staleness: when the fetch cannot happen, the
 * answer is "cannot tell" and the run proceeds.
 */
async function stalenessOf(repoRoot: string): Promise<string | undefined> {
  const exec = promisify(execFile);
  try {
    await exec('git', ['fetch', '--quiet', 'origin'], { cwd: repoRoot, timeout: 20_000 });
  } catch {
    return undefined;
  }
  for (const ref of ['origin/HEAD', 'origin/main']) {
    try {
      const { stdout } = await exec('git', ['rev-list', '--count', `HEAD..${ref}`], { cwd: repoRoot });
      const behind = Number(stdout.trim());
      return behind > 0 ? `${behind} commit(s) behind ${ref}` : undefined;
    } catch {
      continue;
    }
  }
  return undefined;
}

async function main(): Promise<void> {
  const [id, ...rest] = process.argv.slice(2);
  const make = id !== undefined ? WORKFLOWS[id] : undefined;
  if (make === undefined) {
    say(`usage: maintain <${Object.keys(WORKFLOWS).join('|')}> [--batch n] [--since ref] [--skip n] [--commit false] [--publish false] [--checks "a,b"]`);
    process.exitCode = 2;
    return;
  }

  const workflow = make();
  const raw = parseFlags(rest);
  const params = workflow.params.parse(raw);
  const env = maintenanceEnvFromProcess();
  say(`${workflow.id} — model ${env.model} (${env.provider})`);

  const repoRoot = await resolveRepo((params as { repoRoot?: string }).repoRoot ?? '');
  const stale = await stalenessOf(repoRoot);
  if (stale !== undefined) {
    if (raw['allowStale'] !== true) {
      say(`refusing: ${repoRoot} is ${stale} — a stale repository re-finds already-merged work.`);
      say('Pull first, or pass --allowStale true to run anyway.');
      process.exitCode = 1;
      return;
    }
    say(`warning: ${stale} — proceeding because --allowStale was given`);
  }

  const build = await workflow.build(params, env);
  const progress: GraphRunnerMiddleware = {
    afterNodeExecute: async (ctx) => { say(`  ✓ ${ctx.node.id}`); },
  };

  const durability = await durabilityFromEnv();
  say(`recording: ${durability.kind === 'postgres' ? 'postgres (joins the shared corpus)' : 'in-memory (gone with the process)'}`);
  let recorded;
  try {
    recorded = await runRecorded(build.graph, build.input, {
      ...(durability.persistence !== undefined ? { persistence: durability.persistence } : {}),
      providers: providersFor(env),
      runner: {
        ...build.runner,
        middleware: [progress],
        ...(durability.eventLog !== undefined ? { eventLog: durability.eventLog } : {}),
      },
    });
  } finally {
    await durability.close();
  }

  const memory = recorded.memory as Record<string, Record<string, unknown> | undefined>;
  const scan = memory['scan_result'];
  const commit = memory['commit_result'];
  const publish = memory['publish_result'];
  const pick = memory['pick_result'];
  const judgeResult = memory['judge_result'];
  say('');
  say(`status: ${recorded.state.status}`);
  if (scan !== undefined) say(`findings in scope: ${String(scan['total'])}`);
  if (pick !== undefined) {
    say(`picked: ${pick['has_work'] === true
      ? `${String(pick['key'] ?? '')}${pick['issue_number'] !== undefined ? ` (issue #${String(pick['issue_number'])})` : ' (detached)'}`
      : String(pick['detail'] ?? 'nothing')}`);
  }
  if (judgeResult !== undefined) say(`judge: ${String(judgeResult['detail'] ?? '')}`);
  const benchVerdict = memory['verdict_result'];
  if (benchVerdict !== undefined) say(`verdict: ${String(benchVerdict['detail'] ?? '')}`);
  const ticket = memory['ticket_result'];
  if (ticket !== undefined) {
    say(`ticket: ${String(ticket['detail'] ?? '')}`);
    if (ticket['url'] !== undefined) say(`  issue: ${String(ticket['url'])}`);
  }
  if (commit !== undefined) {
    say(`commits: ${String(commit['count'] ?? 0)}${commit['branch'] !== undefined ? ` on ${String(commit['branch'])}` : ''}`);
  }
  if (publish !== undefined) {
    say(`publish: ${String(publish['detail'] ?? '')}`);
    if (publish['prUrl'] !== undefined) say(`pull request: ${String(publish['prUrl'])}`);
    if (publish['openUrl'] !== undefined) say(`open a PR at: ${String(publish['openUrl'])}`);
  }
  const triage = memory['triage_result'];
  if (triage !== undefined) {
    say(`triage: ${String(triage['detail'] ?? '')}`);
    for (const entry of (triage['filed'] as { url: string }[] | undefined) ?? []) {
      say(`  issue: ${entry.url}`);
    }
    const would = triage['would_file'] as string[] | undefined;
    if (would !== undefined && would.length > 0) say(`  would file: ${would.join(', ')}`);
  }
  process.exitCode = recorded.state.status === 'completed' ? 0 : 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
