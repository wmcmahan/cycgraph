/**
 * Dashboard API
 *
 * The same registry, schema introspection, history, and run driver the CLI
 * uses, exposed over HTTP. Nothing here knows anything the CLI does not: if a
 * scenario is runnable from a terminal it is runnable from the page, because
 * both read the one Zod schema.
 *
 * Built on `node:http` rather than a framework. Five routes and one SSE stream
 * do not justify a dependency tree in a tool that only ever binds loopback.
 *
 * @module server/api
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Change, StreamEvent } from '@cycgraph/orchestrator';
import { describeParams } from '../params/introspect.js';
import { executeScenario } from '../run/execute.js';
import { findRun, loadHistory, loadRunLogs } from '../run/history.js';
import { collectMetrics } from '@cycgraph/orchestrator';
import { availability, catalogOf, type Catalog } from '../scenarios/catalog.js';
import { forkPointsForRun, forkRecordedRun } from '../run/fork.js';
import { graphsForGraph, type Graph, type GraphNode } from '@cycgraph/orchestrator';
import { answerPrompt, askHuman, cancel } from './prompts.js';
import { unmetRequirements, type Stack, type StackConfig } from '../stack/index.js';
import { listProposals, saveProposals, setProposalStatus, writeEpoch } from '../improve/proposals.js';
import { improveTuneTargetFor } from '../improve/improve.js';
import { importRun } from '../run/import.js';
import { change, fork, forkPoints } from '@cycgraph/orchestrator';
import type { AgentRegistry } from '@cycgraph/orchestrator';
import { tuneWorkflow } from '../improve/tune.js';
import { applyProposal, resolveApplyRepo } from '../improve/apply.js';
import { extname, resolve, resolve as resolvePath } from 'node:path';
import type { Watcher } from './watcher.js';
import type { Bus } from './bus.js';
import type { LoopController } from './loop.js';
import { queryLogs } from './logs.js';
import { loadTicks, workflowReadiness } from '../improve/watch.js';

// The exported Next app: dist/server/app in the built package, ui/out when
// running from source. Absent both, the page says to build.
const APP_DIRS = [
  fileURLToPath(new URL('./app/', import.meta.url)),
  fileURLToPath(new URL('../../ui/out/', import.meta.url)),
];

const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

async function serveApp(res: ServerResponse, urlPath: string): Promise<boolean> {
  // Resolve inside an app dir only; a traversal falls out of the prefix.
  const clean = decodeURIComponent(urlPath.split('?')[0]!);
  const candidates = clean.endsWith('/')
    ? [`${clean}index.html`]
    : extname(clean) ? [clean] : [`${clean}/index.html`, `${clean}.html`];
  for (const dir of APP_DIRS) {
    for (const candidate of candidates) {
      const abs = resolvePath(dir, `.${candidate}`);
      if (!abs.startsWith(dir)) continue;
      try {
        const file = await readFile(abs);
        res.writeHead(200, {
          'content-type': STATIC_TYPES[extname(abs)] ?? 'application/octet-stream',
          'cache-control': clean.startsWith('/_next/') ? 'public, max-age=31536000, immutable' : 'no-store',
        });
        res.end(file);
        return true;
      } catch {
        continue;
      }
    }
  }
  return false;
}

/** JSON, with the caching disabled that a dashboard reading live files needs. */

/**
 * The shared agent registry behind the stack's persistence, when there is
 * one. External runs register their agents in the database; resolving them
 * is what lets their tails re-execute here. In-memory stacks have no shared
 * registry, and a fork without one still works for tool-only tails.
 */
