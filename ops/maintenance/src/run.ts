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
 * `main` is the orchestration; the run itself, its outcome bookkeeping,
 * and the human report are each their own function below.
 *
 * @module maintenance/run
 */

import { createProviderRegistry, createWorkflowState, registerOllamaProvider, runRecorded } from '@cycgraph/orchestrator';
import type { EventLogWriter, GraphRunnerMiddleware, PersistenceProvider, ProviderRegistry } from '@cycgraph/orchestrator';
import { createOpenAI } from '@ai-sdk/openai';
import { coreUpkeep } from './code-scan/index.js';
import { repoDocsMaintenance, websiteDocsMaintenance } from './docs/index.js';
import { issueFix } from './issue-fix/index.js';
import { optPropose } from './optimization-propose/index.js';
import { featPropose } from './feature-propose/index.js';
import { repoAudit } from './repo-audit/index.js';
import { reconcileOutcomes } from './shared/reconcile.js';
import { fetchStats, formatStats } from './shared/stats.js';
import { tunePropose } from './tune/index.js';
import { featImplement } from './implement-ticket/index.js';
import { optApply } from './optimization-apply/index.js';
import { prRevise } from './pr-revise/index.js';
import { prReview } from './pr-review/index.js';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { getInjectedFactIds } from '@cycgraph/orchestrator';
import type { AuditSchedule } from './repo-audit/schedule.js';
import { maintenanceEnvFromProcess } from './shared/env.js';
import { modelFor } from './shared/models.js';
import { actionsRunUrl } from './shared/provenance.js';
import { contextOf } from './shared/context.js';
import { memoryFromEnv } from './shared/memory.js';
import { resolveRepo } from './shared/repo.js';
import type { MaintenanceBuild, MaintenanceEnv, MaintenanceWorkflow } from './types.js';

const WORKFLOWS: Record<string, () => MaintenanceWorkflow> = {
  'fix-repo-docs': repoDocsMaintenance,
  'fix-website-docs': websiteDocsMaintenance,
  'code-scan': coreUpkeep,
  'issue-fix': issueFix,
  'optimization-propose': optPropose,
  'feature-propose': featPropose,
  'repo-audit': repoAudit,
  'optimization-apply': optApply,
  'implement-ticket': featImplement,
  'pr-revise': prRevise,
  'pr-review': prReview,
  tune: tunePropose,
};

const NUMBER_FLAGS = new Set(['batch', 'skip', 'maxIssues', 'issueNumber', 'minImprovement', 'attempts', 'budgetTokens', 'pr', 'maxAuditors', 'concurrency', 'steps', 'maxFindings', 'sinceDays', 'trials']);
const BOOLEAN_FLAGS = new Set(['commit', 'publish', 'lint', 'file', 'allowStale', 'push', 'comment', 'revise', 'apply', 'approve', 'merge']);
const LIST_FLAGS = new Set(['checks', 'lenses', 'scopes']);

type Flags = Record<string, unknown>;

