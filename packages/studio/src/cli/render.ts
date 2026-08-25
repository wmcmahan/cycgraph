/**
 * Terminal rendering
 *
 * Everything the CLI prints. Kept apart from the run driver so the same driver
 * can feed a different front end without dragging escape codes along.
 *
 * @module cli/render
 */

import { describeLever, describeProposal } from '@cycgraph/evals';
import type { InsightsReport, VariantOutcome, WorkflowProfile } from '@cycgraph/evals';
import type { ProposalRecord } from '../improve/proposals.js';
import type { SweepEstimate, TuneOutcome } from '../improve/tune.js';
import type { StreamEvent } from '@cycgraph/orchestrator';
import type { ParamField } from '../params/introspect.js';
import type { RunOutcome } from '../run/execute.js';
import { isPass, type SweepResult } from '../run/sweep.js';
import type { ForkOutcome, ConformanceResult } from '../run/fork.js';
import type { WatchRow } from '../improve/watch.js';
import { isClean, nestForks, varyingParams, type HistoryEntry, type RunLogLine, type RunTree } from '../run/history.js';
import type { ScenarioAvailability } from '../scenarios/catalog.js';
import { STACK_FEATURES, type Stack } from '../stack/index.js';

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

const out = (line = ''): void => { process.stdout.write(`${line}\n`); };

/** One line per feature, with the reason when a requested one is absent. */
export function renderStack(stack: Stack): void {
  out();
  out(`${BOLD}stack${RESET}   model ${stack.config.model}   tenant ${stack.config.tenant}`);
  const gapReasons = new Map(stack.gaps.map((gap) => [gap.feature, gap.reason]));

  for (const feature of STACK_FEATURES) {
    if (stack.available.has(feature)) {
      out(`  ${GREEN}✓${RESET} ${feature}`);
    } else {
      const reason = gapReasons.get(feature);
      out(reason ? `  ${YELLOW}✗${RESET} ${feature} ${DIM}${reason}${RESET}` : `  ${DIM}· ${feature} not requested${RESET}`);
    }
  }
  out();
}

/** The scenario menu, with unavailable entries dimmed and explained. */
export function renderScenarios(entries: readonly ScenarioAvailability[]): void {
  out(`${BOLD}scenarios${RESET}`);
  for (const entry of entries) {
    const { scenario, runnable, missing } = entry;
    const id = scenario.id.padEnd(22);
    if (runnable) {
      out(`  ${id} ${scenario.title}`);
    } else {
      out(`  ${DIM}${id} ${scenario.title}${RESET}`);
      out(`  ${DIM}${' '.repeat(22)} needs ${missing.join(', ')}${RESET}`);
    }
    out(`  ${DIM}${' '.repeat(22)} ${scenario.covers.join(' · ')}${RESET}`);
  }
  out();
}

/** A scenario's flags, defaults, and allowed values. */
export function renderParams(fields: readonly ParamField[]): void {
  out(`${BOLD}parameters${RESET}`);
  for (const field of fields) {
    const flag = field.flag.padEnd(26);
    const shown = field.default === undefined ? '—' : JSON.stringify(field.default);
    out(`  ${flag} ${DIM}${shown}${RESET}`);
    if (field.description) out(`  ${' '.repeat(26)} ${DIM}${field.description}${RESET}`);
    if (field.options) out(`  ${' '.repeat(26)} ${DIM}one of ${field.options.join(', ')}${RESET}`);
  }
  out();
}

/**
 * Live progress for one run.
 *
 * Only node lifecycle, tool calls, and pauses are printed. Token deltas and
 * state persistence land in the artifacts, where they belong; echoing them
 * here buries the shape of the run in noise.
 */
export function renderEvent(event: StreamEvent): void {
  switch (event.type) {
    case 'node:start':
      out(`  ${DIM}▸${RESET} ${event.node_id.padEnd(16)} ${DIM}${event.node_type}${RESET}`);
      break;
    case 'node:complete':
      out(`  ${GREEN}✓${RESET} ${event.node_id.padEnd(16)} ${DIM}${event.duration_ms}ms${RESET}`);
      break;
    case 'node:failed':
      out(`  ${RED}✗${RESET} ${event.node_id.padEnd(16)} ${RED}${event.error}${RESET} ${DIM}attempt ${event.attempt}${RESET}`);
      break;
    case 'node:retry':
      out(`  ${YELLOW}↻${RESET} ${event.node_id.padEnd(16)} ${DIM}retry ${event.attempt} after ${event.backoff_ms}ms${RESET}`);
      break;
    case 'tool:call_finish':
      out(`  ${DIM}  ${event.tool_name} ${event.success ? 'ok' : 'failed'} ${event.duration_ms}ms${RESET}`);
      break;
    case 'workflow:waiting':
      out(`  ${YELLOW}⏸${RESET} waiting: ${event.waiting_for}`);
      break;
    default:
      break;
  }
}