async function dbAgentRegistry(stack: Stack): Promise<AgentRegistry | undefined> {
  if (!stack.config.postgres) return undefined;
  try {
    const { DrizzleAgentRegistry } = await import('@cycgraph/orchestrator-postgres');
    return new DrizzleAgentRegistry();
  } catch {
    return undefined;
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

/** The Jaeger UI origin implied by the OTLP endpoint — different ports, same host. */
function jaegerBase(otlp: string): string {
  try {
    const url = new URL(otlp);
    return `${url.protocol}//${url.hostname}:16686`;
  } catch {
    return 'http://localhost:16686';
  }
}

/**
 * Handle one request.
 *
 * The stack belongs to the server rather than to the request. Tracing and the
 * database pool are process-global, so building and closing a stack per
 * request would shut down the tracer provider between the page load and the
 * run it starts, and OpenTelemetry will not re-register a global provider once
 * one exists — every later span would be recorded against a dead exporter and
 * never reach Jaeger.
 *
 * @returns `true` when the request was served, so the caller can 404 the rest.
 */
export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  config: StackConfig,
  stack: Stack,
  watcher?: Watcher,
  bus?: Bus,
  catalog: Catalog = catalogOf([]),
  loop?: LoopController,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const findInCatalog = (id: string) =>
    id === 'improve' ? improveTuneTargetFor(catalog) : catalog.find(id);

  if (!path.startsWith('/api/') && req.method === 'GET') {
    if (await serveApp(res, path)) return true;
    if (path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<pre>The studio UI is not built. Run `npm run build` in packages/studio.</pre>');
      return true;
    }
  }

  // The merged, filterable log stream across every recorded run.
  if (path === '/api/logs') {
    const kinds = url.searchParams.get('kinds');
    const result = await queryLogs(config.artifactRoot, {
      ...(url.searchParams.get('workflow') ? { workflow: url.searchParams.get('workflow')! } : {}),
      ...(url.searchParams.get('run') ? { runId: url.searchParams.get('run')! } : {}),
      ...(url.searchParams.get('level') ? { level: url.searchParams.get('level')! } : {}),
      ...(url.searchParams.get('node') ? { node: url.searchParams.get('node')! } : {}),
      ...(url.searchParams.get('status') ? { status: url.searchParams.get('status')! } : {}),
      ...(url.searchParams.get('q') ? { q: url.searchParams.get('q')! } : {}),
      ...(url.searchParams.get('before') ? { before: url.searchParams.get('before')! } : {}),
      ...(kinds ? { kinds: kinds.split(',') as Array<'log' | 'event'> } : {}),
      limit: Number(url.searchParams.get('limit') ?? 200),
    });
    json(res, 200, result);
    return true;
  }

  // The live feed: everything this dashboard drives, one SSE stream,
  // opened with the ring buffer's recent past so mid-run pages have
  // context.
  if (path === '/api/tail') {
    if (!bus) {
      json(res, 503, { error: 'this dashboard has no event bus' });
      return true;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    const send = (event: unknown): void => {
      res.write(`event: tail\ndata: ${JSON.stringify(event)}\n\n`);
    };
    for (const event of bus.recent()) send(event);
    const unsubscribe = bus.subscribe(send);
    req.on('close', unsubscribe);
    return true;
  }

  // Prometheus text, for pointing a real scrape at a real run rather than
  // trusting that instruments nothing reads are correct.
  if (path === '/metrics') {
    const collected = await collectMetrics();
    if (!collected) {
      json(res, 503, { error: 'Metrics are disabled. Set METRICS_ENABLED=true.' });
      return true;
    }
    res.writeHead(200, { 'content-type': collected.contentType, 'cache-control': 'no-store' });
    res.end(collected.metrics);
    return true;
  }

  if (path === '/api/scenarios') {
    // What the server can actually serve, probed once at startup. Infra
    // started after it will not appear until `play serve` is restarted, which
    // is the honest report: a scenario listed runnable here has resources
    // already bound to it.
    const body = availability(stack, catalog).map(({ scenario, runnable, missing }) => ({
      id: scenario.id,
      title: scenario.title,
      covers: scenario.covers,
      requires: scenario.requires,
      runnable,
      missing,
      params: describeParams(scenario.params),
    }));
    const stackInfo = {
      model: config.model,
      tenant: config.tenant,
      available: [...stack.available],
      gaps: stack.gaps.map((gap) => ({ feature: gap.feature, reason: gap.reason })),
    };

    json(res, 200, { scenarios: body, stack: stackInfo, jaegerBase: jaegerBase(config.endpoints.otlp) });
    return true;
  }

  if (path === '/api/history') {
    const scenarioId = url.searchParams.get('scenario') ?? undefined;
    const limit = Number(url.searchParams.get('limit') ?? 40);
    const entries = await loadHistory(config.artifactRoot, {
      ...(scenarioId ? { scenarioId } : {}),
      limit,
      failedOnly: url.searchParams.get('failed') === 'true',
    });
    json(res, 200, {
      runs: entries.map((entry) => ({
        dir: entry.dir,
        scenarioId: entry.meta.scenarioId,
        runId: entry.meta.runId,
        params: entry.meta.params,
        status: entry.meta.status,
        startedAt: entry.meta.startedAt,
        durationMs: entry.meta.durationMs,
        traceId: entry.meta.traceId,
        tokens: entry.usage.totalTokens,
        costUsd: entry.usage.totalCostUsd,
        passed: entry.passed,
        total: entry.total,
        evals: entry.evals,
        // Lineage, so the page can nest a fork under what it forked rather
        // than listing it as a near-duplicate of its parent.
        ...(entry.meta.parentRunId ? { parentRunId: entry.meta.parentRunId } : {}),
        ...(entry.meta.forkSequenceId !== undefined
          ? { forkSequenceId: entry.meta.forkSequenceId } : {}),
        ...(entry.meta.forkChanges ? { forkChanges: entry.meta.forkChanges } : {}),
      })),
      jaegerBase: jaegerBase(config.endpoints.otlp),
    });
    return true;
  }

  // `/api/runs/<runId>` — everything one run recorded, including its logs.
  const runMatch = /^\/api\/runs\/([^/]+)$/.exec(path);
  if (runMatch) {
    const entry = await findRun(config.artifactRoot, decodeURIComponent(runMatch[1]!));
    if (!entry) {
      json(res, 404, { error: 'No such run' });
      return true;
    }
    json(res, 200, {
      scenarioId: entry.meta.scenarioId,
      runId: entry.meta.runId,
      params: entry.meta.params,
      status: entry.meta.status,
      durationMs: entry.meta.durationMs,
      traceId: entry.meta.traceId,
      usage: entry.usage,
      evals: entry.evals,
      logs: await loadRunLogs(entry.dir),
      dir: entry.dir,
    });
    return true;
  }

  if (path === '/api/run' && req.method === 'POST') {
    const body = (await readBody(req)) as {
      scenario?: string;
      params?: Record<string, unknown>;
      goal?: string;
    };
    const scenario = body.scenario ? findInCatalog(body.scenario) : undefined;
    if (!scenario) {
      json(res, 404, { error: `No scenario named "${body.scenario ?? ''}"` });
      return true;
    }

    // Server-sent events: a run is a stream of node lifecycle, and the page
    // should show it unfolding rather than a spinner and a verdict.
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    const send = (event: string, data: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    watcher?.noteRunStarted();
    try {
      const missing = unmetRequirements(stack, scenario.requires);
      if (missing.length > 0) {
        send('error', { message: `${scenario.id} needs ${missing.join(', ')}` });
        return true;
      }

      const params = scenario.params.parse(body.params ?? {});

      // The run id is not known until executeScenario mints it, but the page
      // needs it to answer a gate. Every stream event carries it, so the first
      // one settles this and the pause event repeats it.
      let runId = '';

      send('start', { scenario: scenario.id, params });

      // A closed tab must not hold the run, its stack, and its Postgres
      // connection until the abandonment timer fires.
      req.on('close', () => cancel(runId, 'the dashboard disconnected'));

      const outcome = await executeScenario(scenario, params, stack, {
        onProgress: (event: StreamEvent) => {
          if ('run_id' in event && typeof event.run_id === 'string') runId = event.run_id;
          send('event', event);
          bus?.publish({ kind: 'run', runId, scenarioId: scenario.id, data: event });
        },
        // A gate becomes a question on the page rather than an approval nobody
        // gave. `hitl`, not `fallbackHitl`: every gated scenario scripts an
        // answer so it can be swept unattended, and the page would otherwise
        // never be asked anything.
        hitl: (question) =>
          askHuman(runId, question, (q) => send('pause', { runId, question: q })),
        ...(body.goal?.trim() ? { goal: body.goal.trim() } : {}),
      });

      send('done', {
        runId: outcome.runId,
        dir: outcome.dir,
        status: outcome.status,
        durationMs: outcome.durationMs,
        usage: outcome.usage,
        evals: outcome.evals,
        taint: Object.keys(outcome.finalState?.taint_registry ?? {}),
        // What the workflow actually produced. Without it the page reports
        // whether a run passed and never what it said.
        goal: outcome.finalState?.goal,
        memory: outcome.finalState?.memory ?? {},
        visited: outcome.finalState?.visited_nodes ?? [],
      });
    } catch (err) {
      // A Zod failure is the common case once a form is involved, and its
      // `message` is a JSON blob. Send the issues so the page can name the
      // field that was wrong.
      const issues = (err as { issues?: Array<{ path?: unknown[]; message?: string }> }).issues;
      send('error', Array.isArray(issues)
        ? {
          message: 'invalid parameters',
          issues: issues.map((issue) => ({
            path: (issue.path ?? []).join('.'),
            message: issue.message ?? 'invalid',
          })),
        }
        : { message: err instanceof Error ? err.message : String(err) });
    } finally {
      watcher?.noteRunFinished();
      res.end();
    }
    return true;
  }

  // `/api/runs/<runId>/fork-points` — where this run can be forked.
  const pointsMatch = /^\/api\/runs\/([^/]+)\/fork-points$/.exec(path);
  if (pointsMatch) {
    const runId = decodeURIComponent(pointsMatch[1]!);
    const scenarioId = url.searchParams.get('scenario');
    const scenario = scenarioId ? findInCatalog(scenarioId) : undefined;
    if (!scenario) {
      json(res, 400, { error: 'a scenario query parameter is required' });
      return true;
    }
    const params = scenario.params.parse(
      JSON.parse(url.searchParams.get('params') ?? '{}') as Record<string, unknown>,
    );
    const points = await forkPointsForRun(scenario, params, stack, runId);
    // A run recorded by an earlier process is only reachable when the event
    // log is durable, so an empty list is a fact about this stack rather than
    // about the run.
    json(res, 200, { runId, points, durable: stack.config.postgres });
    return true;
  }

  if (path === '/api/fork' && req.method === 'POST') {
    const body = (await readBody(req)) as {
      scenario?: string;
      params?: Record<string, unknown>;
      baseRunId?: string;
      at?: { sequence?: number; beforeNode?: string; afterNode?: string } | 'start' | 'failure';
      change?: Change[];
      memoize?: boolean;
      /** Node ids whose real side effects the operator accepts. */
      allow?: string[];
    };

    const scenario = body.scenario ? findInCatalog(body.scenario) : undefined;
    if (!scenario || !body.baseRunId) {
      json(res, 400, { error: 'scenario and baseRunId are required' });
      return true;
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    const send = (event: string, data: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // The variant's own id, minted inside fork(). Until the first node
    // reports, a gate would have nothing to answer against, so the pause
    // carries the BASE id and the page answers under that.
    const promptKey = `fork:${body.baseRunId}`;
    req.on('close', () => cancel(promptKey, 'the dashboard disconnected'));

    watcher?.noteRunStarted();
    try {
      send('start', { scenario: scenario.id, baseRunId: body.baseRunId });

      const params = scenario.params.parse(body.params ?? {});
      const outcome = await forkRecordedRun(scenario, params, stack, body.baseRunId, {
        ...(body.at ? { at: body.at as never } : {}),
        ...(body.change?.length ? { change: body.change } : {}),
        ...(body.memoize ? { memoize: true } : {}),
        ...(body.allow?.length ? { allow: body.allow } : {}),
        onNode: (nodeId, phase) => {
          send('node', { nodeId, phase });
          bus?.publish({
            kind: 'fork',
            runId: body.baseRunId!,
            scenarioId: scenario.id,
            data: { message: `${nodeId} ${phase}` },
          });
        },
        hitl: (question) =>
          askHuman(promptKey, question, (q) => send('pause', { runId: promptKey, question: q })),
      });

      send('done', outcome);
    } catch (err) {
      send('error', { message: err instanceof Error ? err.message : String(err) });
    } finally {
      watcher?.noteRunFinished();
      res.end();
    }
    return true;
  }

  // The wire topology a scenario builds, lean enough to draw: nodes with
  // their composition references (subgraph child, map worker, supervised
  // team), edges with their conditions, and every embedded child graph.
  if (path === '/api/graph') {
    const scenarioId = url.searchParams.get('scenario');
    const scenario = scenarioId ? findInCatalog(scenarioId) : undefined;
    if (!scenario) {
      json(res, 400, { error: 'a scenario query parameter is required' });
      return true;
    }
    const params = scenario.params.parse(
      JSON.parse(url.searchParams.get('params') ?? '{}') as Record<string, unknown>,
    );
    const built = await scenario.build(params as never, stack);

    const lean = (graph: Graph) => ({
      id: graph.id,
      name: graph.name,
      startNode: graph.start_node,
      endNodes: graph.end_nodes,
      nodes: graph.nodes.map((node: GraphNode) => ({
        id: node.id,
        type: node.type,
        ...(node.subgraph_config ? { childId: node.subgraph_config.subgraph_id } : {}),
        ...(node.map_reduce_config ? { worker: node.map_reduce_config.worker_node_id } : {}),
        ...(node.supervisor_config ? { managed: node.supervisor_config.managed_nodes } : {}),
      })),
      edges: graph.edges.map((edge) => ({
        source: edge.source,
        target: edge.target,
        ...(edge.condition.type === 'conditional' && edge.condition.condition
          ? { label: edge.condition.condition } : {}),
      })),
    });

    const children: Record<string, unknown> = {};
    const walk = (graph: Graph): void => {
      for (const child of graphsForGraph(graph)) {
        if (children[child.id]) continue;
        children[child.id] = lean(child);
        walk(child);
      }
    };
    walk(built.graph);

    json(res, 200, { graph: lean(built.graph), children });
    return true;
  }

  // The watcher's state plus the proposal ledger: what the improvement loop
  // has concluded and what it is waiting on a human for.
  if (path === '/api/watch') {
    const proposals = await listProposals(config.artifactRoot);
    json(res, 200, {
      watcher: watcher ? watcher.snapshot() : null,
      proposals: proposals.map((record) => ({
        id: record.id,
        workflow: record.workflow,
        nodeId: record.nodeId,
        knob: record.knob,
        from: record.from,
        to: record.to,
        status: record.status,
        objective: record.objective,
        computeDelta: record.computeDelta,
        tokenDelta: record.tokenDelta,
        model: record.model,
        savedAt: record.savedAt,
        statusChangedAt: record.statusChangedAt,
        measuredOn: record.measuredOn,
        // `from`/`to` are variant labels, not values: a reviewer cannot see
        // what a proposal would do without the change itself.
        change: record.change,
        // The file an apply would edit. Reviewing a change to source without
        // being told which source is reviewing half of it.
        ...(catalog.find(record.workflow)?.sourcePath
          ? { sourcePath: catalog.find(record.workflow)!.sourcePath }
          : {}),
        ...(record.evidence ? { evidence: record.evidence } : {}),
        ...(record.validation ? { validation: record.validation } : {}),
        ...(record.combination ? { combination: record.combination } : {}),
        ...(record.reliability ? { reliability: record.reliability } : {}),
        ...(record.branch ? { branch: record.branch } : {}),
        ...(record.workspace ? { workspace: record.workspace } : {}),
        ...(record.prCommand ? { prCommand: record.prCommand } : {}),
        ...(record.diff ? { diff: record.diff } : {}),
      })),
    });
    return true;
  }

  // The persisted tick log: what every watcher trigger — CLI, cron, this
  // dashboard — actually did, newest first.
  if (path === '/api/watch/history') {
    const ticks = await loadTicks(config.artifactRoot, Number(url.searchParams.get('limit') ?? 50));
    json(res, 200, { ticks });
    return true;
  }

  if (path === '/api/watch/tick' && req.method === 'POST') {
    if (!watcher) {
      json(res, 503, { error: 'this dashboard has no watcher' });
      return true;
    }
    try {
      const rows = await watcher.tickNow();
      json(res, 200, { rows });
    } catch (err) {
      json(res, 409, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  // Runs recorded by any process into the shared persistence — external apps
  // included. Discovery is read-only; the engine's fork works over any of
  // them, artifacts or not.
  if (path === '/api/db/runs') {
    const limit = Number(url.searchParams.get('limit') ?? 50);
    const rows = await stack.persistence.listWorkflowRuns({ limit });
    const artifactRuns = new Set(
      (await loadHistory(config.artifactRoot, { limit: 500 })).map((entry) => entry.meta.runId));
    json(res, 200, {
      // Without Postgres the fallback provider only knows this process's
      // runs since startup; the page says so instead of implying a shared
      // database that is not there.
      durable: stack.available.has('postgres'),
      runs: rows.map((row) => ({
        runId: row.id,
        graphId: row.graph_id,
        status: row.status,
        createdAt: row.created_at,
        ...(row.parent_run_id ? { parentRunId: row.parent_run_id } : {}),
        ...(row.run_kind ? { runKind: row.run_kind } : {}),
        hasArtifacts: artifactRuns.has(row.id),
      })),
    });
    return true;
  }

  // One external run: its row, its graph's name, and the event-log timeline
  // with fork boundaries resolved the same way `forkPoints()` addresses them.
  if (path === '/api/db/run') {
    const runId = url.searchParams.get('id') ?? '';
    const row = await stack.persistence.loadWorkflowRun(runId);
    if (!row) {
      json(res, 404, { error: `no run '${runId}' in persistence` });
      return true;
    }
    const graph = await stack.persistence.loadGraph(row.graph_id);
    const events = await stack.eventLog.loadEvents(runId);
    const points = forkPoints(events as never);
    json(res, 200, {
      run: { runId: row.id, graphId: row.graph_id, status: row.status, createdAt: row.created_at },
      graphName: graph?.name ?? null,
      timeline: events
        .filter((event) => event.event_type !== 'internal_dispatched')
        .map((event) => ({
          sequenceId: event.sequence_id,
          type: event.event_type,
          ...(event.node_id ? { nodeId: event.node_id } : {}),
        })),
      forkPoints: points.map((point) => ({
        beforeNode: point.nodeId,
        occurrence: point.occurrence,
        sequenceId: point.sequenceId,
      })),
    });
    return true;
  }

  // Pull an external run into the artifact tree, so sensing sees it.
  if (path === '/api/db/import' && req.method === 'POST') {
    const body = (await readBody(req)) as { runId?: string };
    if (!body.runId) {
      json(res, 400, { error: 'runId is required' });
      return true;
    }
    const outcome = await importRun(stack, body.runId);
    json(res, outcome.imported ? 200 : 422, outcome);
    return true;
  }

  // Fork an external run at a boundary. The recorded graph is the graph —
  // no scenario rebuild — and agents resolve from the shared registry when
  // postgres carries one, so a run made by another app replays here.
  if (path === '/api/db/fork' && req.method === 'POST') {
    const body = (await readBody(req)) as {
      runId?: string;
      beforeNode?: string;
      occurrence?: number;
      prompt?: { node: string; text: string };
    };
    if (!body.runId) {
      json(res, 400, { error: 'runId is required' });
      return true;
    }
    try {
      const registry = await dbAgentRegistry(stack);
      const result = await fork(body.runId, {
        eventLog: stack.eventLog,
        persistence: stack.persistence,
        ...(registry ? { registry } : {}),
        ...(body.beforeNode
          ? { at: { beforeNode: body.beforeNode, ...(body.occurrence ? { occurrence: body.occurrence } : {}) } }
          : {}),
        ...(body.prompt
          ? { change: [change.prompt(body.prompt.node, body.prompt.text)] }
          : {}),
      });
      bus?.publish({ kind: 'fork', data: { runId: result.runId, baseRunId: body.runId } });
      json(res, 200, {
        runId: result.runId,
        status: result.state?.status ?? 'dry',
        forkNodeId: result.forkNodeId,
        forkSequenceId: result.forkSequenceId,
        memoHits: result.memoHits.length,
        incurredCostUsd: result.incurredCostUsd,
        diff: result.diff,
      });
    } catch (err) {
      json(res, 422, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  // The self-improvement loop: run, measure, adopt, stop at a diff. One at
  // a time, and never past a committed branch — publishing stays human.
  if (path === '/api/loop') {
    if (!loop) {
      json(res, 503, { error: 'this dashboard has no loop controller' });
      return true;
    }
    json(res, 200, loop.status());
    return true;
  }

  if (path === '/api/loop/start' && req.method === 'POST') {
    if (!loop) {
      json(res, 503, { error: 'this dashboard has no loop controller' });
      return true;
    }
    const body = (await readBody(req)) as {
      scenario?: string;
      autonomy?: 'propose' | 'trial' | 'apply';
      maxRuns?: number;
      maxMinutes?: number;
    };
    const scenario = body.scenario ? findInCatalog(body.scenario) : undefined;
    if (!scenario) {
      json(res, 404, { error: `No workflow named "${body.scenario ?? ''}"` });
      return true;
    }
    try {
      loop.start(scenario, {
        ...(body.autonomy ? { autonomy: body.autonomy } : {}),
        ...(body.maxRuns !== undefined ? { maxRuns: body.maxRuns } : {}),
        ...(body.maxMinutes !== undefined ? { maxMinutes: body.maxMinutes } : {}),
      });
      json(res, 200, loop.status());
    } catch (err) {
      json(res, 409, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  if (path === '/api/loop/stop' && req.method === 'POST') {
    loop?.stop();
    json(res, 200, loop?.status() ?? { running: false, events: [] });
    return true;
  }

  // Where each workflow stands against the watcher's gates, so the page can
  // say "two more runs" instead of leaving a tick to report it later.
  if (path === '/api/improve/readiness') {
    json(res, 200, { readiness: await workflowReadiness(stack, catalog.scenarios) });
    return true;
  }

  // Measure one workflow now: the same pass the watcher would run for it,
  // streamed, and saving whatever it proposes.
  if (path === '/api/tune' && req.method === 'POST') {
    const body = (await readBody(req)) as { scenario?: string; params?: Record<string, unknown> };
    const scenario = body.scenario ? findInCatalog(body.scenario) : undefined;
    if (!scenario) {
      json(res, 404, { error: `No workflow named "${body.scenario ?? ''}"` });
      return true;
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    const send = (event: string, data: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    watcher?.noteWorkStarted();
    try {
      const missing = unmetRequirements(stack, scenario.requires);
      if (missing.length > 0) {
        send('error', { message: `${scenario.id} needs ${missing.join(', ')}` });
        return true;
      }
      const params = scenario.params.parse(body.params ?? {});
      const built = await scenario.build(params as never, stack);
      const outcome = await tuneWorkflow(scenario, params, stack, built.graph, {
        reuse: true,
        onProgress: (message) => send('line', { message }),
      });
      const saved = await saveProposals(config.artifactRoot, outcome);
      send('done', {
        workflow: scenario.id,
        forks: outcome.forks,
        saved,
        ...(outcome.skipped ? { skipped: outcome.skipped } : {}),
      });
    } catch (err) {
      send('error', { message: err instanceof Error ? err.message : String(err) });
    } finally {
      watcher?.noteWorkFinished();
      res.end();
    }
    return true;
  }

  // The recorded improve sessions, as far as their artifacts describe them.
  // A session's params are self-describing (target, repoRoot, workspace), so
  // the page can rebuild its topology through /api/graph?scenario=improve.
  if (path === '/api/improve/sessions') {
    const limit = Number(url.searchParams.get('limit') ?? 50);
    const entries = await loadHistory(config.artifactRoot, { scenarioId: 'improve', limit });
    json(res, 200, {
      // Forks of a session are counterfactual artifacts, not sessions.
      sessions: entries.filter((entry) => entry.meta.parentRunId === undefined).map((entry) => ({
        runId: entry.meta.runId,
        status: entry.meta.status ?? 'running',
        startedAt: entry.meta.startedAt,
        durationMs: entry.meta.durationMs,
        params: entry.meta.params,
        usage: entry.usage,
        ...(entry.meta.traceId ? { traceId: entry.meta.traceId } : {}),
        ...(entry.meta.error ? { error: entry.meta.error } : {}),
      })),
    });
    return true;
  }

  // Sense the improve corpus from the page: the same pass `play tune improve`
  // runs, streamed. Corpus honesty (epoch retirement, unmotivated knobs) is
  // the tune pipeline's to report, not this route's to soften.
  if (path === '/api/improve/tune' && req.method === 'POST') {
    const body = (await readBody(req)) as { params?: Record<string, unknown>; save?: boolean };

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    const send = (event: string, data: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    watcher?.noteWorkStarted();
    try {
      const improveTarget = improveTuneTargetFor(catalog);
      const params = improveTarget.params.parse(body.params ?? {});
      const built = await improveTarget.build(params as never, stack);
      const outcome = await tuneWorkflow(improveTarget, params, stack, built.graph, {
        onProgress: (message) => send('line', { message }),
      });
      if (body.save) {
        outcome.savedProposals = await saveProposals(config.artifactRoot, outcome);
      }
      send('done', {
        forks: outcome.forks,
        verdicts: outcome.verdicts,
        ...(outcome.skipped ? { skipped: outcome.skipped } : {}),
        ...(outcome.savedProposals ? { saved: outcome.savedProposals } : {}),
      });
    } catch (err) {
      send('error', { message: err instanceof Error ? err.message : String(err) });
    } finally {
      watcher?.noteWorkFinished();
      res.end();
    }
    return true;
  }

  // Apply a proposal from the page: the identical clone → edit → verify →
  // commit flow the CLI drives, streamed as it unfolds. The one act it never
  // performs is publishing — the done event carries the prepared PR script
  // and the committed diff, and running the script stays a human step.
  if (path === '/api/apply' && req.method === 'POST') {
    const body = (await readBody(req)) as { id?: string };
    const proposals = await listProposals(config.artifactRoot);
    const record = body.id ? proposals.find((entry) => entry.id === body.id) : undefined;

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    const send = (event: string, data: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    if (!record) {
      send('error', { message: `no proposal '${body.id ?? ''}'` });
      res.end();
      return true;
    }

    watcher?.noteWorkStarted();
    try {
      const repo = config.applyRepo
        ? { root: config.applyRepo, fixture: false }
        : await resolveApplyRepo(resolve(process.cwd(), '..', '..'), process.cwd());
      if (repo.fixture) send('line', { message: `repository does not track the playground — using a fixture at ${repo.root}` });
      const outcome = await applyProposal(stack, repo.root, record, (message) => {
        send('line', { message });
        bus?.publish({ kind: 'apply', scenarioId: record.workflow, data: { message } });
      }, catalog.find(record.workflow)?.sourcePath);
      send('done', {
        id: record.id,
        branch: outcome.branch,
        workspace: outcome.workspace,
        files: outcome.files,
        diff: outcome.diff,
        prCommand: outcome.prCommand,
        fixture: repo.fixture,
      });
    } catch (err) {
      send('error', { message: err instanceof Error ? err.message : String(err) });
    } finally {
      watcher?.noteWorkFinished();
      res.end();
    }
    return true;
  }

  // Ladder transitions the page may drive. Mirrors the CLI: `trial` puts a
  // proposal on runtime overlay, `merged` marks it applied and retires the
  // corpus, `revert` walks it back the way the CLI's revert does. Writing
  // source stays a CLI act (`play apply`) — it runs an editor for minutes.
  if (path === '/api/proposals/action' && req.method === 'POST') {
    const body = (await readBody(req)) as { id?: string; action?: string };
    if (!body.id || !body.action) {
      json(res, 400, { error: 'id and action are required' });
      return true;
    }

    if (body.action === 'trial') {
      const result = await setProposalStatus(config.artifactRoot, body.id, 'trial');
      json(res, 'error' in result ? 409 : 200, result);
      return true;
    }
    if (body.action === 'merged') {
      const result = await setProposalStatus(config.artifactRoot, body.id, 'applied');
      if (!('error' in result)) await writeEpoch(config.artifactRoot);
      json(res, 'error' in result ? 409 : 200, result);
      return true;
    }
    if (body.action === 'revert') {
      const open = (await listProposals(config.artifactRoot)).find((record) => record.id === body.id);
      if (!open) {
        json(res, 404, { error: `no proposal '${body.id}'` });
        return true;
      }
      const next = open.status === 'applied'
        ? 'reverted'
        : open.status === 'trial' || open.status === 'pr' ? 'proposed' : 'reverted';
      const result = await setProposalStatus(config.artifactRoot, body.id, next);
      if (!('error' in result) && open.status === 'applied') await writeEpoch(config.artifactRoot);
      json(res, 'error' in result ? 409 : 200, result);
      return true;
    }
    json(res, 400, { error: `unknown action '${body.action}'` });
    return true;
  }

  if (path === '/api/respond' && req.method === 'POST') {
    const body = (await readBody(req)) as {
      runId?: string;
      decision?: 'approved' | 'rejected' | 'edited';
      data?: unknown;
    };

    if (!body.runId || !body.decision) {
      json(res, 400, { error: 'runId and decision are required' });
      return true;
    }

    const delivered = answerPrompt(body.runId, {
      decision: body.decision,
      ...(body.data !== undefined ? { data: body.data } : {}),
    });

    // Not an error: a reload, a double-submit, or an answer that lost a race
    // with the abandonment timer all land here, and none of them is the
    // reviewer's problem.
    json(res, delivered ? 200 : 409, { delivered });
    return true;
  }

  return false;
}
