'use client';

/**
 * Runs: every run as an object. Artifact-recorded runs with their full
 * cards (params, evals, usage) merged with database rows — including runs
 * other processes recorded, which the studio never drove. The drawer holds
 * the run's facts, the event-log timeline with fork-from-boundary, import
 * for external rows, and the pivot into the Logs stream.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, post, shortId, when, type CatalogEntry, type DbRun } from '../../lib/api';
import { JsonView } from '../../components/json-view';
import {
  Badge, Button, Drawer, Empty, Facts, Input, Row, RowHead, RowList,
  Section, Select, StatusText, statusTone,
} from '../../components/primitives';

interface ArtifactRun {
  scenarioId: string;
  runId: string;
  params: unknown;
  status?: string;
  startedAt: string;
  durationMs?: number;
  tokens: number;
  costUsd: number;
  passed: number;
  total: number;
}

interface RunRow {
  runId: string;
  workflow?: string;
  status: string;
  startedAt?: string;
  durationMs?: number;
  tokens?: number;
  evals?: string;
  source: 'artifacts' | 'external';
  params?: unknown;
  runKind?: string;
}

const RUN_COLUMNS = '150px minmax(120px, 1fr) 80px 90px 90px 70px 60px 100px';

interface DbRunDetail {
  run: { runId: string; graphId: string; status: string };
  graphName: string | null;
  timeline: Array<{ sequenceId: number; type: string; nodeId?: string }>;
  forkPoints: Array<{ beforeNode: string; occurrence: number }>;
}

export default function RunsPage() {
  const [rows, setRows] = useState<RunRow[] | undefined>();
  const [durable, setDurable] = useState(true);
  const [workflow, setWorkflow] = useState('');
  const [failedOnly, setFailedOnly] = useState(false);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [selected, setSelected] = useState<RunRow | undefined>();

  const load = useCallback(async () => {
    const query = new URLSearchParams({ limit: '60' });
    if (workflow) query.set('scenario', workflow);
    if (failedOnly) query.set('failed', 'true');
    const [artifacts, db] = await Promise.all([
      api<{ runs: ArtifactRun[] }>(`/api/history?${query}`),
      api<{ runs: DbRun[]; durable: boolean }>('/api/db/runs?limit=60').catch(() => ({ runs: [], durable: false })),
    ]);
    setDurable(db.durable);

    const merged = new Map<string, RunRow>();
    for (const run of db.runs) {
      if (run.parentRunId) continue;
      merged.set(run.runId, {
        runId: run.runId,
        status: run.status,
        startedAt: run.createdAt,
        source: 'external',
        ...(run.runKind ? { runKind: run.runKind } : {}),
      });
    }
    for (const run of artifacts.runs) {
      merged.set(run.runId, {
        runId: run.runId,
        workflow: run.scenarioId,
        status: run.status ?? 'running',
        startedAt: run.startedAt,
        durationMs: run.durationMs,
        tokens: run.tokens,
        evals: run.total > 0 ? `${run.passed}/${run.total}` : undefined,
        source: 'artifacts',
        params: run.params,
      });
    }
    if (workflow || failedOnly) {
      for (const [id, row] of merged) {
        if (row.source === 'external') merged.delete(id);
      }
    }
    setRows([...merged.values()].sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? '')));
  }, [workflow, failedOnly]);

  useEffect(() => {
    void api<{ scenarios: CatalogEntry[] }>('/api/scenarios').then((b) => setCatalog(b.scenarios));
  }, []);
  useEffect(() => { void load(); }, [load]);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Select
          className="w-44"
          value={workflow}
          onValueChange={setWorkflow}
          options={[{ value: '', label: 'all workflows' }, ...catalog.map((s) => ({ value: s.id, label: s.id }))]}
        />
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input type="checkbox" checked={failedOnly} onChange={(e) => setFailedOnly(e.target.checked)} />
          failed only
        </label>
        <Button onClick={() => void load()}>Refresh</Button>
      </div>

      {!durable && (
        <p className="mb-3 text-[11px] text-warn">
          No database connected — external rows are limited to this process&apos;s runs since startup.
          Start Postgres (and restart serve) to see runs from other processes.
        </p>
      )}

      {!rows ? <Empty>loading…</Empty> : rows.length === 0 ? <Empty>No runs recorded yet. Run something.</Empty> : (
        <RowList>
          <RowHead template={RUN_COLUMNS} cells={['started', 'workflow', 'run', 'status', 'duration', 'tokens', 'evals', 'source']} />
          {rows.map((row) => (
            <Row
              key={row.runId}
              template={RUN_COLUMNS}
              onClick={() => setSelected(row)}
              cells={[
                <span key="t" className="text-muted-foreground">{when(row.startedAt)}</span>,
                row.workflow ?? '—',
                <span key="r" className="text-muted-foreground">{shortId(row.runId)}</span>,
                <StatusText key="s" status={row.status} />,
                <span key="d" className="text-muted-foreground">{row.durationMs !== undefined ? `${row.durationMs}ms` : '—'}</span>,
                <span key="k" className="text-muted-foreground">{row.tokens ?? '—'}</span>,
                <span key="e" className="text-muted-foreground">{row.evals ?? '—'}</span>,
                <span key="o" className="text-muted-foreground">{row.source}{row.runKind ? ` · ${row.runKind}` : ''}</span>,
              ]}
            />
          ))}
        </RowList>
      )}

      <Drawer open={selected !== undefined} onClose={() => setSelected(undefined)}
        title={selected && <span>{selected.workflow ?? 'run'} <span className="text-muted-foreground">{shortId(selected.runId)}</span></span>}>
        {selected && <RunDrawer row={selected} refresh={load} />}
      </Drawer>
    </div>
  );
}

function RunDrawer({ row, refresh }: { row: RunRow; refresh: () => Promise<void> }) {
  const router = useRouter();
  const [detail, setDetail] = useState<DbRunDetail | undefined>();
  const [detailError, setDetailError] = useState<string | undefined>();

  useEffect(() => {
    api<DbRunDetail>(`/api/db/run?id=${encodeURIComponent(row.runId)}`)
      .then(setDetail)
      .catch((err: Error) => setDetailError(err.message));
  }, [row.runId]);

  return (
    <>
      <Facts rows={[
        ['status', <Badge key="s" tone={statusTone(row.status)}>{row.status}</Badge>],
        ['started', when(row.startedAt)],
        ...(row.durationMs !== undefined ? [['duration', `${row.durationMs}ms`] as [string, string]] : []),
        ...(row.tokens !== undefined ? [['tokens', String(row.tokens)] as [string, string]] : []),
        ...(row.evals ? [['evals', row.evals] as [string, string]] : []),
        ...(row.params && Object.keys(row.params as Record<string, unknown>).length > 0
          ? [['params', <JsonView key="p" value={row.params} />] as [string, React.ReactNode]]
          : []),
        ['source', row.source],
      ]} />
      <div className="my-3 flex gap-2">
        <Button onClick={() => {
          sessionStorage.setItem('pivotRun', row.runId);
          router.push('/logs/');
        }}>Logs for this run</Button>
        {row.source === 'external' && <ImportButton runId={row.runId} onDone={refresh} />}
      </div>

      {detailError ? (
        <Empty>No event log for this run in the connected store: {detailError}</Empty>
      ) : !detail ? (
        <Empty>loading timeline…</Empty>
      ) : (
        <>
          <ForkControls detail={detail} />
          <Section title="Timeline">
            <table className="w-full font-mono text-xs">
              <tbody>
                {detail.timeline.map((event) => (
                  <tr key={event.sequenceId} className="border-b border-border/50 last:border-0">
                    <td className="w-10 py-1 text-muted-foreground">{event.sequenceId}</td>
                    <td className="pr-2">{event.type}</td>
                    <td className="text-muted-foreground">{event.nodeId ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        </>
      )}
    </>
  );
}

function ImportButton({ runId, onDone }: { runId: string; onDone: () => Promise<void> }) {
  const [label, setLabel] = useState('Import to artifacts');
  return (
    <Button disabled={label !== 'Import to artifacts'} onClick={async () => {
      setLabel('importing…');
      try {
        const outcome = await post<{ imported: boolean; workflow?: string; reason?: string }>('/api/db/import', { runId });
        setLabel(outcome.imported ? `→ ${outcome.workflow}` : (outcome.reason ?? 'failed'));
        await onDone();
      } catch (err) {
        setLabel(err instanceof Error ? err.message : 'failed');
      }
    }}>{label}</Button>
  );
}

function ForkControls({ detail }: { detail: DbRunDetail }) {
  const [at, setAt] = useState('');
  const [promptNode, setPromptNode] = useState('');
  const [promptText, setPromptText] = useState('');
  const [outcome, setOutcome] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const fork = async () => {
    setBusy(true);
    setOutcome(undefined);
    const [beforeNode, occurrence] = at ? at.split(':') : [undefined, undefined];
    try {
      const result = await post<{ runId: string; status: string; forkNodeId?: string; memoHits: number }>('/api/db/fork', {
        runId: detail.run.runId,
        ...(beforeNode ? { beforeNode, occurrence: Number(occurrence) } : {}),
        ...(promptNode && promptText ? { prompt: { node: promptNode, text: promptText } } : {}),
      });
      setOutcome(`variant ${shortId(result.runId)} → ${result.status} (from ${result.forkNodeId ?? '?'}, ${result.memoHits} memoized)`);
    } catch (err) {
      setOutcome(err instanceof Error ? err.message : String(err));
    }
    setBusy(false);
  };

  return (
    <Section title="Fork">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={at}
          onValueChange={setAt}
          options={[
            { value: '', label: 'at the failure / default' },
            ...detail.forkPoints.map((p) => ({
              value: `${p.beforeNode}:${p.occurrence}`,
              label: `${p.beforeNode} (occurrence ${p.occurrence})`,
            })),
          ]}
        />
        <Input className="w-32" placeholder="prompt: node id" value={promptNode} onChange={(e) => setPromptNode(e.target.value)} />
        <Input className="w-48" placeholder="new system prompt" value={promptText} onChange={(e) => setPromptText(e.target.value)} />
        <Button variant="primary" disabled={busy} onClick={() => void fork()}>{busy ? 'forking…' : 'Fork'}</Button>
      </div>
      {outcome && <p className="mt-2 text-xs">{outcome}</p>}
    </Section>
  );
}