/** Spend per node, worst first — the answer to which step costs money. */
function renderNodeCost(outcome: RunOutcome): void {
  const byNode = outcome.usage.byNode;
  if (!byNode || Object.keys(byNode).length === 0) return;

  const rows = Object.entries(byNode)
    .sort(([, a], [, b]) => (b.cost_usd - a.cost_usd) || (b.input_tokens + b.output_tokens - a.input_tokens - a.output_tokens));

  out(`  ${DIM}cost by node${RESET}`);
  for (const [nodeId, spend] of rows) {
    const tokens = spend.input_tokens + spend.output_tokens;
    out(
      `    ${nodeId.padEnd(18)}${DIM}${String(tokens).padStart(6)} tok  ` +
      `$${spend.cost_usd.toFixed(4)}  ${spend.calls} call${spend.calls === 1 ? '' : 's'}${RESET}`,
    );
  }
}

/** One line of a value, for reading next to its provenance. */
function preview(value: unknown, max = 96): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  const flat = text.replace(/\s+/g, ' ');
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Untrusted data that reached memory, as a provenance chain.
 *
 * A `derived` entry names the keys it came from, so a value can be followed
 * back to the tool or remote agent that introduced it.
 */
function renderTaint(outcome: RunOutcome): void {
  const registry = outcome.finalState?.taint_registry ?? {};
  const keys = Object.keys(registry);
  if (keys.length === 0) return;

  out(`  ${DIM}tainted${RESET}`);
  for (const key of keys) {
    const meta = registry[key]!;
    const origin = meta.server_id ?? meta.tool_name ?? meta.agent_id ?? '';
    const from = meta.derived_from?.length ? ` ← ${meta.derived_from.join(', ')}` : '';
    const size = meta.bytes === undefined ? '' : ` ${meta.bytes}B`;
    const value = outcome.finalState?.memory?.[key];
    out(
      `    ${key.padEnd(18)}${DIM}${meta.source}${origin ? ` ${origin}` : ''}${size}${from}${RESET}`,
    );
    if (value !== undefined) out(`      ${DIM}${preview(value)}${RESET}`);
  }
}

/** The closing summary: status, cost, taint, evals, artifact path. */
export function renderOutcome(outcome: RunOutcome): void {
  const colour = outcome.status === 'completed' ? GREEN : RED;
  out();
  out(`  ${colour}${outcome.status}${RESET} in ${outcome.durationMs}ms`);
  out(
    `  ${DIM}${outcome.usage.totalTokens} tokens · ` +
    `$${outcome.usage.totalCostUsd.toFixed(4)} · ` +
    `${outcome.usage.nodesVisited} nodes${outcome.resumes > 0 ? ` · ${outcome.resumes} resumes` : ''}${RESET}`,
  );
  if (outcome.error) out(`  ${RED}${outcome.error}${RESET}`);

  renderNodeCost(outcome);
  renderTaint(outcome);

  if (outcome.evals.length > 0) {
    const passed = outcome.evals.filter((result) => result.passed).length;
    const all = passed === outcome.evals.length;
    out(`  ${all ? GREEN : RED}evals ${passed}/${outcome.evals.length}${RESET}`);
    for (const result of outcome.evals.filter((r) => !r.passed)) {
      out(`    ${RED}✗${RESET} ${result.assertion.type} ${DIM}${result.message ?? ''}${RESET}`);
    }
  }

  out(`  ${DIM}${outcome.dir}${RESET}`);
  out();
}

/** Format a swept value compactly enough for a table cell. */
function cell(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.join('+');
  return JSON.stringify(value) ?? String(value);
}

/**
 * One row per run, one column per swept parameter.
 *
 * Only the parameters that actually varied get columns: a table of thirty
 * identical values is what a fixed flag already told you.
 */