function parseFlags(args: string[]): Flags {
  const raw: Flags = {};
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

/** What `runRecorded` hands back — the run's final state, memory, and id. */
type Recorded = Awaited<ReturnType<typeof runRecorded>>;
/** A single node's result object, read from the run's memory. */
type NodeResult = Record<string, unknown> | undefined;

/** The run memory as a bag of node results, addressed by `<node>_result`. */
function resultsOf(recorded: Recorded): Record<string, NodeResult> {
  return recorded.memory as Record<string, NodeResult>;
}

/** The `detail` string a node result usually carries, or `''`. */
function detail(result: NodeResult): string {
  return String(result?.['detail'] ?? '');
}

/** Collapse a multi-line output to one CI-log line. */
function oneLine(text: string): string {
  return text.replace(/\n/g, ' ⏎ ');
}

/**
 * One line describing the audit patrol's scheduler state for this run.
 *
 * Without a lesson store the last-audited clock is neither read nor
 * advanced, so every run repeats the same diagonal lens × scope slice —
 * a staleness indistinguishable, in a CI log, from a store that is
 * present but never written. The banner separates the two cases.
 */
async function patrolStatus(env: MaintenanceEnv): Promise<string> {
  if (env.auditSchedule === undefined) {
    return 'patrol: off (no DATABASE_URL) — fixed diagonal charter order, no oldest-audited-first rotation and no clock to advance';
  }
  const schedule = await env.auditSchedule.load();
  if (schedule === undefined) {
    return 'patrol: on — no schedule recorded yet, this run seeds the clock';
  }
  const dated = Object.keys(schedule.pairs).length;
  return `patrol: on — ${dated} pair(s) dated, last audited head ${schedule.head === undefined ? 'unknown' : schedule.head.slice(0, 7)}`;
}

/**
 * Whether the repository is behind its origin's default branch, after a
 * fetch. A stale local repository re-finds work that is already merged
 * and delivers a duplicate, so a run against one is refused rather than
 * wasted. Offline is not staleness: when the fetch cannot happen, the
 * answer is "cannot tell" and the run proceeds.
 */
async function stalenessOf(repoRoot: string, defaultBranch: string): Promise<string | undefined> {
  const exec = promisify(execFile);
  try {
    await exec('git', ['fetch', '--quiet', 'origin'], { cwd: repoRoot, timeout: 20_000 });
  } catch {
    return undefined;
  }
  for (const ref of ['origin/HEAD', `origin/${defaultBranch}`]) {
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

// ─── Ledger-only subcommands (no graph runs) ────────────────────────────

/** Print the fleet scorecard over the recorded corpus. */
async function runStats(flags: Flags): Promise<void> {
  if ((process.env['DATABASE_URL'] ?? '') === '') {
    say('stats needs DATABASE_URL — there is no corpus without it.');
    process.exitCode = 2;
    return;
  }
  const { closeDb } = await import('@cycgraph/orchestrator-postgres');
  try {
    const sinceDays = typeof flags['sinceDays'] === 'number' ? flags['sinceDays'] : 14;
    for (const line of formatStats(await fetchStats(sinceDays), sinceDays)) say(line);
  } finally {
    await closeDb();
  }
}

/**
 * Feed human merge decisions back as outcome evidence: every recently
 * recorded run that published a PR is scored by what became of it.
 */
async function runReconcileOutcomes(flags: Flags): Promise<void> {
  const memory = await memoryFromEnv();
  if (memory === undefined) {
    say('reconcile-outcomes needs DATABASE_URL — there is no ledger without it.');
    process.exitCode = 2;
    return;
  }
  const { closeDb } = await import('@cycgraph/orchestrator-postgres');
  try {
    const sinceDays = typeof flags['sinceDays'] === 'number' ? flags['sinceDays'] : 14;
    const apply = flags['apply'] !== false;
    const reconciled = await reconcileOutcomes({
      repoRoot: await resolveRepo(''),
      sinceDays,
      apply,
      recordOutcome: (runId, score, factIds) => memory.recordOutcome(runId, score, factIds),
    });
    const decided = reconciled.filter((entry) => entry.score !== undefined);
    say(`reconciled ${reconciled.length} published run(s), ${decided.length} decided${apply ? '' : ' (dry run — nothing recorded)'}`);
    for (const entry of reconciled) {
      say(`  #${entry.pr} ${entry.state}${entry.score !== undefined ? ` → score ${entry.score}` : ''} (run ${entry.runId.slice(0, 8)}, ${entry.factIds} lesson(s))`);
    }
  } finally {
    await closeDb();
  }
}

/**
 * Run the retention gate over the candidate lesson pool: promote lessons
 * whose runs pass their gates, evict ones that correlate with failures,
 * hold the rest for more evidence.
 */
async function runMemoryGate(): Promise<void> {
  const memory = await memoryFromEnv();
  if (memory === undefined) {
    say('memory-gate needs DATABASE_URL — there is no lesson pool without it.');
    process.exitCode = 2;
    return;
  }
  const { closeDb } = await import('@cycgraph/orchestrator-postgres');
  try {
    const report = await memory.retention();
    say(`promoted: ${report.promoted.length} · evicted: ${report.evicted.length} · held: ${report.held.length}`);
    for (const entry of report.promoted) say(`  promoted ${entry.factId}`);
    for (const entry of report.evicted) say(`  evicted ${entry.factId} (${entry.reason})`);
  } finally {
    await closeDb();
  }
}

/**
 * The non-graph subcommands: ledger-only reads and gates, keyed by id.
 * Each is meant for a cadence (nightly gate, daily reconcile) or a
 * read-only query (stats) rather than a workflow run.
 */
const SUBCOMMANDS: Record<string, (flags: Flags) => Promise<void>> = {
  'memory-gate': () => runMemoryGate(),
  'reconcile-outcomes': (flags) => runReconcileOutcomes(flags),
  stats: (flags) => runStats(flags),
};

/** The lesson memory plus a memoized audit-schedule reader, or undefined without a store. */
type LessonMemory = NonNullable<Awaited<ReturnType<typeof memoryFromEnv>>>;

// ─── The graph run ──────────────────────────────────────────────────────

/**
 * Run the graph, recorded. On an engine-level throw (a budget breach that
 * bypasses the graph's own failure handling) the workflow's `onFatal`
 * cleanup is the only thing that can still flag the picked issue, so it
 * runs before the error propagates.
 */
async function executeGraph(
  build: MaintenanceBuild,
  env: MaintenanceEnv,
  durability: Durability,
  lessonMemory: LessonMemory | undefined,
  runId: string,
): Promise<Recorded> {
  const progress: GraphRunnerMiddleware = {
    afterNodeExecute: async (ctx) => { say(`  ✓ ${ctx.node.id}`); },
  };
  try {
    // The run id is the one the build was handed, so what the workflow
    // posts names the recorded run it belongs to.
    const state = createWorkflowState({ workflowId: build.graph.id, runId, ...build.input });
    return await runRecorded(build.graph, state, {
      ...(durability.persistence !== undefined ? { persistence: durability.persistence } : {}),
      providers: providersFor(env),
      runner: {
        ...build.runner,
        middleware: [progress],
        ...(durability.eventLog !== undefined ? { eventLog: durability.eventLog } : {}),
        ...(lessonMemory !== undefined
          ? { memoryRetriever: lessonMemory.memoryRetriever, memoryWriter: lessonMemory.memoryWriter }
          : {}),
      },
    });
  } catch (error) {
    const cleanup = await build.onFatal?.(error);
    if (cleanup !== undefined) say(cleanup);
    throw error;
  }
}

/**
 * After a run returns, attribute its result to the lessons it carried and
 * advance the audit clock — the bookkeeping that turns one run into
 * training evidence. All best-effort: a ledger write failing here must
 * never turn a delivered run into a reported failure.
 */
async function recordRunOutcomes(
  recorded: Recorded,
  build: MaintenanceBuild,
  lessonMemory: LessonMemory | undefined,
): Promise<void> {
  // A non-throwing failed status — an iteration cap, or a dead end with
  // no matching edge — never reaches the graph's give-up node, so the
  // workflow's cleanup runs here too, flagging the picked issue rather
  // than leaving it approved-but-orphaned (the #222 shape reached via
  // the iteration cap instead of a budget breach).
  if (recorded.state.status === 'failed') {
    const cleanup = await build.onFatal?.(recorded.state.last_error ?? new Error('run ended in a failed state without delivering a pull request'));
    if (cleanup !== undefined) say(cleanup);
  }

  if (lessonMemory === undefined) return;
  const memory = resultsOf(recorded);

  // Outcome evidence: attribute the gate verdict to the lessons that were
  // injected into this run's prompts. Recorded only when a gate actually
  // ran — a run that ended before its gate carries no signal either way.
  const injected = getInjectedFactIds(recorded.state);
  const gateVerdict = memory['gate_verification_passed'];
  const siftEnvFailure = (memory['sift_result'] as { ledger_unavailable?: boolean } | undefined)?.ledger_unavailable === true;
  if (siftEnvFailure) {
    say('lessons: gate failed for an environmental reason (issue ledger unreadable) — no outcome recorded');
  } else if (injected.length > 0 && typeof gateVerdict === 'boolean') {
    try {
      await lessonMemory.recordOutcome(recorded.runId, gateVerdict ? 1 : 0, injected);
      say(`lessons: ${injected.length} injected — ${gateVerdict ? 'pass' : 'fail'} outcome recorded against them`);
    } catch (bookkeepingError) {
      // A ledger write failing must not turn a delivered run into a
      // reported failure — the PR stands whether or not the outcome
      // was recorded.
      say(`lessons: outcome not recorded (${bookkeepingError instanceof Error ? bookkeepingError.message : String(bookkeepingError)})`);
    }
  } else if (injected.length > 0) {
    say(`lessons: ${injected.length} injected — no gate verdict this run, no outcome recorded`);
  }
  const reflected = memory['reflect_reflection'] as { fact_ids?: string[] } | undefined;
  if (reflected?.fact_ids !== undefined) {
    say(`lessons: ${reflected.fact_ids.length} new candidate(s) written`);
  }

  // Patrol scheduling: advance the last-audited clock for the pairs this
  // run actually spent slots on — skipped and failed workers stay at their
  // old timestamps and re-surface oldest-first. Only a COMPLETED run
  // advances it: a run that died after auditing but before filing produced
  // findings nobody saw, so its pairs must resurface rather than count as
  // covered.
  const cloneResult = memory['clone_result'] as { head?: string; charters?: Array<{ lens: string; scope: string }> } | undefined;
  if (recorded.state.status !== 'completed' || typeof cloneResult?.head !== 'string' || !Array.isArray(cloneResult.charters)) {
    return;
  }
  // A pair counts as audited only when its worker delivered a report — a
  // worker that ran out of steps reporting nothing leaves its pair stale.
  const reported = new Set(
    ((memory['audit_results'] as Array<{ index: number; updates?: Record<string, unknown> }> | undefined) ?? [])
      .filter((entry) => typeof entry.updates?.['audit_report'] === 'string' && entry.updates['audit_report'] !== '')
      .map((entry) => entry.index),
  );
  const auditedPairs = cloneResult.charters.filter((_, index) => reported.has(index));
  if (auditedPairs.length === 0) {
    say('audit schedule: no worker delivered a report — the clock did not advance, the same pairs resurface next run');
    return;
  }
  try {
    await lessonMemory.saveAuditSchedule({ head: cloneResult.head, auditedPairs, at: new Date() });
    say(`audit schedule: ${auditedPairs.length} pair(s) recorded at ${cloneResult.head.slice(0, 7)}`);
  } catch (bookkeepingError) {
    say(`audit schedule: not recorded (${bookkeepingError instanceof Error ? bookkeepingError.message : String(bookkeepingError)})`);
  }
}

/**
 * The machine-readable result a harness reads when it runs maintain as a
 * subprocess (the tune trials): status, gate verdict, spend, and a
 * per-workflow thoroughness `yield`. Written only when `MAINTAIN_RESULT_JSON`
 * names a path.
 */
async function writeResultJson(recorded: Recorded): Promise<void> {
  const resultPath = process.env['MAINTAIN_RESULT_JSON'];
  if (resultPath === undefined || resultPath === '') return;
  const { writeFile } = await import('node:fs/promises');
  const { MaintainResultSchema } = await import('./tune/index.js');
  const memory = resultsOf(recorded);
  const verdict = memory['gate_verification_passed'];
  // The run's thoroughness signal for a tune trial, by workflow: how many
  // findings repo-audit kept, or how many stale references the docs
  // workflows fixed. A cheaper variant that produced fewer is a
  // thoroughness regression the gate cannot see. Only one key is present
  // in any run, so this is a union, not a priority order. Single-unit
  // workflows (feature-propose's one proposal) report none: gate parity
  // already captures their thoroughness.
  const keptCount = (memory['sift_result'] as { kept_count?: unknown } | undefined)?.['kept_count'];
  const fixedCount = (memory['commit_result'] as { count?: unknown } | undefined)?.['count'];
  const yieldValue = typeof keptCount === 'number' ? keptCount
    : typeof fixedCount === 'number' ? fixedCount
      : undefined;
  const gaveUp = memory['giveup_result'];
  await writeFile(resultPath, JSON.stringify(MaintainResultSchema.parse({
    status: recorded.state.status,
    gate: typeof verdict === 'boolean' ? verdict : null,
    tokens: recorded.state.total_tokens_used,
    cost_usd: recorded.state.total_cost_usd,
    gave_up: gaveUp?.['flagged'] === true,
    ...(yieldValue !== undefined ? { yield: yieldValue } : {}),
  })));
}

// ─── The human report ───────────────────────────────────────────────────

/** Print `label: <detail>` when the node ran; the common one-liner shape. */
function sayDetail(label: string, result: NodeResult): void {
  if (result !== undefined) say(`${label}: ${detail(result)}`);
}

/** Print the run's status, spend, and every node result worth surfacing. */
function printReport(recorded: Recorded): void {
  const memory = resultsOf(recorded);
  say('');
  say(`status: ${recorded.state.status}`);
  if (recorded.state.status !== 'completed' && recorded.state.last_error !== undefined) {
    say(`last error: ${recorded.state.last_error}`);
  }
  say(`tokens: ${recorded.state.total_tokens_used.toLocaleString('en-US')} · $${recorded.state.total_cost_usd.toFixed(4)}`);

  const scan = memory['scan_result'];
  if (scan !== undefined) say(`findings in scope: ${String(scan['total'])}`);
  for (const entry of (scan?.['needs_human'] as string[] | undefined) ?? []) {
    say(`  needs a human (no candidate anywhere in the repo): ${entry}`);
  }

  const pick = memory['pick_result'];
  if (pick !== undefined) {
    say(`picked: ${pick['has_work'] === true
      ? `${String(pick['key'] ?? '')}${pick['issue_number'] !== undefined ? ` (issue #${String(pick['issue_number'])})` : ' (detached)'}`
      : String(pick['detail'] ?? 'nothing')}`);
  }
  sayDetail('judge', memory['judge_result']);
  sayDetail('gave up', memory['giveup_result']);

  const accept = memory['accept_result'];
  if (accept !== undefined) {
    say(`acceptance: ${detail(accept)}`);
    const firstFailure = (accept['failed'] as { command: string; output: string }[] | undefined)?.[0];
    if (firstFailure !== undefined) {
      say(`  ${firstFailure.command} output: …${oneLine(firstFailure.output).slice(-400)}`);
    }
  }

  const gather = memory['gather_result'];
  if (gather !== undefined && gather['has_work'] !== true) say(`gather: ${detail(gather)}`);

  const deliver = memory['deliver_result'];
  sayDetail('deliver', deliver);
  // A dry run prints everything it would have posted, exactly as it would
  // have posted it. A review that was written but not submitted prints
  // its raw text instead, so nothing the reviewer wrote is lost.
  const preview = deliver?.['preview'];
  const reviewText = memory['review'] as unknown;
  if (typeof preview === 'string') {
    say('would post (dry run):');
    say(preview.slice(0, 20_000));
  } else if (typeof reviewText === 'string' && deliver !== undefined && deliver['posted'] !== true) {
    say('review text (not posted):');
    say(reviewText.slice(0, 4_000));
  }
  sayDetail('review', memory['review_check_result']);

  const shape = memory['shape_result'];
  if (shape !== undefined) {
    say(`shape: ${detail(shape)}`);
    if (shape['proposal_head'] !== undefined) say(`  proposal began: ${oneLine(String(shape['proposal_head'])).slice(0, 300)}`);
  }

  const applyResult = memory['apply_result'];
  if (applyResult !== undefined && applyResult['applied'] !== true) {
    say(`apply: ${String(applyResult['detail'] ?? 'the diff did not apply')}`);
  }

  const checksResult = memory['checks_result'];
  if (checksResult !== undefined && checksResult['clean'] === false) {
    say(`checks failed: ${oneLine(String(checksResult['output'] ?? '')).slice(-400)}`);
  }

  sayDetail('verdict', memory['verdict_result']);

  const sift = memory['sift_result'];
  if (sift !== undefined) {
    const drops = sift['drops'] as Record<string, number> | undefined;
    say(`sift: ${String(sift['report_count'])} report(s) → kept ${String(sift['kept_count'])}, clean ${String(sift['clean_reports'])}${drops !== undefined
      ? ` · dropped: malformed ${drops['malformed']}, no_evidence ${drops['no_evidence']}, duplicate ${drops['duplicate']}, already_filed ${drops['already_filed']}`
      : ''}`);
    for (const finding of (sift['kept'] as Array<{ severity: string; title: string }> | undefined) ?? []) {
      say(`  [${finding.severity}] ${finding.title}`);
    }
  }

  const ticket = memory['ticket_result'];
  if (ticket !== undefined) {
    say(`ticket: ${detail(ticket)}`);
    if (ticket['url'] !== undefined) say(`  issue: ${String(ticket['url'])}`);
  }

  const commit = memory['commit_result'];
  if (commit !== undefined) {
    say(`commits: ${String(commit['count'] ?? 0)}${commit['branch'] !== undefined ? ` on ${String(commit['branch'])}` : ''}`);
  }

  const publish = memory['publish_result'];
  if (publish !== undefined) {
    say(`publish: ${detail(publish)}`);
    if (publish['prUrl'] !== undefined) say(`pull request: ${String(publish['prUrl'])}`);
    if (publish['openUrl'] !== undefined) say(`open a PR at: ${String(publish['openUrl'])}`);
  }

  const triage = memory['triage_result'];
  if (triage !== undefined) {
    say(`triage: ${detail(triage)}`);
    for (const entry of (triage['filed'] as { url: string }[] | undefined) ?? []) {
      say(`  issue: ${entry.url}`);
    }
    const would = triage['would_file'] as string[] | undefined;
    if (would !== undefined && would.length > 0) say(`  would file: ${would.join(', ')}`);
  }
}

// ─── Orchestration ──────────────────────────────────────────────────────

/** Build the run environment, wiring lesson memory and its memoized schedule reader. */
async function environmentFor(): Promise<{ env: MaintenanceEnv; lessonMemory: LessonMemory | undefined }> {
  const env = maintenanceEnvFromProcess();
  const lessonMemory = await memoryFromEnv();
  env.memory = lessonMemory !== undefined;
  if (lessonMemory !== undefined) {
    // Memoized: the banner and the workflow's charter ordering read the
    // same state, and one fact fetched once keeps them consistent.
    let pending: Promise<AuditSchedule | undefined> | undefined;
    env.auditSchedule = { load: () => (pending ??= lessonMemory.loadAuditSchedule()) };
  }
  return { env, lessonMemory };
}

/** Run one workflow end to end: build, guard staleness, execute, record, report. */
async function runWorkflow(id: string, make: () => MaintenanceWorkflow, rest: string[]): Promise<void> {
  const workflow = make();
  const raw = parseFlags(rest);
  const params = workflow.params.parse(raw);
  const { env, lessonMemory } = await environmentFor();

  const tiers = env.models === undefined
    ? ''
    : ` · tiers ${(['high', 'medium', 'low'] as const).map((t) => `${t}=${modelFor(env, t)}`).join(' ')}`;
  say(`${workflow.id} — model ${env.model} (${env.provider})${tiers}${env.memory ? ' · lessons: on' : ''}`);
  if (id === 'repo-audit') say(await patrolStatus(env));

  const repoRoot = await resolveRepo((params as { repoRoot?: string }).repoRoot ?? '');
  const stale = await stalenessOf(repoRoot, contextOf(env).defaultBranch);
  if (stale !== undefined) {
    if (raw['allowStale'] !== true) {
      say(`refusing: ${repoRoot} is ${stale} — a stale repository re-finds already-merged work.`);
      say('Pull first, or pass --allowStale true to run anyway.');
      process.exitCode = 1;
      return;
    }
    say(`warning: ${stale} — proceeding because --allowStale was given`);
  }

  const runUrl = actionsRunUrl();
  const provenance = { runId: randomUUID(), ...(runUrl !== undefined ? { runUrl } : {}) };
  const build = await workflow.build(params, { ...env, provenance });
  const durability = await durabilityFromEnv();
  say(`recording: run ${provenance.runId} · ${durability.kind === 'postgres' ? 'postgres (joins the shared corpus)' : 'in-memory (gone with the process)'}`);

  // Everything that uses the run's result sits inside the try so the
  // database is closed on any exit, including an engine-level throw.
  try {
    const recorded = await executeGraph(build, env, durability, lessonMemory, provenance.runId);
    await recordRunOutcomes(recorded, build, lessonMemory);
    await writeResultJson(recorded);
    printReport(recorded);
    process.exitCode = recorded.state.status === 'completed' ? 0 : 1;
  } finally {
    await durability.close();
  }
}

async function main(): Promise<void> {
  // Engine info logs carry the per-agent token_usage lines (cache reads
  // and billed totals) that make a CI run's spend diagnosable; the
  // logger's default level would hide them.
  process.env['LOG_LEVEL'] ??= 'info';

  // Claude 5 models ignore sampling parameters and the AI SDK says so on
  // every call; once understood, the repetition only buries real output
  // in CI logs.
  (globalThis as Record<string, unknown>)['AI_SDK_LOG_WARNINGS'] = false;

  const [id, ...rest] = process.argv.slice(2);

  // Ledger-only subcommands (memory-gate, reconcile-outcomes, stats) run
  // no graph; they read or gate the corpus and return.
  const subcommand = id !== undefined ? SUBCOMMANDS[id] : undefined;
  if (subcommand !== undefined) {
    await subcommand(parseFlags(rest));
    return;
  }

  const make = id !== undefined ? WORKFLOWS[id] : undefined;
  if (make === undefined) {
    say(`usage: maintain <${Object.keys(WORKFLOWS).join('|')}|${Object.keys(SUBCOMMANDS).join('|')}> [--batch n] [--since ref] [--skip n] [--commit false] [--publish false] [--checks "a,b"]`);
    process.exitCode = 2;
    return;
  }

  // Tune's sensor is the corpus itself; fail before building providers
  // rather than dying inside a graph node.
  if (id === 'tune' && (process.env['DATABASE_URL'] ?? '') === '') {
    say('tune needs DATABASE_URL — the corpus is its sensor.');
    process.exitCode = 2;
    return;
  }

  await runWorkflow(id as string, make, rest);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
