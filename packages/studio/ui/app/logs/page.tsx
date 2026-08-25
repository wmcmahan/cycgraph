'use client';

/**
 * Logs: the cross-run explorer. Facets over a newest-first merged stream
 * of engine log lines and node events, a live tail from the bus, a drawer
 * with the parsed line and its run's card, and the Database-runs browser
 * for runs any process recorded into shared persistence.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, shortId, when, type CatalogEntry } from '../../lib/api';
import {
  Badge, Button, Drawer, Empty, Facts, Input, Row, RowHead, RowList,
  Section, Select, statusTone,
} from '../../components/primitives';
import { cn } from '../../lib/utils';
import { JsonView } from '../../components/json-view';

interface LogRow {
  at: string;
  runId: string;
  scenarioId: string;
  kind: 'log' | 'event';
  level?: string;
  event: string;
  node?: string;
  model?: string;
  durationMs?: number;
  tool?: string;
  agent?: string;
  detail: string;
  raw: unknown;
}

const LOG_COLUMNS = '96px 56px 130px 150px minmax(220px, 1fr) 130px 72px';

interface RunCard {
  runId: string;
  scenarioId: string;
  params: unknown;
  status?: string;
  durationMs?: number;
  traceId?: string;
  usage: { totalTokens: number; totalCostUsd: number };
  evals: Array<{ passed: boolean }>;
}


export default function LogsPage() {
  const [filters, setFilters] = useState({ workflow: '', level: '', kind: '', node: '', run: '', q: '' });
  const [rows, setRows] = useState<LogRow[]>([]);
  const [meta, setMeta] = useState('');
  const [live, setLive] = useState(false);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [selected, setSelected] = useState<LogRow | undefined>();
  const [runCard, setRunCard] = useState<RunCard | undefined>();
  const tail = useRef<EventSource | null>(null);

  const load = useCallback(async (f: typeof filters) => {
    const query = new URLSearchParams({ limit: '200' });
    if (f.workflow) query.set('workflow', f.workflow);
    if (f.level) query.set('level', f.level);
    if (f.kind) query.set('kinds', f.kind);
    if (f.node) query.set('node', f.node);
    if (f.run) query.set('run', f.run);
    if (f.q) query.set('q', f.q);
    const body = await api<{ rows: LogRow[]; runsScanned: number }>(`/api/logs?${query}`);
    setRows(body.rows);
    setMeta(`${body.rows.length} rows over ${body.runsScanned} run(s)`);
  }, []);

  useEffect(() => {
    void api<{ scenarios: CatalogEntry[] }>('/api/scenarios').then((b) => setCatalog(b.scenarios));
    const pivot = sessionStorage.getItem('pivotRun');
    const initial = pivot ? { workflow: '', level: '', kind: '', node: '', run: pivot, q: '' } : filters;
    if (pivot) {
      sessionStorage.removeItem('pivotRun');
      setFilters(initial);
    }
    void load(initial);
    return () => tail.current?.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleLive = () => {
    if (tail.current) {
      tail.current.close();
      tail.current = null;
      setLive(false);
      return;
    }
    const source = new EventSource('/api/tail');
    source.addEventListener('tail', (message) => {
      const entry = JSON.parse(message.data as string) as { kind: string; runId?: string; scenarioId?: string; data?: Record<string, unknown> };
      if (entry.kind !== 'run' || !entry.data) return;
      const event = entry.data;
      setRows((current) => [{
        at: new Date().toISOString(),
        runId: entry.runId ?? '',
        scenarioId: entry.scenarioId ?? '',
        kind: 'event' as const,
        event: String(event.type ?? ''),
        node: typeof event.node_id === 'string' ? event.node_id : undefined,
        detail: `${String(event.type ?? '')}${event.node_id ? ` ${String(event.node_id)}` : ''}`,
        raw: event,
      }, ...current].slice(0, 400));
    });
    tail.current = source;
    setLive(true);
  };

  const openRow = async (row: LogRow) => {
    setSelected(row);
    setRunCard(undefined);
    try {
      setRunCard(await api<RunCard>(`/api/runs/${encodeURIComponent(row.runId)}`));
    } catch {
      setRunCard(undefined);
    }
  };


  const set = (key: keyof typeof filters) => (value: string) =>
    setFilters((f) => ({ ...f, [key]: value }));

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Select
          className="w-40"
          value={filters.workflow}
          onValueChange={set('workflow')}
          options={[{ value: '', label: 'all workflows' }, ...catalog.map((s) => ({ value: s.id, label: s.id }))]}
        />
        <Select
          className="w-28"
          value={filters.level}
          onValueChange={set('level')}
          options={[
            { value: '', label: 'all levels' },
            { value: 'debug', label: 'debug' },
            { value: 'info', label: 'info' },
            { value: 'warn', label: 'warn' },
            { value: 'error', label: 'error' },
          ]}
        />
        <Select
          className="w-32"
          value={filters.kind}
          onValueChange={set('kind')}
          options={[
            { value: '', label: 'logs + events' },
            { value: 'log', label: 'logs' },
            { value: 'event', label: 'events' },
          ]}
        />
        <Input className="w-28" placeholder="node id" value={filters.node}
          onChange={(e) => set('node')(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void load(filters)} />
        <Input className="w-36" placeholder="run id" value={filters.run}
          onChange={(e) => set('run')(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void load(filters)} />
        <Input className="w-40" placeholder="search text" value={filters.q}
          onChange={(e) => set('q')(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void load(filters)} />
        <Button variant="primary" onClick={() => void load(filters)}>Filter</Button>
        <Button variant={live ? 'primary' : 'secondary'} onClick={toggleLive}>{live ? 'Live ●' : 'Live'}</Button>
        <span className="text-[11px] text-muted-foreground">{meta}</span>
      </div>

      {rows.length === 0
        ? <Empty>Nothing matches. Loosen a filter, or run something.</Empty>
        : (
          <RowList>
            <RowHead
              template={LOG_COLUMNS}
              cells={['time', 'level', 'workflow', 'node', 'event', 'target', 'took']}
            />
            {rows.map((row, i) => (
              <Row
                key={i}
                template={LOG_COLUMNS}
                onClick={() => void openRow(row)}
                cells={[
                  <span key="t" className="text-muted-foreground">{new Date(row.at).toLocaleTimeString()}</span>,
                  <span key="l" className={cn(
                    row.level === 'error' ? 'text-bad' : row.level === 'warn' ? 'text-warn' : 'text-muted-foreground',
                  )}>{row.level ?? row.kind}</span>,
                  <span key="w" className="text-muted-foreground">{row.scenarioId}</span>,
                  <span key="n">{row.node ?? ''}</span>,
                  <span key="e" title={row.detail || undefined}>
                    {row.event}
                    {row.detail && <span className="text-muted-foreground"> · {row.detail}</span>}
                  </span>,
                  <span key="g" className="text-muted-foreground">{row.tool ?? row.agent ?? row.model ?? ''}</span>,
                  <span key="d" className="text-muted-foreground">
                    {row.durationMs !== undefined ? `${row.durationMs}ms` : ''}
                  </span>,
                ]}
              />
            ))}
          </RowList>
        )}

      <Drawer open={selected !== undefined} onClose={() => setSelected(undefined)}
        title={selected && <span>{selected.event} <span className="text-muted-foreground">· {shortId(selected.runId)}</span></span>}>
        {selected && (
          <>
            <PayloadSection row={selected} />
            <Section title="Run">
              {!runCard ? <Empty>No artifacts for this run.</Empty> : (
                <>
                  <Facts rows={[
                    ['workflow', runCard.scenarioId],
                    ['status', <Badge key="s" tone={statusTone(runCard.status ?? '')}>{runCard.status ?? '?'}</Badge>],
                    ['duration', runCard.durationMs !== undefined ? `${runCard.durationMs}ms` : '—'],
                    ['tokens', String(runCard.usage.totalTokens)],
                    ['evals', `${runCard.evals.filter((e) => e.passed).length}/${runCard.evals.length}`],
                    ['params', <pre key="p" className="text-[10px]">{JSON.stringify(runCard.params)}</pre>],
                    ...(runCard.traceId ? [['trace', runCard.traceId] as [string, string]] : []),
                  ]} />
                  <div className="mt-3 flex gap-2">
                    <Button onClick={() => {
                      setSelected(undefined);
                      const next = { ...filters, run: selected.runId };
                      setFilters(next);
                      void load(next);
                    }}>Only this run</Button>
                  </div>
                </>
              )}
            </Section>
          </>
        )}
      </Drawer>

    </div>
  );
}

/**
 * Well-known fields worth surfacing above the tree, wherever they sit. A
 * `workflow:complete` keeps them one level down inside `state`, which is
 * exactly the burial this answers.
 */