export function renderSweep(result: SweepResult): void {
  const columns = [...new Set(result.entries.flatMap((e) => Object.keys(e.variant)))];
  const widths = columns.map((column) =>
    Math.max(column.length, ...result.entries.map((e) => cell(e.variant[column]).length)));

  out();
  out(`${BOLD}sweep${RESET}  ${result.entries.length} runs`);
  out(
    '  ' + columns.map((column, i) => column.padEnd(widths[i]! + 2)).join('') +
    'status'.padEnd(12) + 'evals'.padEnd(8) + 'ms'.padEnd(8) + 'tokens',
  );

  for (const { variant, outcome } of result.entries) {
    const ok = outcome.evals.filter((r) => r.passed).length;
    const colour = isPass(outcome) ? GREEN : RED;
    out(
      '  ' + columns.map((column, i) => cell(variant[column]).padEnd(widths[i]! + 2)).join('') +
      `${colour}${outcome.status.padEnd(12)}${RESET}` +
      `${ok}/${outcome.evals.length}`.padEnd(8) +
      String(outcome.durationMs).padEnd(8) +
      String(outcome.usage.totalTokens),
    );
  }

  const failed = result.entries.length - result.passed;
  out();
  out(
    `  ${result.passed}/${result.entries.length} passed` +
    `${failed > 0 ? `${RED} · ${failed} failed${RESET}` : ''}` +
    `${DIM} · ${result.totalMs}ms · ${result.totalTokens} tokens` +
    `${result.totalCostUsd > 0 ? ` · $${result.totalCostUsd.toFixed(4)}` : ''}${RESET}`,
  );
  out();
}

/**
 * The first line of an error that says something.
 *
 * A ZodError's message is a JSON array, whose first line is `[`. Reporting
 * that tells a reader nothing, so the first line carrying a word wins.
 */
function firstMeaningfulLine(message: string): string {
  // A ZodError serializes its issues as JSON. The `message` field of the first
  // issue is the human-readable part; everything around it is structure.
  const zodMessage = /"message":\s*"([^"]+)"/.exec(message);
  if (zodMessage) {
    const path = /"path":\s*\[\s*"?([^"\]]*)"?/.exec(message);
    return `${zodMessage[1]}${path?.[1] ? ` at ${path[1]}` : ''}`.slice(0, 140);
  }
  const line = message.split('\n').map((l) => l.trim()).find((l) => /[a-z]/i.test(l));
  return (line ?? message).slice(0, 140);
}

/** A single fork's report, as the engine rendered it. */
export function renderFork(outcome: ForkOutcome): void {
  const colour = { better: GREEN, worse: RED, mixed: YELLOW, unchanged: DIM, unclear: YELLOW }[
    outcome.verdict.kind
  ];

  out();
  out(`${BOLD}fork${RESET}  ${outcome.runId.slice(0, 8)} of ${outcome.baseRunId.slice(0, 8)}`);
  // The verdict leads. What changed is the evidence for it, not the answer.
  out(`  ${colour}${outcome.verdict.summary}${RESET}`);
  for (const line of outcome.report.split('\n').slice(1)) out(`  ${line}`);
  if (outcome.memoized > 0) {
    out(`  ${DIM}${outcome.memoized} tail node(s) served from the recording${RESET}`);
  }
  out();
}

/**
 * Null-fork conformance across scenarios.
 *
 * One row per scenario, and a line per point that failed to reproduce the
 * original. A faithful scenario needs no detail: the count says it.
 */
/** The watch tick's report: one row per workflow, gated tier by tier. */
export function renderWatch(rows: readonly WatchRow[]): void {
  const width = Math.max(10, ...rows.map((row) => row.workflow.length));

  out();
  out(`${BOLD}watch${RESET}  sense freely, measure under ceilings, propose to the ledger`);
  for (const row of rows) {
    const colour = row.outcome === 'proposed' ? GREEN
      : row.outcome === 'awaiting-review' ? YELLOW
      : row.outcome === 'skipped' ? RED : DIM;
    const spend = row.forks > 0 ? ` ${DIM}(${row.forks} fork(s))${RESET}` : '';
    out(`  ${row.workflow.padEnd(width + 2)}${colour}${row.outcome.padEnd(17)}${RESET}${DIM}${row.detail}${RESET}${spend}`);
  }
  out();
  const proposed = rows.filter((row) => row.outcome === 'proposed');
  if (proposed.length > 0) {
    out(`  ${GREEN}${proposed.length} proposal(s) awaiting a human${RESET} — \`npm run play -- proposals\``);
    out();
  }
}


