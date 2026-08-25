/**
 * The studio API client: typed fetch helpers and the two stream readers
 * (EventSource tail, SSE-over-POST for apply and tune). Everything talks to
 * the same-origin /api routes the node server owns.
 */

export interface CatalogEntry {
  id: string;
  title: string;
  covers: string[];
  requires: string[];
  runnable: boolean;
  missing: string[];
  params: ParamField[];
}

export interface ParamField {
  name: string;
  kind: string;
  description?: string;
  default?: unknown;
  values?: string[];
  fields?: ParamField[];
}

export interface StackInfo {
  model: string;
  tenant: string;
  available: string[];
  gaps: Array<{ feature: string; reason: string }>;
  jaegerBase?: string;
}

export interface LogRow {
  kind: 'log' | 'event';
  runId: string;
  workflow: string;
  time: string;
  level?: string;
  event?: string;
  node?: string;
  text: string;
  raw: Record<string, unknown>;
}

export interface DbRun {
  runId: string;
  graphId: string;
  status: string;
  createdAt: string;
  parentRunId?: string;
  runKind?: string;
  hasArtifacts: boolean;
}

export interface Proposal {
  id: string;
  workflow: string;
  nodeId: string;
  knob: string;
  from: unknown;
  to: unknown;
  computeDelta: number;
  tokenDelta: number;
  model: string;
  status: string;
  statusChangedAt: string;
  measuredOn?: string[];
  /** The workflow's defining file, which an apply edits. */
  sourcePath?: string;
  /** What the proposal would actually change, keyed by mutation kind. */
  change?: Array<{
    kind: string;
    target?: string;
    node_id?: string;
    system_prompt?: string;
    model?: string;
    temperature?: number;
    [field: string]: unknown;
  }>;
  validation?: { confirmed: boolean; detail: string };
  combination?: string;
  reliability?: Record<string, unknown>;
  branch?: string;
  diff?: string;
  prCommand?: string;
  evidence?: Array<{
    name: string;
    assertionsHeld: boolean;
    failed?: string[];
    computeMs: number;
    tokens: number;
    reused?: boolean;
    error?: string;
  }>;
}

export interface WatchState {
  watcher?: {
    running: boolean;
    auto: boolean;
    pendingRuns: number;
    lastTickAt?: string;
    lastError?: string;
  };
  proposals: Proposal[];
}

export interface LoopEvent {
  at: string;
  kind: string;
  message: string;
}

export interface LoopStatus {
  running: boolean;
  workflow?: string;
  autonomy?: string;
  startedAt?: string;
  events: LoopEvent[];
  result?: {
    runs: number;
    measures: number;
    proposals: string[];
    stoppedBecause: string;
    /** Set when an apply attempt was refused by verification. */
    applyError?: string;
    applied?: { id: string; branch: string; diff: string; prCommand: string; repoRoot: string; fixture: boolean };
  };
  error?: string;
}

export interface Readiness {
  workflow: string;
  freshRuns: number;
  floor: number;
  ready: boolean;
  openProposals: string[];
  missing: string[];
  detail: string;
}

export interface Tick {
  at: string;
  rows: Array<{ workflow: string; outcome: string; detail: string; forks: number }>;
}

export interface ImproveSession {
  runId: string;
  status: string;
  startedAt: string;
  durationMs?: number;
  params?: { target?: string; repoRoot?: string; workspace?: string };
  usage?: { totalTokens: number };
  error?: string;
}

export interface WireGraph {
  id: string;
  name: string;
  startNode: string;
  endNodes: string[];
  nodes: Array<{ id: string; type: string; childId?: string; worker?: string; managed?: string[] }>;
  edges: Array<{ source: string; target: string; label?: string }>;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `${path} answered ${response.status}`);
  return body;
}

export function post<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Read an SSE-over-POST response, dispatching each frame. */
export async function readSse(
  response: Response,
  onEvent: (event: string, payload: Record<string, unknown>) => void,
): Promise<void> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const event = /^event: (.+)$/m.exec(frame)?.[1];
      const payload = JSON.parse(/^data: (.+)$/m.exec(frame)?.[1] ?? '{}') as Record<string, unknown>;
      if (event) onEvent(event, payload);
    }
  }
}

export function when(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}