const HIGHLIGHTS: Array<[string, string[]]> = [
  ['status', ['status', 'state.status']],
  ['duration', ['duration_ms']],
  ['iterations', ['state.iteration_count']],
  ['tokens', ['state.total_tokens_used', 'tokens']],
  ['cost', ['state.total_cost_usd']],
  ['node', ['node_id']],
  ['tool', ['tool_name']],
  ['error', ['error', 'state.last_error']],
];

function at(source: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>(
    (value, key) => (value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined),
    source,
  );
}

function PayloadSection({ row }: { row: LogRow }) {
  const [filter, setFilter] = useState('');
  const [copied, setCopied] = useState(false);
  const raw = row.raw;

  const facts: Array<[string, ReactNode]> = [];
  for (const [label, paths] of HIGHLIGHTS) {
    for (const path of paths) {
      const value = at(raw, path);
      if (value === undefined || value === null || typeof value === 'object') continue;
      facts.push([label, label === 'duration' ? `${String(value)}ms` : String(value)]);
      break;
    }
  }

  const visited = at(raw, 'state.visited_nodes');
  if (Array.isArray(visited) && visited.length > 0) facts.push(['path', visited.join(' → ')]);

  const memory = at(raw, 'state.memory');
  if (memory && typeof memory === 'object') {
    facts.push(['memory keys', Object.keys(memory as Record<string, unknown>).join(', ') || '—']);
  }

  return (
    <>
      {facts.length > 0 && (
        <Section title="Highlights">
          <Facts rows={facts} />
        </Section>
      )}
      <Section
        title="Payload"
        actions={
          <div className="flex items-center gap-2">
            <Input
              className="h-7 w-40"
              placeholder="filter keys/values"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <Button onClick={async () => {
              await navigator.clipboard.writeText(JSON.stringify(raw, null, 2));
              setCopied(true);
            }}>{copied ? 'Copied' : 'Copy JSON'}</Button>
          </div>
        }
      >
        <JsonView value={raw} filter={filter} />
      </Section>
    </>
  );
}