export function renderForkConformance(results: readonly ConformanceResult[]): void {
  const width = Math.max(8, ...results.map((r) => r.scenarioId.length));

  out();
  out(`${BOLD}fork conformance${RESET}  null fork at every point must reproduce the original`);
  out(`  ${'scenario'.padEnd(width + 2)}${'points'.padEnd(10)}${'faithful'.padEnd(11)}status`);

  for (const result of results) {
    const total = result.entries.length;
    const clean = result.faithful === total && result.errors.length === 0;
    const colour = clean ? GREEN : RED;
    const verdict = clean ? 'ok' : `${total - result.faithful} diverged, ${result.errors.length} error(s)`;
    out(
      `  ${result.scenarioId.padEnd(width + 2)}` +
      `${String(total).padEnd(10)}` +
      `${`${result.faithful}/${total}`.padEnd(11)}` +
      `${colour}${verdict}${RESET}`,
    );

    for (const entry of result.entries.filter((e) => !e.faithful)) {
      out(`    ${RED}✗${RESET} ${entry.point} @${entry.sequence}  ${DIM}${entry.divergence}${RESET}`);
    }
    for (const error of result.errors) {
      out(`    ${RED}!${RESET} ${error.point}  ${DIM}${firstMeaningfulLine(error.message)}${RESET}`);
    }
  }

  const points = results.reduce((sum, r) => sum + r.entries.length, 0);
  const faithful = results.reduce((sum, r) => sum + r.faithful, 0);
  const errors = results.reduce((sum, r) => sum + r.errors.length, 0);
  out();
  out(
    `  ${faithful}/${points} points faithful across ${results.length} scenario(s)` +
    `${errors > 0 ? `${RED} · ${errors} unforkable${RESET}` : ''}`,
  );
  out();
}

/** Relative age, since a wall-clock timestamp is rarely what you want here. */
function ago(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

/**
 * Past runs, newest first.
 *
 * Parameter columns are the ones that actually differ across the listing: a
 * column every run agrees on cannot explain why they differ.
 */
export function renderHistory(entries: readonly HistoryEntry[], otlpUiBase: string): void {
  if (entries.length === 0) {
    out();
    out(`  ${DIM}No runs recorded yet.${RESET}`);
    out();
    return;
  }

  // Parameters are only comparable within one scenario: `threshold` means
  // something different in each schema, and a mixed listing would column them
  // together as if it did not.
  const oneScenario = new Set(entries.map((e) => e.meta.scenarioId)).size === 1;
  const columns = oneScenario ? varyingParams(entries) : [];
  const widths = columns.map((column) => Math.max(
    column.length,
    ...entries.map((e) => JSON.stringify((e.meta.params as Record<string, unknown>)[column] ?? '').length),
  ));

  out();
  out(`${BOLD}history${RESET}  ${entries.length} runs`);
  out(
    '  ' + 'age'.padEnd(6) + 'scenario'.padEnd(21) +
    columns.map((column, i) => column.padEnd(widths[i]! + 2)).join('') +
    'status'.padEnd(12) + 'evals'.padEnd(8) + 'ms'.padEnd(8) + 'tokens',
  );

  // Forks sit under what they forked. A fork is a run of the same scenario, so
  // flat it reads as a near-duplicate of its parent for no stated reason.
  const row = (entry: HistoryEntry, depth: number): void => {
    const colour = isClean(entry) ? GREEN : RED;
    const params = (entry.meta.params ?? {}) as Record<string, unknown>;
    const label = depth === 0
      ? entry.meta.scenarioId
      : `${'  '.repeat(depth)}└ fork${entry.meta.forkChanges?.length ? '' : ' (no change)'}`;
    out(
      '  ' + ago(entry.meta.startedAt).padEnd(6) +
      label.padEnd(21) +
      columns.map((column, i) => (JSON.stringify(params[column]) ?? '').padEnd(widths[i]! + 2)).join('') +
      `${colour}${(entry.meta.status ?? 'unknown').padEnd(12)}${RESET}` +
      `${entry.passed}/${entry.total}`.padEnd(8) +
      String(entry.meta.durationMs ?? 0).padEnd(8) +
      String(entry.usage.totalTokens),
    );
  };

  const walk = (tree: RunTree, depth: number): void => {
    row(tree.entry, depth);
    for (const fork of tree.forks) walk(fork, depth + 1);
  };

  for (const tree of nestForks(entries)) walk(tree, 0);

  const traced = entries.filter((e) => e.meta.traceId);
  if (traced.length > 0) {
    out();
    out(`  ${DIM}newest trace: ${otlpUiBase}/trace/${traced[0]!.meta.traceId}${RESET}`);
  }
  out(`  ${DIM}${entries[0]!.dir}${RESET}`);
  out();
}

const LEVEL_COLOUR: Record<string, string> = {
  debug: DIM, info: '', warn: YELLOW, error: RED,
};

/** Context minus the keys every line carries, which say nothing by repetition. */
function contextTail(context: Record<string, unknown> | undefined): string {
  if (!context) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(context)) {
    if (key === 'run_id' || key === 'graph_id' || key === 'error') continue;
    parts.push(`${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`);
  }
  return parts.join(' ');
}

