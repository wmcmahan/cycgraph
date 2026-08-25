/**
 * Cross-run log queries: the Logs page's read side
 *
 * Merges every run's structured logs and node lifecycle events into one
 * filterable stream, newest first. Reads the same artifacts the CLI's
 * `logs` and `history` commands read — this module only merges, filters,
 * and pages, so a row here is exactly a line on disk.
 *
 * Scale honesty: this scans files per query. A local corpus of hundreds of
 * runs answers in tens of milliseconds, which is the whole deployment
 * story of a loopback dashboard; nothing here pretends to be an index.
 *
 * @module server/logs
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadHistory, loadRunLogs } from '../run/history.js';
import type { HistoryEntry } from '../run/history.js';

/** One row of the merged stream. */
export interface LogRow {
  at: string;
  runId: string;
  scenarioId: string;
  /** A structured engine log line, or a node lifecycle event. */
  kind: 'log' | 'event';
  /** Log level, for `log` rows. */
  level?: string;
  /** The log's event name, or the stream event type. */
  event: string;
  node?: string;
  model?: string;
  /** How long the thing this line reports took. */
  durationMs?: number;
  /** Tool or agent the line is about, when it names one. */
  tool?: string;
  agent?: string;
  /** Whatever context the columns above did not claim, as `key=value`. */
  detail: string;
  /** The full parsed line, for the drawer. */
  raw: unknown;
}

/** Filters the Logs page can apply. */
export interface LogQuery {
  workflow?: string;
  runId?: string;
  level?: string;
  node?: string;
  status?: string;
  /** Substring match over the event name and its named fields. */
  q?: string;
  /** Which row kinds to include. Both when absent. */
  kinds?: Array<'log' | 'event'>;
  /** Only rows strictly older than this ISO timestamp (the paging cursor). */
  before?: string;
  limit?: number;
}

const DEFAULT_LIMIT = 200;

/** How many runs one query is willing to scan. */
const RUN_SCAN_LIMIT = 150;

/** Levels ordered so a level filter means "this or worse". */
const LEVELS = ['debug', 'info', 'warn', 'error'];

/** Whether one row passes the query's row-level filters. Pure. */
export function matchesQuery(row: LogRow, query: LogQuery): boolean {
  if (query.kinds && !query.kinds.includes(row.kind)) return false;
  if (query.runId && row.runId !== query.runId) return false;
  if (query.node && row.node !== query.node) return false;
  if (query.before && row.at >= query.before) return false;
  if (query.level && row.kind === 'log') {
    const floor = LEVELS.indexOf(query.level);
    const level = LEVELS.indexOf(row.level ?? 'info');
    if (floor >= 0 && level < floor) return false;
  }
  if (query.level && row.kind === 'event') return false;
  if (query.q) {
    const needle = query.q.toLowerCase();
    const haystack = [row.event, row.detail, row.node, row.tool, row.agent, row.model]
      .filter(Boolean).join(' ').toLowerCase();
    if (!haystack.includes(needle)) {
      return false;
    }
  }
  return true;
}

/**
 * Context keys that became columns of their own, plus the identifiers the
 * row already carries. What is left over is what `detail` renders, so a
 * line's distinctive facts are not buried behind four generic pairs.
 */
const CLAIMED_KEYS = new Set([
  'run_id', 'graph_id', 'node_id', 'model', 'duration_ms', 'durationMs',
  'tool_name', 'tool_id', 'agent_id', 'trace_id', 'span_id', 'tenant_id',
]);

function compactContext(context: Record<string, unknown> | undefined): string {
  if (!context) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(context)) {
    if (CLAIMED_KEYS.has(key)) continue;
    if (value === null || typeof value === 'object') continue;
    parts.push(`${key}=${String(value)}`);
    if (parts.length >= 4) break;
  }
  return parts.join(' ');
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

async function rowsForRun(entry: HistoryEntry): Promise<LogRow[]> {
  const rows: LogRow[] = [];
  const base = { runId: entry.meta.runId, scenarioId: entry.meta.scenarioId };

  for (const line of await loadRunLogs(entry.dir)) {
    const context = line.context ?? {};
    rows.push({
      ...base,
      at: line.timestamp,
      kind: 'log',
      level: line.level,
      event: line.event,
      ...(stringOf(context['node_id']) ? { node: stringOf(context['node_id'])! } : {}),
      ...(stringOf(context['model']) ? { model: stringOf(context['model'])! } : {}),
      ...(numberOf(context['duration_ms']) !== undefined ? { durationMs: numberOf(context['duration_ms'])! } : {}),
      ...((stringOf(context['tool_name']) ?? stringOf(context['tool_id']))
        ? { tool: (stringOf(context['tool_name']) ?? stringOf(context['tool_id']))! }
        : {}),
      ...(stringOf(context['agent_id']) ? { agent: stringOf(context['agent_id'])! } : {}),
      detail: compactContext(line.context),
      raw: line,
    });
  }

  let rawEvents: string;
  try {
    rawEvents = await readFile(join(entry.dir, 'events.ndjson'), 'utf8');
  } catch {
    rawEvents = '';
  }
  for (const line of rawEvents.split('\n')) {
    if (!line.trim()) continue;
    let event: {
      type?: string; node_id?: string; timestamp?: number; duration_ms?: number;
      node_type?: string; tool_name?: string; agent_id?: string; model?: string;
      error?: string; waiting_for?: string;
    };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event.type) continue;
    rows.push({
      ...base,
      at: new Date(event.timestamp ?? 0).toISOString(),
      kind: 'event',
      event: event.type,
      ...(event.node_id ? { node: event.node_id } : {}),
      ...(event.model ? { model: event.model } : {}),
      ...(event.duration_ms !== undefined ? { durationMs: event.duration_ms } : {}),
      ...(event.tool_name ? { tool: event.tool_name } : {}),
      ...(event.agent_id ? { agent: event.agent_id } : {}),
      // A lifecycle event's distinctive fact is why it ended, not its shape.
      detail: event.error ?? event.waiting_for ?? event.node_type ?? '',
      raw: event,
    });
  }

  return rows;
}

/** Run the query. Rows come back newest first. */
export async function queryLogs(
  artifactRoot: string,
  query: LogQuery,
): Promise<{ rows: LogRow[]; runsScanned: number }> {
  const limit = query.limit ?? DEFAULT_LIMIT;
  const entries = await loadHistory(artifactRoot, {
    ...(query.workflow ? { scenarioId: query.workflow } : {}),
    limit: RUN_SCAN_LIMIT,
  });
  const eligible = entries.filter((entry) =>
    (!query.runId || entry.meta.runId === query.runId)
    && (!query.status || entry.meta.status === query.status));

  const rows: LogRow[] = [];
  let scanned = 0;
  // Newest runs first; stop scanning once older runs cannot contribute.
  for (const entry of eligible) {
    if (rows.length >= limit && rows[rows.length - 1]!.at > (entry.meta.startedAt ?? '')) break;
    scanned++;
    for (const row of await rowsForRun(entry)) {
      if (matchesQuery(row, query)) rows.push(row);
    }
  }

  rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return { rows: rows.slice(0, limit), runsScanned: scanned };
}
