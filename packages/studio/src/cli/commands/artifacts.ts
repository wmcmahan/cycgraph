/**
 * The artifact readers: `logs`, `history`, and `insights` work from the
 * artifact tree alone — no stack, no model, no cost.
 *
 * @module cli/commands/artifacts
 */

import { findRun, loadHistory, loadRunLogs } from '../../run/history.js';
import { inspectRuns, profileWorkflow } from '../../run/insights.js';
import { fail, jaegerUiBase, type CliContext } from '../context.js';
import { renderHistory, renderInsights, renderLogs, renderProfile } from '../render.js';

export async function logsCommand(ctx: CliContext): Promise<void> {
  const { args, config } = ctx;
  const target = args[0] && !args[0].startsWith('--') ? args[0] : undefined;
  const entry = await findRun(config.artifactRoot, target);
  if (!entry) {
    fail(target ? `No recorded run matching "${target}".` : 'No runs recorded yet.');
  }

  const levelAt = args.indexOf('--level');
  const minLevel = levelAt >= 0 ? args[levelAt + 1] ?? 'debug' : 'debug';
  const grepAt = args.indexOf('--grep');
  const needle = grepAt >= 0 ? args[grepAt + 1]?.toLowerCase() : undefined;

  const order = ['debug', 'info', 'warn', 'error'];
  const floor = Math.max(0, order.indexOf(minLevel));

  const lines = (await loadRunLogs(entry.dir)).filter((line) => {
    if (order.indexOf(line.level) < floor) return false;
    if (!needle) return true;
    return JSON.stringify(line).toLowerCase().includes(needle);
  });

  renderLogs(entry, lines);
}

export async function historyCommand(ctx: CliContext): Promise<void> {
  const { args, config } = ctx;
  const scenarioArg = args[0] && !args[0].startsWith('--') ? args[0] : undefined;
  const scenarioId = scenarioArg ? await ctx.resolveWorkflowId(scenarioArg) : undefined;

  const limitAt = args.indexOf('--limit');
  const entries = await loadHistory(config.artifactRoot, {
    ...(scenarioId ? { scenarioId } : {}),
    ...(limitAt >= 0 ? { limit: Math.max(1, Number(args[limitAt + 1] ?? 20)) } : {}),
    failedOnly: args.includes('--failed'),
  });

  renderHistory(entries, jaegerUiBase(config.endpoints.otlp));
}

export async function insightsCommand(ctx: CliContext): Promise<void> {
  const { args, config } = ctx;
  const scenarioArg = args[0] && !args[0].startsWith('--') ? args[0] : undefined;
  const scenarioId = scenarioArg ? await ctx.resolveWorkflowId(scenarioArg) : undefined;

  const limitAt = args.indexOf('--limit');
  const report = await inspectRuns(config.artifactRoot, {
    ...(scenarioId ? { scenarioId } : {}),
    ...(limitAt >= 0 ? { limit: Math.max(1, Number(args[limitAt + 1] ?? 500)) } : {}),
  });

  renderInsights(report);

  // Scoped to one workflow, the question shifts from what is wrong to
  // where the work goes, which is a different report rather than a
  // ranking of the same one.
  if (scenarioId) {
    const profile = await profileWorkflow(config.artifactRoot, scenarioId);
    if (profile) renderProfile(profile);
  }
}