/**
 * One run's log lines.
 *
 * Errors are expanded onto their own line: the message is the reason anyone
 * opens this, and burying it in a context blob defeats the purpose.
 */
export function renderLogs(entry: HistoryEntry, lines: readonly RunLogLine[]): void {
  out();
  out(
    `${BOLD}${entry.meta.scenarioId}${RESET} ${DIM}${entry.meta.runId}${RESET}  ` +
    `${entry.meta.status ?? '?'} · ${entry.passed}/${entry.total} · ${entry.meta.durationMs ?? 0}ms`,
  );

  if (lines.length === 0) {
    out(`  ${DIM}No log lines recorded. LOG_LEVEL was probably above them.${RESET}`);
    out();
    return;
  }

  for (const line of lines) {
    const colour = LEVEL_COLOUR[line.level] ?? '';
    const time = line.timestamp.slice(11, 23);
    const tail = contextTail(line.context);
    // Enough of the span id to group lines by the operation they came from,
    // and to find that span in the trace this run links to.
    const span = (line.span_id ?? '').slice(0, 8).padEnd(8);
    out(
      `  ${DIM}${time}${RESET} ${DIM}${span}${RESET} ${colour}${line.level.padEnd(5)}${RESET} ` +
      `${line.event.padEnd(46)} ${DIM}${tail}${RESET}`,
    );

    const error = line.context?.['error'] as { name?: string; message?: string } | undefined;
    if (error?.message) {
      out(`  ${' '.repeat(12)} ${RED}${error.name ?? 'Error'}${RESET}: ${error.message.split('\n')[0]}`);
    }
  }

  out();
  out(`  ${DIM}${lines.length} lines · ${entry.dir}/logs.ndjson${RESET}`);
  out();
}

/** Usage text for a bare or malformed invocation. */
export function renderUsage(): void {
  out(`
${BOLD}cycgraph playground${RESET}

  npm run play                         list scenarios and stack status
  npm run play -- run <id> [--flags]   run a scenario — <id> may be a file: ./graph.ts or bundle.json
  npm run play -- params <id>          show a scenario's parameters
  npm run play -- stack                show stack status only
  npm run play -- sweep <id> --vary <param>=<a,b>   run every combination
  npm run play -- history [id] [--limit n] [--failed]  past runs, newest first
  npm run play -- serve [--port n] [--watch] [--load file]  the dashboard; --watch ticks the improvement watcher, --load adds an ad-hoc scenario
  npm run play -- logs [run] [--level warn] [--grep x]  one run's log lines
  npm run play -- insights [id] [--limit n]  what recorded runs say is wrong
  npm run play -- import <runId>|--all  pull externally recorded runs into the artifact tree
  npm run play -- tune <id> [--prefixes n] [--dry-run] [--max-forks n] [--max-seconds n] [--models a,b] [--samples n] [--validate n] [--prompts n] [--concurrency n] [--no-combine] [--reuse] [--save]
  npm run play -- improve <id> [tune flags] [--repo path]  the whole ladder, gated
  npm run play -- loop <id> [--autonomy propose|trial|apply] [--max-runs n] [--max-minutes n] [--models a,b] [--prompts n]  run, measure, adopt — unattended, stopping at a committed diff
  npm run play -- loop-check [--repo path]  the improve loop end to end, scored
  npm run play -- watch [id] [--min-runs n] [--max-forks n] [--dry-run]  one watcher tick: sense, measure, propose
  npm run play -- proposals [id]       the ledger of measured proposals
  npm run play -- trial|apply|revert <id>  overlay, write to source, or take back
                                        measure knob changes against the evals

${BOLD}stack flags${RESET} (accepted before the subcommand or after it)

  --model <id>       model every agent resolves through (default: qwen2.5:7b)
  --tenant <id>      tenant Postgres-backed runs open against
  --no-postgres      skip Postgres
  --no-jaeger        skip tracing
  --no-servers       skip the A2A and MCP scenario servers
  --no-memory        skip the memory hierarchy and outcome ledger

${BOLD}sweep flags${RESET}

  --vary <param>=<a,b>   an axis to vary; repeat for a cartesian product
  --repeat <n>           run each variant n times, for scenarios that vary
  --allow-spend          permit a sweep on a hosted model
`);
}

