'use client';

/**
 * Scenarios: the run surface. The catalog rail, the schema-driven param
 * form, the run stream with live graph overlay and inline gate answering,
 * the final memory as output, and the fork panel for the run just made.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, readSse, type CatalogEntry, type WireGraph } from '../../lib/api';
import { assembleParams, displayValue, type FormField } from '../../lib/params';
import { Badge, Button, Empty, Input, Section, Select } from '../../components/primitives';
import { GraphView, type NodeMark } from '../../components/graph-view';
import { cn } from '../../lib/utils';

interface StreamLine {
  text: string;
  tone?: 'ok' | 'bad' | 'dim' | 'warn' | 'write';
}

interface ForkPoint {
  sequenceId: number;
  nodeId: string;
  nodeType: string;
  occurrence: number;
  iteration: number;
  hasAgent: boolean;
}

interface RunDone {
  runId: string;
  status: string;
  durationMs: number;
  usage: { totalTokens: number };
  evals: Array<{ passed: boolean; assertion: { type: string }; message?: string }>;
  taint: string[];
  goal?: string;
  memory: Record<string, unknown>;
  visited: string[];
}

interface Gate {
  runId: string;
  question: string;
  review: Record<string, unknown>;
  resolve: (decision: string, note: string) => void;
}

const preview = (value: unknown, max = 600): string => {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 1);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

export default function ScenariosPage() {
  const router = useRouter();
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [selected, setSelected] = useState<CatalogEntry | undefined>();
  const [values, setValues] = useState<Record<string, string>>({});
  const [goal, setGoal] = useState('');
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState('');
  const [lines, setLines] = useState<StreamLine[]>([]);
  const [done, setDone] = useState<RunDone | undefined>();
  const [gate, setGate] = useState<Gate | undefined>();
  const [topology, setTopology] = useState<{ graph: WireGraph; children: Record<string, WireGraph> } | undefined>();
  const [marks, setMarks] = useState<Map<string, NodeMark>>(new Map());
  const [forkPoints, setForkPoints] = useState<ForkPoint[] | undefined>();
  const forkableRef = useRef<{ runId: string; scenario: string; params: Record<string, unknown> } | undefined>(undefined);
  const waitingStateRef = useRef<Record<string, unknown> | undefined>(undefined);

  useEffect(() => {
    void api<{ scenarios: CatalogEntry[] }>('/api/scenarios').then((body) => {
      setCatalog(body.scenarios);
      // Arriving from the improve flow's "run this workflow" step.
      const requested = sessionStorage.getItem('runWorkflow');
      if (!requested) return;
      sessionStorage.removeItem('runWorkflow');
      const entry = body.scenarios.find((s) => s.id === requested);
      if (entry) void select(entry);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fields: FormField[] = (selected?.params ?? []) as unknown as FormField[];
  const currentParams = useCallback(() => assembleParams(
    fields.map((f) => ({ path: f.path, kind: f.kind, value: values[f.path] ?? displayValue(f) })),
  ), [fields, values]);

  const select = async (entry: CatalogEntry) => {
    setSelected(entry);
    setValues({});
    setGoal('');
    setLines([]);
    setDone(undefined);
    setForkPoints(undefined);
    setMarks(new Map());
    await drawGraph(entry, {});
  };

  const drawGraph = async (entry: CatalogEntry, params: Record<string, unknown>) => {
    try {
      const query = new URLSearchParams({ scenario: entry.id, params: JSON.stringify(params) });
      setTopology(await api(`/api/graph?${query}`));
    } catch {
      setTopology(undefined);
    }
  };

  const mark = (event: Record<string, unknown>) => {
    const nodeId = event.node_id;
    if (typeof nodeId !== 'string') return;
    setMarks((current) => {
      const next = new Map(current);
      if (event.type === 'node:start') next.set(nodeId, 'executing');
      else if (event.type === 'node:complete') next.set(nodeId, 'visited');
      else if (event.type === 'node:failed') next.set(nodeId, 'failed');
      else return current;
      return next;
    });
  };

  const push = (text: string, tone?: StreamLine['tone']) =>
    setLines((current) => [...current, { text, tone }]);

  const renderEvent = (e: Record<string, unknown>) => {
    mark(e);
    const id = String(e.node_id ?? '').padEnd(18);
    if (e.type === 'workflow:waiting') waitingStateRef.current = e.state as Record<string, unknown>;
    if (e.type === 'node:start') push(`▸ ${id} ${String(e.node_type ?? '')}`, 'dim');
    else if (e.type === 'node:complete') push(`✓ ${id} ${String(e.duration_ms)}ms`, 'ok');
    else if (e.type === 'node:failed') push(`✗ ${id} ${String(e.error)}`, 'bad');
    else if (e.type === 'node:retry') push(`↻ ${id} retry ${String(e.attempt)}`, 'dim');
    else if (e.type === 'workflow:waiting') push(`⏸ waiting: ${String(e.waiting_for)}`, 'dim');
    else if (e.type === 'tool:call_finish') push(`    ${String(e.tool_name)} ${e.success ? 'ok' : 'failed'} ${String(e.duration_ms)}ms`, 'dim');
    else if (e.type === 'action:applied' && e.memory_diff) {
      const diff = e.memory_diff as { added?: string[]; changed?: string[]; values?: Record<string, unknown> };
      for (const key of [...(diff.added ?? []), ...(diff.changed ?? [])]) {
        push(`    ${key} = ${preview(diff.values?.[key], 120)}`, 'write');
      }
    }
  };

  const promptHuman = (runId: string, question: string): Promise<void> => new Promise((resolveGate) => {
    push(`⏸ ${question}`, 'warn');
    setStatus('waiting for you');
    const waiting = waitingStateRef.current;
    const pending = (waiting?.pending_approval ?? undefined) as { review_data?: Record<string, unknown> } | undefined;
    const review = pending?.review_data ?? (waiting?.memory as Record<string, unknown> | undefined) ?? {};
    setGate({
      runId,
      question,
      review,
      resolve: (decision, note) => {
        void fetch('/api/respond', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            runId,
            // A note is an edit, not a bare approval: the engine routes on
            // the decision, so 'approved' plus changes would lose them.
            decision: note && decision === 'approved' ? 'edited' : decision,
            ...(note ? { data: note } : {}),
          }),
        }).then(() => {
          push(`  ↳ ${decision}${note ? `: ${note}` : ''}`, 'dim');
          setGate(undefined);
          setStatus('running…');
          resolveGate();
        });
      },
    });
  });

  const run = async () => {
    if (!selected) return;
    setRunning(true);
    setLines([]);
    setDone(undefined);
    setForkPoints(undefined);
    setMarks(new Map());
    setStatus('running…');
    const params = currentParams();
    await drawGraph(selected, params);

    const response = await fetch('/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenario: selected.id, params, ...(goal.trim() ? { goal: goal.trim() } : {}) }),
    });
    let pending: Promise<void> = Promise.resolve();
    await readSse(response, (event, data) => {
      if (event === 'event') renderEvent(data);
      else if (event === 'pause') {
        pending = pending.then(() => promptHuman(String(data.runId), String(data.question)));
      } else if (event === 'done') {
        const d = data as unknown as RunDone;
        const passed = d.evals.filter((r) => r.passed).length;
        push('');
        push(`${d.status} in ${d.durationMs}ms · ${d.usage.totalTokens} tokens · evals ${passed}/${d.evals.length}`,
          d.status === 'completed' ? 'ok' : 'bad');
        if (d.taint.length) push(`tainted: ${d.taint.join(', ')}`, 'dim');
        for (const r of d.evals.filter((r) => !r.passed)) push(`  ✗ ${r.assertion.type} ${r.message ?? ''}`, 'bad');
        setStatus(`${d.status} · ${passed}/${d.evals.length}`);
        setDone(d);
        forkableRef.current = { runId: d.runId, scenario: selected.id, params };
        void offerFork(d.runId, params);
      } else if (event === 'error') {
        const issues = data.issues;
        if (Array.isArray(issues)) {
          push('invalid parameters:', 'bad');
          for (const issue of issues as Array<{ path?: string; message?: string }>) {
            push(`  ${issue.path || '(root)'}: ${issue.message ?? ''}`, 'bad');
          }
          setStatus('invalid parameters');
        } else {
          push(`error: ${String(data.message)}`, 'bad');
          setStatus('error');
        }
      }
    });
    setRunning(false);
  };

  const offerFork = async (runId: string, params: Record<string, unknown>) => {
    if (!selected) return;
    const query = new URLSearchParams({ scenario: selected.id, params: JSON.stringify(params) });
    const body = await api<{ points: ForkPoint[] }>(`/api/runs/${encodeURIComponent(runId)}/fork-points?${query}`);
    setForkPoints(body.points);
  };

  return (
    <div className="flex gap-5">
      <nav className="w-52 shrink-0 space-y-0.5">
        {catalog.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No workflows declared. Add them to <code className="text-foreground">cycgraph.config.ts</code>{' '}
            (<code className="text-foreground">graphs: [&apos;./graphs/my-flow.ts&apos;]</code>), or start the
            studio with <code className="text-foreground">--load ./graphs/my-flow.ts</code>.
          </p>
        )}
        {catalog.map((entry) => (
          <button
            key={entry.id}
            onClick={() => void select(entry)}
            disabled={!entry.runnable}
            className={cn(
              'block w-full rounded-md px-2.5 py-1.5 text-left text-xs hover:bg-muted/40',
              selected?.id === entry.id && 'bg-card text-accent',
              !entry.runnable && 'opacity-40',
            )}
          >
            <div>{entry.id}</div>
            <div className="truncate text-[11px] text-muted-foreground">
              {entry.runnable ? entry.covers.join(' · ') : `needs ${entry.missing.join(', ')}`}
            </div>
          </button>
        ))}
      </nav>

      <div className="min-w-0 flex-1">
        {!selected ? <Empty>Pick a workflow.</Empty> : (
          <>
            <h2 className="mb-3 text-sm">{selected.id} <span className="text-muted-foreground">{selected.title}</span></h2>

            <div className="mb-3 grid grid-cols-2 gap-3">
              <label className="col-span-2 block text-xs text-muted-foreground">
                goal
                <Input className="mt-1" value={goal} onChange={(e) => setGoal(e.target.value)}
                  placeholder="leave empty to use the workflow's own goal" />
              </label>
              {fields.map((field) => (
                <label key={field.path} className="block text-xs text-muted-foreground">
                  {field.path}
                  {field.kind === 'enum' || field.kind === 'boolean' ? (
                    <Select
                      className="mt-1 w-full"
                      value={values[field.path] ?? displayValue(field)}
                      onValueChange={(next) => setValues((v) => ({ ...v, [field.path]: next }))}
                      options={(field.kind === 'boolean' ? ['true', 'false'] : field.options ?? [])
                        .map((option) => ({ value: option, label: option }))}
                    />
                  ) : (
                    <Input
                      className="mt-1"
                      type={field.kind === 'number' || field.kind === 'integer' ? 'number' : 'text'}
                      step="any"
                      value={values[field.path] ?? displayValue(field)}
                      onChange={(e) => setValues((v) => ({ ...v, [field.path]: e.target.value }))}
                    />
                  )}
                  {field.description && <em className="mt-0.5 block not-italic text-[11px] text-muted-foreground/70">{field.description}</em>}
                </label>
              ))}
            </div>

            <div className="mb-4 flex items-center gap-3">
              <Button variant="primary" disabled={running} onClick={() => void run()}>
                {running ? 'running…' : 'Run'}
              </Button>
              <Button
                onClick={() => {
                  sessionStorage.setItem('improveWorkflow', selected.id);
                  router.push('/improve/');
                }}
                title="Measure this workflow's knobs against its evals"
              >
                Improve this workflow
              </Button>
              <span className="text-xs text-muted-foreground">{status}</span>
            </div>

            {topology && (
              <Section title="Topology">
                <GraphView graph={topology.graph} children={topology.children} marks={marks} />
              </Section>
            )}

            {gate && (
              <Section title="Waiting on you">
                <div className="rounded-md border border-warn/30 bg-warn/5 p-4">
                  <p className="mb-2 text-xs">{gate.question}</p>
                  {Object.entries(gate.review).filter(([key]) => !key.startsWith('_')).map(([key, value]) => (
                    <div key={key} className="mb-2">
                      <b className="text-xs">{key}</b>
                      <pre className="mt-0.5 max-h-40 overflow-auto rounded bg-muted/40 p-2 text-[12px] leading-relaxed">{preview(value)}</pre>
                    </div>
                  ))}
                  <GateActions gate={gate} />
                </div>
              </Section>
            )}

            {lines.length > 0 && (
              <Section title="Stream">
                <pre className="max-h-80 overflow-auto rounded-md bg-muted/40 p-3 text-[12px] leading-relaxed">
                  {lines.map((line, i) => (
                    <div key={i} className={cn(
                      line.tone === 'ok' && 'text-ok',
                      line.tone === 'bad' && 'text-bad',
                      line.tone === 'warn' && 'text-warn',
                      line.tone === 'dim' && 'text-muted-foreground',
                      line.tone === 'write' && 'text-accent',
                    )}>{line.text || ' '}</div>
                  ))}
                </pre>
              </Section>
            )}

            {done && (
              <Section title="Output">
                <p className="mb-2 text-xs text-muted-foreground">goal: {done.goal ?? '—'}</p>
                {Object.keys(done.memory).length === 0
                  ? <Empty>The run wrote nothing to memory.</Empty>
                  : (
                    <table className="w-full text-xs">
                      <tbody>
                        {Object.entries(done.memory).map(([key, value]) => (
                          <tr key={key} className="border-b border-border/50 last:border-0 align-top">
                            <td className="w-40 py-1.5 pr-3">
                              {key}{done.taint.includes(key) && <span className="text-warn" title="external data"> ⚠</span>}
                            </td>
                            <td className="whitespace-pre-wrap py-1.5 text-xs">{typeof value === 'string' ? value : JSON.stringify(value, null, 1)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                <p className="mt-2 text-[11px] text-muted-foreground">visited {done.visited.join(' → ')}</p>
              </Section>
            )}

            {forkPoints && (
              forkPoints.length === 0
                ? <Empty>This run has no recorded events to fork. Runs from an earlier process need Postgres.</Empty>
                : <ForkPanel points={forkPoints} forkable={forkableRef.current!} onEvent={renderEvent} promptHuman={promptHuman} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function GateActions({ gate }: { gate: Gate }) {
  const [note, setNote] = useState('');
  return (
    <div className="flex items-center gap-2">
      <Input className="w-64" placeholder="notes, sent as the response data" value={note}
        onChange={(e) => setNote(e.target.value)} />
      <Button variant="primary" onClick={() => gate.resolve('approved', note.trim())}>Approve</Button>
      <Button onClick={() => gate.resolve('rejected', note.trim())}>Reject</Button>
    </div>
  );
}

function buildChange(kind: string, nodeId: string, value: string): Record<string, unknown> {
  const parseJson = (text: string): Record<string, unknown> => {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected an object');
    return parsed as Record<string, unknown>;
  };
  if (kind === 'memory') return { kind: 'memory', set: parseJson(value) };
  if (kind === 'output') return { kind: 'output', node_id: nodeId, memory: parseJson(value) };
  if (kind === 'temperature') return { kind, target: nodeId, temperature: Number(value) };
  if (kind === 'model') return { kind, target: nodeId, model: value };
  return { kind: 'prompt', target: nodeId, system_prompt: value };
}

function ForkPanel({
  points,
  forkable,
  onEvent,
  promptHuman,
}: {
  points: ForkPoint[];
  forkable: { runId: string; scenario: string; params: Record<string, unknown> };
  onEvent: (event: Record<string, unknown>) => void;
  promptHuman: (runId: string, question: string) => Promise<void>;
}) {
  const [sequence, setSequence] = useState(points[0]!.sequenceId);
  const [kind, setKind] = useState('');
  const [value, setValue] = useState('');
  const [memoize, setMemoize] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<React.ReactNode | undefined>();
  const point = points.find((p) => p.sequenceId === sequence)!;

  const runFork = async (allow: string[] = []) => {
    let change: Array<Record<string, unknown>> = [];
    if (kind && value) {
      try {
        change = [buildChange(kind, point.nodeId, value)];
      } catch (err) {
        setResult(<p className="text-bad">That value needs to be a JSON object like {'{"score": 0.95}'} — {err instanceof Error ? err.message : String(err)}</p>);
        return;
      }
    }
    setBusy(true);
    setResult(<p className="text-muted-foreground">forking…</p>);
    const trace: string[] = [];

    const response = await fetch('/api/fork', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...forkable,
        baseRunId: forkable.runId,
        at: { sequence },
        change,
        memoize,
        ...(allow.length ? { allow } : {}),
      }),
    });
    let pending: Promise<void> = Promise.resolve();
    await readSse(response, (event, data) => {
      if (event === 'node' && data.phase === 'start') {
        trace.push(String(data.nodeId));
        setResult(<p className="text-muted-foreground">running {trace.join(' → ')}…</p>);
      } else if (event === 'event') {
        onEvent(data);
      } else if (event === 'pause') {
        pending = pending.then(() => promptHuman(String(data.runId), String(data.question)));
      } else if (event === 'done') {
        setResult(<ForkOutcome data={data} />);
      } else if (event === 'error') {
        const message = String(data.message ?? '');
        const blocked = /^Node '([^']+)'/.exec(message)?.[1];
        setResult(
          <div>
            <p className="text-warn">{message}</p>
            {blocked && <Button className="mt-2" onClick={() => void runFork([...allow, blocked])}>Allow {blocked} and fork again</Button>}
          </div>,
        );
      }
    });
    setBusy(false);
  };

  return (
    <Section title="Fork this run">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={String(sequence)}
          onValueChange={(next) => { setSequence(Number(next)); setKind(''); }}
          options={points.map((p) => ({
            value: String(p.sequenceId),
            label: `before ${p.nodeId}${p.occurrence > 1 ? ` (#${p.occurrence})` : ''} · ${p.nodeType} · iteration ${p.iteration}`,
          }))}
        />
        <Select
          value={kind}
          onValueChange={setKind}
          options={[
            { value: '', label: 'nothing — check it reproduces' },
            { value: 'memory', label: `patch memory before ${point.nodeId} runs` },
            { value: 'output', label: `substitute what ${point.nodeId} produces` },
            ...(point.hasAgent
              ? [
                { value: 'prompt', label: `system prompt of ${point.nodeId}` },
                { value: 'model', label: `model of ${point.nodeId}` },
                { value: 'temperature', label: `temperature of ${point.nodeId}` },
              ]
              : []),
          ]}
        />
        {kind && (
          <Input
            className="w-64"
            placeholder={kind === 'memory' || kind === 'output' ? 'JSON, e.g. {"score": 0.95}' : kind === 'temperature' ? '0 to 1' : 'value'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        )}
        <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <input type="checkbox" checked={memoize} onChange={(e) => setMemoize(e.target.checked)} />
          replay unchanged nodes
        </label>
        <Button variant="primary" disabled={busy} onClick={() => void runFork()}>Fork</Button>
      </div>
      {result && <div className="mt-3">{result}</div>}
    </Section>
  );
}

function ForkOutcome({ data }: { data: Record<string, unknown> }) {
  const diff = data.diff as {
    status?: { base: string; variant: string };
    path?: Array<{ base?: string; variant?: string }>;
    memory?: Record<string, { change: string; bytesDelta?: number; taintChanged?: boolean }>;
    verdict?: { summary: string; kind: string };
    cost?: { incurredUsd: number; tokensDelta: number };
  } | undefined;
  if (!diff) return <pre className="text-[11px]">{String(data.report ?? JSON.stringify(data))}</pre>;

  const memoHits = (data.memoHits ?? []) as string[];
  return (
    <div className="rounded-md bg-muted/40 p-3 text-xs">
      {diff.verdict && (
        <p className={cn('mb-2', diff.verdict.kind === 'unchanged' ? 'text-muted-foreground' : diff.verdict.kind === 'improved' ? 'text-ok' : 'text-warn')}>
          {diff.verdict.summary}
        </p>
      )}
      {diff.status && <p>status {diff.status.base === diff.status.variant ? diff.status.base : `${diff.status.base} → ${diff.status.variant}`}</p>}
      {diff.path && (
        <p className="mt-1">
          path {diff.path.map((s, i) => {
            const served = s.variant && memoHits.includes(s.variant);
            return (
              <span key={i}>
                {i > 0 && ' → '}
                <span className={cn(
                  s.base === s.variant ? (served ? 'text-muted-foreground' : 'text-ok') : 'text-warn',
                )} title={served ? 'served from the recording' : undefined}>
                  {s.base === s.variant ? s.variant : !s.variant ? `-${s.base}` : !s.base ? `+${s.variant}` : `${s.base}→${s.variant}`}
                </span>
              </span>
            );
          })}
        </p>
      )}
      {diff.memory && Object.keys(diff.memory).length > 0 && (
        <ul className="mt-1">
          {Object.entries(diff.memory).map(([key, m]) => (
            <li key={key}>
              <b>{key}</b> {m.change}
              {m.bytesDelta ? <span className="text-muted-foreground"> {m.bytesDelta > 0 ? '+' : ''}{m.bytesDelta}B</span> : null}
              {m.taintChanged && <span className="text-warn"> taint</span>}
            </li>
          ))}
        </ul>
      )}
      {diff.cost && <p className="mt-1 text-muted-foreground">cost ${diff.cost.incurredUsd.toFixed(4)} incurred, {diff.cost.tokensDelta >= 0 ? '+' : ''}{diff.cost.tokensDelta} tokens</p>}
    </div>
  );
}