/** A fixed temperature as itself, a scheduled one as the range it swept. */
function renderTemperature(range?: { min: number; max: number }): string {
  if (!range) return '-';
  return range.min === range.max ? String(range.min) : `${range.min}–${range.max}`;
}

/**
 * A findings report, ranked as the detectors ranked it.
 *
 * The evidence prints alongside every finding rather than behind a flag: a
 * claim about telemetry that does not show its counts is an assertion, and the
 * whole point of detection being deterministic is that it can be checked.
 */
export function renderInsights(report: InsightsReport): void {
  out();
  out(`${BOLD}insights${RESET}  ${report.runs} run(s), ${report.workflows} scenario(s)`);

  if (report.findings.length === 0) {
    out(`  ${GREEN}nothing found${RESET}`);
    out();
    return;
  }

  out(
    `  ${RED}${report.counts.high} high${RESET} · ` +
    `${YELLOW}${report.counts.medium} medium${RESET} · ` +
    `${DIM}${report.counts.low} low${RESET}`,
  );
  out();

  for (const finding of report.findings) {
    const colour = finding.severity === 'high' ? RED : finding.severity === 'medium' ? YELLOW : DIM;
    out(`  ${colour}${finding.severity.padEnd(6)}${RESET} ${finding.title}`);
    out(`         ${DIM}${finding.detail}${RESET}`);
    out(`         ${DIM}${finding.addresses}${RESET}`);
    const seen = finding.evidence.lastSeen ? ` ${DIM}· last seen ${ago(finding.evidence.lastSeen)}${RESET}` : '';
    out(`         ${DIM}${finding.evidence.sampleRunIds.map((id) => id.slice(0, 8)).join(' ')}${RESET}${seen}`);
    out();
  }
}

/**
 * Where a workflow spends itself, node by node.
 *
 * Deliberately unlike the findings list: no severities, no colour by badness,
 * and every node shown. Nothing here is wrong, so nothing is marked as though
 * it were.
 */
export function renderProfile(profile: WorkflowProfile): void {
  const width = Math.max(8, ...profile.nodes.map((n) => n.nodeId.length));

  out();
  const models = profile.models.length > 0 ? profile.models.join(', ') : 'unknown model';
  out(
    `${BOLD}profile${RESET}  ${profile.workflow}  ${DIM}${profile.runs} run(s) on ${models}, ` +
    `${Math.round(profile.msPerRun)}ms and ${Math.round(profile.tokensPerRun)} tokens per run${RESET}`,
  );
  if (profile.models.length > 1) {
    out(`  ${YELLOW}mixed models${RESET} ${DIM}these numbers pool populations that are not comparable${RESET}`);
  }
  out(
    `  ${'node'.padEnd(width + 2)}${'type'.padEnd(13)}${'time'.padEnd(7)}` +
    `${'ms/run'.padStart(8)}${'ms/visit'.padStart(10)}${'visits'.padStart(8)}${'tok/call'.padStart(10)}${'temp'.padStart(10)}`,
  );

  for (const node of profile.nodes) {
    out(
      `  ${node.nodeId.padEnd(width + 2)}` +
      `${DIM}${node.type.padEnd(13)}${RESET}` +
      `${`${Math.round(node.timeShare * 100)}%`.padEnd(7)}` +
      `${String(Math.round(node.msPerRun)).padStart(8)}` +
      `${String(Math.round(node.msPerVisit)).padStart(10)}` +
      `${node.visitsPerRun.toFixed(1).padStart(8)}` +
      `${(node.tokensPerCall === undefined ? '-' : String(Math.round(node.tokensPerCall))).padStart(10)}` +
      `${renderTemperature(node.temperature).padStart(10)}`,
    );
  }

  // Only the node that dominates, since a lever hint against every row is
  // noise and the top row is where an optimisation starts.
  const top = profile.nodes[0];
  if (top) {
    out();
    out(`  ${DIM}${top.nodeId}: ${describeLever(top)}${RESET}`);
  }
  out();
}

/**
 * What a tuning pass measured.
 *
 * Rejections print alongside proposals rather than being filtered out. "We
 * tried three values and none was better" is the usual result and is worth
 * reading: a sweep that silently produces nothing is indistinguishable from
 * one that never ran.
 */
export function renderTune(outcome: TuneOutcome): void {
  out();
  out(
    `${BOLD}tune${RESET}  ${outcome.workflow}  ` +
    `${DIM}${outcome.sweeps.length} knob(s), ${outcome.forks} fork(s), ` +
    `${outcome.baseRunIds.length} base run(s)${RESET}`,
  );

  if (outcome.promptGeneration) {
    out(`  ${DIM}prompts: ${outcome.promptGeneration}${RESET}`);
  }
  if (outcome.skipped) {
    out(`  ${DIM}${outcome.skipped}${RESET}`);
    out();
    return;
  }

  for (const verdict of outcome.verdicts) {
    const measured = verdict.kind === 'proposal' ? verdict.proposal.outcomes : verdict.rejection.outcomes;
    const validation = verdict.kind === 'proposal'
      ? outcome.validations?.[verdict.proposal.sweepId]
      : undefined;

    if (verdict.kind !== 'proposal') {
      out(`  ${DIM}keep   ${verdict.rejection.nodeId}.${verdict.rejection.knob}: ${verdict.rejection.reason}${RESET}`);
    } else if (validation && validation.kind !== 'proposal') {
      // Won the sweep, failed the held-out confirmation: the honest verdict
      // is keep, with both halves shown.
      out(`  ${YELLOW}keep${RESET}   ${describeProposal(verdict.proposal)}`);
      out(`         ${YELLOW}not confirmed${RESET} ${DIM}${validation.rejection.reason}${RESET}`);
    } else {
      out(`  ${GREEN}apply${RESET}  ${describeProposal(verdict.proposal)}`);
      if (validation?.kind === 'proposal') {
        out(`         ${GREEN}confirmed${RESET} ${DIM}on ${validation.proposal.measuredOn.length} held-out base run(s): ${percentPair(validation.proposal)}${RESET}`);
      }
      // A prompt proposal's deliverable is the text itself: everything else
      // on the line is evidence that this is worth pasting into the agent.
      const rewrite = verdict.proposal.knob === 'prompt'
        ? verdict.proposal.change.find((c) => c.kind === 'prompt')
        : undefined;
      if (rewrite && 'system_prompt' in rewrite) {
        out(`         ${DIM}winning prompt:${RESET}`);
        for (const line of rewrite.system_prompt.split('\n')) {
          out(`         ${DIM}  ${line}${RESET}`);
        }
      }
    }
    for (const line of summariseOutcomes(measured)) {
      out(`         ${DIM}${line}${RESET}`);
    }
    if (validation) {
      const confirmed = validation.kind === 'proposal' ? validation.proposal.outcomes : validation.rejection.outcomes;
      for (const line of summariseOutcomes(confirmed)) {
        out(`         ${DIM}held-out: ${line}${RESET}`);
      }
    }
    out();
  }

  if (outcome.combination) {
    if ('skipped' in outcome.combination) {
      out(`  ${DIM}combined: ${outcome.combination.skipped}${RESET}`);
    } else {
      const { constituents, verdict } = outcome.combination;
      const named = constituents.map((c) => `${c.nodeId}.${c.knob}`).join(' + ');
      const colour = verdict.decision === 'combine' ? GREEN : YELLOW;
      const label = verdict.decision === 'combine' ? 'apply together' : verdict.decision;
      out(`  ${colour}${label}${RESET}  ${named}`);
      out(`         ${DIM}${verdict.reason}${RESET}`);
      for (const line of summariseOutcomes(verdict.outcomes)) {
        out(`         ${DIM}${line}${RESET}`);
      }
    }
    out();
  }
}

/** What a confirmation held onto, in the same units the proposal claimed. */
function percentPair(proposal: { computeDelta: number; tokenDelta: number }): string {
  const sign = (f: number) => `${Math.round(f * 100) >= 0 ? '−' : '+'}${Math.abs(Math.round(f * 100))}%`;
  return `${sign(proposal.computeDelta)} execution time, ${sign(proposal.tokenDelta)} tokens`;
}

/** One candidate's measurement, terse enough to sit under a verdict. */
function renderOutcomeLine(outcome: VariantOutcome): string {
  if (outcome.error) return `${outcome.name}  errored: ${firstMeaningfulLine(outcome.error)}`;

  const held = outcome.assertionsHeld ? 'evals ok' : `evals failed: ${outcome.failed.join(', ') || 'none checked'}`;
  const reused = outcome.reused ? '  (reused)' : '';
  return `${outcome.name}  ${Math.round(outcome.computeMs)}ms  ${outcome.tokens} tok  ${held}${reused}`;
}

/**
 * One line per arm. A sampled sweep runs each arm several times, and a page
 * of near-identical draw lines hides the rate that decided the verdict, so
 * repeated arms collapse to their counts.
 */
function summariseOutcomes(outcomes: readonly VariantOutcome[]): string[] {
  const byName = new Map<string, VariantOutcome[]>();
  for (const outcome of outcomes) {
    const group = byName.get(outcome.name) ?? [];
    group.push(outcome);
    byName.set(outcome.name, group);
  }

  return [...byName].map(([name, group]) => {
    if (group.length === 1) return renderOutcomeLine(group[0]!);

    const passed = group.filter((o) => o.assertionsHeld && !o.error).length;
    const errored = group.filter((o) => o.error).length;
    const reused = group.filter((o) => o.reused).length;
    const meanMs = group.reduce((sum, o) => sum + o.computeMs, 0) / group.length;
    const meanTok = group.reduce((sum, o) => sum + o.tokens, 0) / group.length;
    return `${name}  passed ${passed}/${group.length}`
      + (errored > 0 ? ` (${errored} errored)` : '')
      + `  ~${Math.round(meanMs)}ms  ~${Math.round(meanTok)} tok`
      + (reused > 0 ? `  (${reused} reused)` : '');
  });
}

/**
 * What a tuning pass is about to spend, before it spends it.
 *
 * Time leads and dollars follow, which is the opposite of what a cost report
 * usually does. Every model in this harness is local and priced at zero, so a
 * dollar figure alone reads as "this is free" for a pass that is about to run
 * for a minute.
 */
export function renderTuneEstimate(estimates: readonly SweepEstimate[]): void {
  const forks = estimates.reduce((sum, e) => sum + e.forks, 0);
  const known = estimates.filter((e) => e.tailMs !== undefined);
  const totalMs = known.reduce((sum, e) => sum + (e.tailMs ?? 0), 0);
  const costUsd = estimates.reduce((sum, e) => sum + e.costUsd, 0);

  const time = known.length === estimates.length
    ? `~${Math.round(totalMs / 1000)}s`
    : `~${Math.round(totalMs / 1000)}s of ${known.length}/${estimates.length} sweeps`;

  out();
  out(`${BOLD}estimate${RESET}  ${forks} fork(s), ${time}, $${costUsd.toFixed(4)}`);

  for (const estimate of estimates) {
    const predicted = estimate.tailMs === undefined
      ? 'no timing recorded to predict from'
      : `~${Math.round(estimate.tailMs / 1000)}s over ${estimate.forks} fork(s)`;
    out(`  ${estimate.nodeId}.${estimate.knob}  ${DIM}${predicted}${RESET}`);

    for (const line of estimate.lines) {
      out(`    ${DIM}${line.trim()}${RESET}`);
    }
    if (estimate.unavailable) {
      out(`    ${YELLOW}not estimable${RESET} ${DIM}${firstMeaningfulLine(estimate.unavailable)}${RESET}`);
    }
  }
  out();
}

/**
 * The ledger, one line per proposal.
 *
 * Status leads because it is the decision; the evidence follows because a
 * decision without its evidence is just a preference.
 */
export function renderProposals(records: readonly ProposalRecord[]): void {
  out();
  if (records.length === 0) {
    out(`  ${DIM}no proposals saved. \`npm run play -- tune <id> --save\` writes winners here.${RESET}`);
    out();
    return;
  }

  for (const record of records) {
    const colour = record.status === 'applied' ? GREEN
      : record.status === 'pr' || record.status === 'trial' ? YELLOW : DIM;
    out(`  ${colour}${record.status.padEnd(9)}${RESET}${record.id}`);
    out(`           ${DIM}${record.nodeId}.${record.knob}: ${String(record.from)} → ${String(record.to)}`
      + `  ${percentPair(record)} on ${record.model}${RESET}`);
    if (record.validation) {
      out(`           ${record.validation.confirmed ? GREEN : YELLOW}${record.validation.confirmed ? 'confirmed' : 'not confirmed'}${RESET} ${DIM}${record.validation.detail}${RESET}`);
    }
    if (record.combination) {
      out(`           ${DIM}combined: ${record.combination}${RESET}`);
    }
    if (record.status === 'pr' && record.branch) {
      out(`           ${DIM}awaiting review on ${record.branch}${RESET}`);
    }
  }
  out();
}
