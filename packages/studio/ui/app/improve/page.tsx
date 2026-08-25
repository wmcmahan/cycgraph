'use client';

/**
 * Improve: a guided loop, one workflow at a time.
 *
 * The page is ordered by procedure rather than by data — record, measure,
 * review, adopt — because "what do I do next" was the question the old
 * board of parallel sections never answered. Each step states what it is
 * for, where the chosen workflow stands, and the single action available.
 * The watcher, the tick log, the whole ledger, and the studio's own
 * sessions sit underneath as background rather than as the entry point.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import {
  api, post, readSse, shortId, when,
  type ImproveSession, type LoopStatus, type Proposal, type Readiness, type Tick, type WatchState, type WireGraph,
} from '../../lib/api';
import {
  Badge, Button, Drawer, Empty, Facts, Row, RowHead, RowList,
  Section, Select, StatusText, statusTone,
} from '../../components/primitives';
import { GraphView } from '../../components/graph-view';
import { cn } from '../../lib/utils';

const PROPOSAL_COLUMNS = 'minmax(240px, 1fr) 260px 90px 170px';
const SESSION_COLUMNS = '170px minmax(120px, 1fr) 100px 90px 80px';

const ACTIONS: Record<string, Array<[string, string]>> = {
  proposed: [['trial', 'Trial'], ['apply', 'Apply to source']],
  trial: [['apply', 'Apply to source'], ['revert', 'Back to proposed']],
  pr: [['merged', 'Merged'], ['revert', 'Back to proposed']],
  applied: [['revert', 'Revert']],
  reverted: [],
};

/** Statuses that mean a proposal is still the workflow's open question. */
const OPEN = new Set(['proposed', 'trial', 'pr']);

export default function ImprovePage() {
  const router = useRouter();
  const [workflow, setWorkflow] = useState('');
  const [readiness, setReadiness] = useState<Readiness[] | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  const [watch, setWatch] = useState<WatchState | undefined>();
  const [ticks, setTicks] = useState<Tick[]>([]);
  const [sessions, setSessions] = useState<ImproveSession[]>([]);
  const [selected, setSelected] = useState<Proposal | undefined>();
  const [session, setSession] = useState<ImproveSession | undefined>();
  const [measuring, setMeasuring] = useState(false);
  const [measureLines, setMeasureLines] = useState<string[] | undefined>();
  const [ticking, setTicking] = useState(false);
  const [loop, setLoop] = useState<LoopStatus | undefined>();
  const [autonomy, setAutonomy] = useState('apply');
  const [senseLines, setSenseLines] = useState<string[] | undefined>();

  // Fetched independently: one route failing (an older server without the
  // readiness endpoint, say) must degrade that panel, not blank the page.
  const refresh = useCallback(async () => {
    const [watchBody, readyBody, tickBody, sessionBody] = await Promise.all([
      api<WatchState>('/api/watch').catch(() => undefined),
      api<{ readiness: Readiness[] }>('/api/improve/readiness')
        .catch((err: Error) => { setLoadError(err.message); return undefined; }),
      api<{ ticks: Tick[] }>('/api/watch/history?limit=25').catch(() => undefined),
      api<{ sessions: ImproveSession[] }>('/api/improve/sessions?limit=25').catch(() => undefined),
    ]);
    if (watchBody) {
      setWatch(watchBody);
      setSelected((current) => current && watchBody.proposals.find((p) => p.id === current.id));
    }
    if (tickBody) setTicks(tickBody.ticks);
    if (sessionBody) setSessions(sessionBody.sessions);
    if (!readyBody) return;

    setLoadError(undefined);
    setReadiness(readyBody.readiness);
    // A workflow awaiting review outranks one merely ready to measure: a
    // proposal is the page's open question, and holding one makes a workflow
    // `ready: false`, so ranking by readiness alone hides exactly the
    // workflow someone arriving at this page came to look at.
    setWorkflow((current) => current || sessionStorage.getItem('improveWorkflow')
      || readyBody.readiness.find((r) => r.openProposals.length > 0)?.workflow
      || readyBody.readiness.find((r) => r.ready)?.workflow
      || readyBody.readiness[0]?.workflow
      || '');
    sessionStorage.removeItem('improveWorkflow');
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    const poll = () => api<LoopStatus>('/api/loop').then(setLoop).catch(() => undefined);
    void poll();
    // While a loop runs it is the page's live subject; when idle this is
    // cheap enough to keep the start button honest about availability.
    const timer = setInterval(() => { void poll(); }, loop?.running ? 2000 : 8000);
    return () => clearInterval(timer);
  }, [loop?.running]);

  const measure = async () => {
    if (!workflow) return;
    setMeasuring(true);
    setMeasureLines([`measuring ${workflow}…`]);
    const push = (line: string) => setMeasureLines((l) => [...(l ?? []), line]);
    try {
      const response = await fetch('/api/tune', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scenario: workflow }),
      });
      await readSse(response, (event, payload) => {
        if (event === 'line') push(String(payload.message));
        else if (event === 'error') push(`✗ ${String(payload.message)}`);
        else if (event === 'done') {
          push(payload.skipped
            ? String(payload.skipped)
            : Array.isArray(payload.saved) && payload.saved.length > 0
              ? `proposed ${payload.saved.length}: ${(payload.saved as string[]).join(', ')}`
              : `${String(payload.forks)} fork(s) measured — nothing beat the current settings`);
        }
      });
    } finally {
      setMeasuring(false);
      void refresh();
    }
  };

  const tickNow = async () => {
    setTicking(true);
    try {
      await post('/api/watch/tick', {});
    } finally {
      setTicking(false);
      void refresh();
    }
  };

  const sense = async () => {
    setSenseLines(['measuring the studio\u2019s own sessions…']);
    const push = (line: string) => setSenseLines((l) => [...(l ?? []), line]);
    const response = await fetch('/api/improve/tune', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ save: true }),
    });
    await readSse(response, (event, payload) => {
      if (event === 'line') push(String(payload.message));
      else if (event === 'error') push(`✗ ${String(payload.message)}`);
      else if (event === 'done') push(payload.skipped
        ? String(payload.skipped)
        : `${String(payload.forks)} fork(s)${Array.isArray(payload.saved) && payload.saved.length ? ` · saved ${payload.saved.length}` : ''}`);
    });
    void refresh();
  };

  const ready = readiness?.find((entry) => entry.workflow === workflow);
  const proposals = (watch?.proposals ?? []).filter((p) => p.workflow === workflow);
  const open = proposals.find((p) => OPEN.has(p.status));
  const adopted = proposals.find((p) => p.status === 'applied');
  const current = open ?? adopted;

  const recorded = (ready?.freshRuns ?? 0) >= (ready?.floor ?? 5);
  const step = !recorded ? 1 : !current ? 2 : current.status === 'proposed' ? 3 : 4;

  return (
    <div>
      <LoopBand
        loop={loop}
        workflow={workflow}
        autonomy={autonomy}
        onAutonomy={setAutonomy}
        onStart={async () => {
          await post('/api/loop/start', { scenario: workflow, autonomy });
          setLoop(await api<LoopStatus>('/api/loop'));
        }}
        onStop={async () => {
          await post('/api/loop/stop', {});
          setLoop(await api<LoopStatus>('/api/loop'));
        }}
        onRefresh={refresh}
      />

      {loadError ? (
        <div className="mb-8 rounded-md bg-bad-bg p-4 text-xs">
          <p className="mb-1 text-sm text-bad">The studio could not read workflow readiness.</p>
          <p className="text-muted-foreground">
            {loadError} — if this server was started before the readiness endpoint existed, restart it.
          </p>
        </div>
      ) : readiness === undefined ? (
        <p className="mb-8 text-xs text-muted-foreground">loading workflows…</p>
      ) : readiness.length === 0 ? (
        <NoWorkflows />
      ) : (
      <>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Select
          className="w-56"
          value={workflow}
          onValueChange={setWorkflow}
          placeholder="choose a workflow"
          options={(readiness ?? []).map((entry) => ({ value: entry.workflow, label: entry.workflow }))}
        />
        <p className="text-xs text-muted-foreground">
          The studio improves a workflow by re-running its recorded history with one setting changed,
          and keeping the change only if your evals still hold.
        </p>
      </div>

      {!workflow ? <Empty>Choose a workflow to improve.</Empty> : (
        <div className="mb-8 space-y-2">
          <Step
            n={1}
            title="Record runs"
            state={step > 1 ? 'done' : 'current'}
            blurb="Measurement forks runs you already made, so there has to be a corpus to fork."
            status={ready ? `${ready.freshRuns} of ${ready.floor} runs since the last accepted change` : '—'}
            action={step === 1 && (
              <Button variant="primary" onClick={() => {
                sessionStorage.setItem('runWorkflow', workflow);
                router.push('/scenarios/');
              }}>
                Run this workflow
              </Button>
            )}
          />
          <Step
            n={2}
            title="Measure"
            state={step > 2 ? 'done' : step === 2 ? 'current' : 'waiting'}
            blurb="Forks the corpus with one knob changed at a time and scores every variant against your evals."
            status={ready?.missing.length
              ? `blocked: needs ${ready.missing.join(', ')}`
              : step > 2 ? 'measured — a proposal is waiting below' : step === 2 ? 'ready to measure' : 'waiting on runs'}
            action={step === 2 && (
              <Button variant="primary" disabled={measuring || (ready?.missing.length ?? 0) > 0} onClick={() => void measure()}>
                {measuring ? 'measuring…' : 'Measure now'}
              </Button>
            )}
          />
          <Step
            n={3}
            title="Review what it found"
            state={step > 3 ? 'done' : step === 3 ? 'current' : 'waiting'}
            blurb="A proposal carries its evidence: every variant it ran, the deltas, and whether the assertions held."
            status={current
              ? `${current.knob} ${String(current.from)} → ${String(current.to)} · −${Math.round(current.computeDelta * 100)}% time, −${Math.round(current.tokenDelta * 100)}% tokens`
              : 'nothing proposed yet'}
            action={current && (
              <Button variant={step === 3 ? 'primary' : 'secondary'} onClick={() => setSelected(current)}>
                Open evidence
              </Button>
            )}
          />
          <Step
            n={4}
            title="Adopt it"
            state={step === 4 ? 'current' : 'waiting'}
            blurb="Trial runs it as a reversible overlay; applying edits your source on a branch and hands you the PR script."
            status={current ? `currently ${current.status}` : 'nothing to adopt yet'}
            action={current && (ACTIONS[current.status] ?? []).length > 0 && (
              <Button variant="primary" onClick={() => setSelected(current)}>Open actions</Button>
            )}
          />
        </div>
      )}

      </>
      )}

      <details className="mb-4">
        <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Automation and history
        </summary>
        <div className="mt-4">
          <Section title="Watcher" actions={
            <Button disabled={ticking} onClick={() => void tickNow()}>{ticking ? 'ticking…' : 'Tick now'}</Button>
          }>
            <p className="mb-1 text-xs text-muted-foreground">
              Instead of measuring one workflow by hand, a tick sweeps every workflow, measures the first
              that is ready, and files what it finds.
            </p>
            <p className="text-xs text-muted-foreground">
              {!watch?.watcher ? 'no watcher' : (
                <>
                  {watch.watcher.running ? 'tick running…' : watch.watcher.lastTickAt ? `last tick ${when(watch.watcher.lastTickAt)}` : 'no tick yet'}
                  {' · '}
                  {watch.watcher.auto
                    ? `auto (${watch.watcher.pendingRuns} run(s) toward the next tick)`
                    : 'manual — restart serve with --watch for automatic ticks'}
                  {watch.watcher.lastError && <span className="text-bad"> · {watch.watcher.lastError}</span>}
                </>
              )}
            </p>
          </Section>

          <Section title="All workflows">
            {!readiness?.length ? <Empty>No workflows in this catalog.</Empty> : (
              <RowList>
                <RowHead template="minmax(160px, 1fr) 110px minmax(180px, 1.2fr)" cells={['workflow', 'corpus', 'state']} />
                {readiness.map((entry) => (
                  <Row
                    key={entry.workflow}
                    template="minmax(160px, 1fr) 110px minmax(180px, 1.2fr)"
                    onClick={() => setWorkflow(entry.workflow)}
                    cells={[
                      entry.workflow,
                      <span key="c" className={entry.ready ? 'text-ok' : 'text-muted-foreground'}>
                        {entry.freshRuns}/{entry.floor} runs
                      </span>,
                      <span key="d" className="text-muted-foreground">{entry.detail}</span>,
                    ]}
                  />
                ))}
              </RowList>
            )}
          </Section>

          <Section title="Every proposal">
            {!watch || watch.proposals.length === 0 ? <Empty>No proposals recorded.</Empty> : (
              <RowList>
                <RowHead template={PROPOSAL_COLUMNS} cells={['proposal', 'measured', 'status', 'since']} />
                {watch.proposals.map((p) => (
                  <Row
                    key={p.id}
                    template={PROPOSAL_COLUMNS}
                    onClick={() => setSelected(p)}
                    cells={[
                      `${p.workflow} · ${p.knob} ${String(p.from)} → ${String(p.to)}`,
                      <span key="m" className="text-muted-foreground">
                        −{Math.round(p.computeDelta * 100)}% time, −{Math.round(p.tokenDelta * 100)}% tokens
                      </span>,
                      <span key="s" className={p.status === 'applied' ? 'text-ok' : p.status === 'reverted' ? 'text-muted-foreground' : 'text-warn'}>
                        {p.status}
                      </span>,
                      <span key="w" className="text-muted-foreground">{when(p.statusChangedAt)}</span>,
                    ]}
                  />
                ))}
              </RowList>
            )}
          </Section>

          <Section title="Tick history">
            {ticks.length === 0 ? <Empty>No ticks recorded yet.</Empty> : (
              <div>
                {ticks.map((tick, i) => {
                  const interesting = tick.rows.filter((r) => r.outcome !== 'quiet');
                  const proposed = tick.rows.filter((r) => r.outcome === 'proposed').length;
                  const forks = tick.rows.reduce((sum, r) => sum + r.forks, 0);
                  return (
                    <details key={i} className="border-b border-border/50 last:border-0">
                      <summary className="cursor-pointer px-3 py-1.5 text-xs">
                        <span className="text-muted-foreground">{when(tick.at)}</span>
                        {' · '}
                        {proposed > 0
                          ? <span className="text-ok">{proposed} proposed</span>
                          : interesting.length > 0 ? `${interesting.length} workflow(s) considered` : 'all quiet'}
                        {forks > 0 && <span className="text-muted-foreground"> ({forks} fork(s))</span>}
                      </summary>
                      <table className="w-full border-t border-border/50 text-xs">
                        <tbody>
                          {tick.rows.filter((r) => r.outcome !== 'quiet' || interesting.length === 0).map((row, j) => (
                            <tr key={j} className="border-b border-border/40 last:border-0">
                              <td className="px-3 py-1">{row.workflow}</td>
                              <td className="pr-3">{row.outcome}</td>
                              <td className="pr-3 text-muted-foreground">{row.detail}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </details>
                  );
                })}
              </div>
            )}
          </Section>

          <Section
            title="The studio's own sessions"
            actions={<Button onClick={() => void sense()}>Measure the studio</Button>}
          >
            <p className="mb-2 text-xs text-muted-foreground">
              Self-hosting: recorded `studio improve` sessions, treated as a workflow the loop can tune.
              Nothing here affects your workflows.
            </p>
            {sessions.length === 0 ? <Empty>No improve sessions recorded.</Empty> : (
              <RowList>
                <RowHead template={SESSION_COLUMNS} cells={['started', 'target', 'status', 'duration', 'tokens']} />
                {sessions.map((s) => (
                  <Row
                    key={s.runId}
                    template={SESSION_COLUMNS}
                    onClick={() => setSession(s)}
                    cells={[
                      <span key="t" className="text-muted-foreground">{when(s.startedAt)}</span>,
                      s.params?.target ?? '?',
                      <StatusText key="s" status={s.status} />,
                      <span key="d" className="text-muted-foreground">{s.durationMs ? `${Math.round(s.durationMs / 1000)}s` : '—'}</span>,
                      <span key="k" className="text-muted-foreground">{s.usage?.totalTokens ?? 0}</span>,
                    ]}
                  />
                ))}
              </RowList>
            )}
            {senseLines && (
              <pre className="mt-2 max-h-56 w-full overflow-auto rounded-md bg-muted/40 p-3 text-[12px] leading-relaxed">
                {senseLines.join('\n')}
              </pre>
            )}
          </Section>
        </div>
      </details>

      {measureLines && (
        <pre className="mb-6 max-h-56 w-full overflow-auto rounded-md bg-muted/40 p-3 text-[12px] leading-relaxed">
          {measureLines.join('\n')}
        </pre>
      )}

      <Drawer open={selected !== undefined} onClose={() => setSelected(undefined)}
        title={selected && <span>{selected.workflow} · {selected.knob} {String(selected.from)} → {String(selected.to)}</span>}>
        {selected && <ProposalDrawer proposal={selected} refresh={refresh} />}
      </Drawer>

      <Drawer open={session !== undefined} onClose={() => setSession(undefined)}
        title={session && <span>improve session <span className="text-muted-foreground">{shortId(session.runId)}</span></span>}>
        {session && <SessionDrawer session={session} />}
      </Drawer>
    </div>
  );
}

/**
 * What to say when the catalog is empty. Without declared workflows there
 * is nothing to improve, and an inert picker is a worse answer than
 * naming the two ways to declare one.
 */
function NoWorkflows() {
  return (
    <div className="mb-8 rounded-md bg-muted/30 p-4 text-xs">
      <p className="mb-2 text-sm text-foreground">No workflows are declared, so there is nothing to improve yet.</p>
      <p className="mb-3 text-muted-foreground">
        The studio improves workflows it can rebuild — it re-runs their recorded history with one
        setting changed. Declare yours one of two ways:
      </p>
      <pre className="mb-3 w-full overflow-auto rounded-md bg-muted/40 p-3 leading-relaxed">{`// cycgraph.config.ts, in your project root
export default {
  graphs: ['./graphs/my-flow.ts'],
};`}</pre>
      <p className="text-muted-foreground">
        …or load one for a single session: <code className="text-foreground">studio serve --load ./graphs/my-flow.ts</code>
      </p>
    </div>
  );
}

/**
 * The unattended loop: run, measure, adopt, stop at a diff. It is the
 * same ladder the steps below walk by hand, driven on its own and halted
 * wherever the chosen autonomy says a person should look.
 */
function LoopBand({
  loop,
  workflow,
  autonomy,
  onAutonomy,
  onStart,
  onStop,
  onRefresh,
}: {
  loop?: LoopStatus;
  workflow: string;
  autonomy: string;
  onAutonomy: (value: string) => void;
  onStart: () => Promise<void>;
  onStop: () => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const applied = loop?.result?.applied;

  return (
    <div className="mb-6 rounded-md bg-muted/30 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm">Self-improve</span>
        <Select
          className="w-64"
          value={autonomy}
          onValueChange={onAutonomy}
          options={[
            { value: 'propose', label: 'measure and propose, then stop' },
            { value: 'trial', label: '…and put the winner on trial' },
            { value: 'apply', label: '…and commit it to a branch for review' },
          ]}
        />
        {loop?.running ? (
          <Button onClick={async () => { setBusy(true); await onStop(); setBusy(false); }} disabled={busy}>
            Stop
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={!workflow || busy}
            onClick={async () => { setBusy(true); await onStart(); setBusy(false); }}
          >
            Start on {workflow || 'a workflow'}
          </Button>
        )}
        <span className="text-xs text-muted-foreground">
          {loop?.running
            ? `running on ${loop.workflow} — it runs the workflow, measures, and stops where you asked`
            : loop?.result
              ? loop.result.stoppedBecause
              : 'runs the workflow until it can be measured, then climbs as far as you allow'}
        </span>
      </div>

      {loop?.error && <p className="mt-2 text-xs text-bad">{loop.error}</p>}
      {loop?.result?.applyError && (
        <p className="mt-2 text-xs text-warn">
          The change was refused before it could be committed: {loop.result.applyError}. The proposal stays
          on trial — retry it, or take it back.
        </p>
      )}

      {loop && loop.events.length > 0 && (
        <pre className="mt-3 max-h-48 w-full overflow-auto rounded-md bg-muted/40 p-3 text-[12px] leading-relaxed">
          {loop.events.map((event) => event.message).join('\n')}
        </pre>
      )}

      {applied && (
        <div className="mt-3">
          <p className="mb-1 text-xs">
            Committed to <span className="text-foreground">{applied.branch}</span> in {applied.repoRoot}
            {applied.fixture && ' (a throwaway fixture — the studio does not track your source)'}
          </p>
          <pre className="max-h-72 w-full overflow-auto rounded-md bg-muted/40 p-3 text-[12px] leading-relaxed">{applied.diff}</pre>
          <div className="mt-2 flex items-center gap-2">
            <Button onClick={async () => { await navigator.clipboard.writeText(applied.prCommand); }}>
              Copy PR script
            </Button>
            <Button onClick={() => void onRefresh()}>Refresh</Button>
            <span className="text-xs text-muted-foreground">Pushing and merging stay yours.</span>
          </div>
        </div>
      )}
    </div>
  );
}

/** One rung of the guided flow: where it stands, what it is for, what to press. */
function Step({
  n,
  title,
  state,
  blurb,
  status,
  action,
}: {
  n: number;
  title: string;
  state: 'done' | 'current' | 'waiting';
  blurb: string;
  status: ReactNode;
  action?: ReactNode | false;
}) {
  return (
    <div className={cn(
      'grid grid-cols-[28px_1fr_auto] items-start gap-3 rounded-md p-3',
      state === 'current' ? 'bg-muted/40 ring-1 ring-primary/30' : 'bg-muted/15',
    )}>
      <span className={cn(
        'flex size-6 items-center justify-center rounded-full text-xs',
        state === 'done' ? 'bg-ok-bg text-ok'
          : state === 'current' ? 'bg-primary text-primary-foreground'
            : 'bg-muted text-muted-foreground',
      )}>
        {state === 'done' ? '✓' : n}
      </span>
      <div className="min-w-0">
        <div className={cn('text-sm', state === 'waiting' && 'text-muted-foreground')}>{title}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">{blurb}</div>
        <div className={cn('mt-1 text-xs', state === 'current' ? 'text-foreground' : 'text-muted-foreground')}>{status}</div>
      </div>
      <div>{action || null}</div>
    </div>
  );
}

/** An absolute source path elided to its meaningful tail, for display. */
function shortPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length > 5 ? `…/${parts.slice(-5).join('/')}` : path;
}

function ProposalDrawer({ proposal: p, refresh }: { proposal: Proposal; refresh: () => Promise<void> }) {
  const [applyLines, setApplyLines] = useState<string[] | undefined>();
  const [copied, setCopied] = useState(false);

  const act = async (action: string) => {
    if (action === 'apply') {
      setApplyLines(['applying…']);
      const push = (line: string) => setApplyLines((l) => [...(l ?? []), line]);
      const response = await fetch('/api/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: p.id }),
      });
      await readSse(response, (event, payload) => {
        if (event === 'line') push(String(payload.message));
        else if (event === 'error') push(`✗ ${String(payload.message)}`);
        else if (event === 'done') push(`applied → pr on ${String(payload.branch)}`);
      });
      await refresh();
      return;
    }
    await post('/api/proposals/action', { id: p.id, action });
    await refresh();
  };

  return (
    <>
      <Facts rows={[
        ['status', <span key="s"><Badge tone={p.status === 'applied' ? 'ok' : 'warn'}>{p.status}</Badge> <span className="text-muted-foreground">since {when(p.statusChangedAt)}</span></span>],
        ['knob', <span key="k"><span className="text-foreground">{p.knob}</span> on node <span className="text-foreground">{p.nodeId}</span> of {p.workflow}</span>],
        ...(p.sourcePath ? [['source', <code key="src" className="text-xs">{shortPath(p.sourcePath)}</code>] as [string, React.ReactNode]] : []),
        ['measured', `−${Math.round(p.computeDelta * 100)}% execution time, −${Math.round(p.tokenDelta * 100)}% tokens on ${p.model}`],
        ['bases', (p.measuredOn ?? []).map(shortId).join(', ') || '—'],
        ...(p.validation ? [['held-out', <span key="v" className={p.validation.confirmed ? 'text-ok' : 'text-warn'}>{p.validation.detail}</span>] as [string, React.ReactNode]] : []),
        ...(p.combination ? [['combined', p.combination] as [string, string]] : []),
        ...(p.branch ? [['branch', p.branch] as [string, string]] : []),
      ]} />

      <Section title="Change">
        {!p.change?.length ? <Empty>no change recorded on this proposal</Empty> : (
          <div className="space-y-3">
            {p.change.map((c, i) => {
              const target = c.target ?? c.node_id ?? '—';
              const text = typeof c.system_prompt === 'string' ? c.system_prompt : undefined;
              const value = c.model ?? (c.temperature !== undefined ? String(c.temperature) : undefined);
              return (
                <div key={i}>
                  <div className="text-xs text-muted-foreground">
                    {c.kind} of node <span className="text-foreground">{target}</span>
                    {value ? <> → <span className="text-foreground">{value}</span></> : null}
                  </div>
                  {text ? (
                    <pre className="mt-1 whitespace-pre-wrap break-words rounded border border-border/40 bg-muted/30 p-2 text-xs">
                      {text}
                    </pre>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
        <p className="mt-3 text-xs text-muted-foreground/80">
          <span className="text-foreground">Trial</span> runs this as a runtime overlay, so ordinary runs
          pick it up and no file changes.{' '}
          <span className="text-foreground">Apply to source</span> clones the repository, has the editor
          agent rewrite {p.sourcePath ? <code>{shortPath(p.sourcePath)}</code> : 'the workflow’s source'}, gates the
          result on a type-check and a real diff, then commits to a branch. Pushing and opening the PR
          stays yours.
        </p>
      </Section>

      <Section title="Evidence">
        {!p.evidence?.length ? <Empty>no per-variant evidence stored (pre-dates evidence persistence)</Empty> : (
          <table className="w-full text-xs">
            <thead><tr className="text-left text-muted-foreground">
              <th className="py-1 pr-2 font-normal">variant</th><th className="pr-2 font-normal">assertions</th>
              <th className="pr-2 font-normal">time</th><th className="pr-2 font-normal">tokens</th><th />
            </tr></thead>
            <tbody>
              {p.evidence.map((o, i) => (
                <tr key={i} className="border-t border-border/40">
                  <td className="py-1 pr-2">{o.name}</td>
                  <td className={cn('pr-2', o.assertionsHeld ? 'text-ok' : 'text-bad')}>
                    {o.assertionsHeld ? 'held' : `failed ${(o.failed ?? []).join(', ')}`}
                  </td>
                  <td className="pr-2">{o.computeMs}ms</td>
                  <td className="pr-2 text-muted-foreground">{o.tokens}</td>
                  <td className="text-muted-foreground">{o.reused ? 'reused draw' : ''}{o.error ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      {p.diff && (
        <Section title="Committed diff">
          <pre className="max-h-72 w-full overflow-auto rounded-md bg-muted/40 p-3 text-[12px] leading-relaxed">{p.diff}</pre>
        </Section>
      )}
      {p.prCommand && (
        <Section title="PR script" actions={
          <Button onClick={async () => {
            await navigator.clipboard.writeText(p.prCommand!);
            setCopied(true);
          }}>{copied ? 'Copied' : 'Copy'}</Button>
        }>
          <pre className="max-h-48 w-full overflow-auto rounded-md bg-muted/40 p-3 text-[12px] leading-relaxed">{p.prCommand}</pre>
        </Section>
      )}

      <Section title="Ladder">
        <Ladder status={p.status} />
        <div className="mt-3 flex gap-2">
          {(ACTIONS[p.status] ?? []).map(([action, label]) => (
            <Button key={action} variant={action === 'apply' ? 'primary' : 'secondary'}
              onClick={() => void act(action)}>{label}</Button>
          ))}
        </div>
      </Section>
      {applyLines && (
        <pre className="mt-3 max-h-56 overflow-auto rounded-md bg-muted/40 p-3 text-[12px] leading-relaxed">
          {applyLines.join('\n')}
        </pre>
      )}
    </>
  );
}

function SessionDrawer({ session }: { session: ImproveSession }) {
  const router = useRouter();
  const [topology, setTopology] = useState<{ graph: WireGraph; children: Record<string, WireGraph> } | undefined>();
  const [topologyError, setTopologyError] = useState<string | undefined>();

  useEffect(() => {
    const query = new URLSearchParams({ scenario: 'improve', params: JSON.stringify(session.params ?? {}) });
    api<{ graph: WireGraph; children: Record<string, WireGraph> }>(`/api/graph?${query}`)
      .then(setTopology)
      .catch((err: Error) => setTopologyError(err.message));
  }, [session]);

  return (
    <>
      <Facts rows={[
        ['target', session.params?.target ?? '?'],
        ['status', <Badge key="s" tone={statusTone(session.status)}>{session.status}</Badge>],
        ['started', when(session.startedAt)],
        ['workspace', session.params?.workspace ?? '—'],
        ['repo', session.params?.repoRoot ?? '—'],
        ...(session.error ? [['error', session.error] as [string, string]] : []),
      ]} />
      <div className="my-3">
        <Button onClick={() => {
          sessionStorage.setItem('pivotRun', session.runId);
          router.push('/logs/');
        }}>Logs for this run</Button>
      </div>
      <Section title="Topology">
        {topologyError ? <Empty>topology unavailable: {topologyError}</Empty>
          : !topology ? <Empty>drawing…</Empty>
            : <GraphView graph={topology.graph} children={topology.children} />}
      </Section>
    </>
  );
}

/**
 * The rungs a proposal climbs, and what each one actually does. The
 * actions were previously bare buttons, which said nothing about what was
 * reversible or who publishes.
 */
const LADDER: Array<{ status: string; title: string; blurb: string }> = [
  { status: 'proposed', title: 'Proposed', blurb: 'Measured and filed. Nothing has changed yet.' },
  { status: 'trial', title: 'Trial', blurb: 'Applied as a runtime overlay: ordinary runs use it and accrue evidence. Reversible.' },
  { status: 'pr', title: 'Applied to source', blurb: 'A clone was edited, verified, and committed to a branch. Push and open the PR yourself.' },
  { status: 'applied', title: 'Merged', blurb: 'Live in your repository. A corpus epoch retires pre-change runs from measurement.' },
];

function Ladder({ status }: { status: string }) {
  const reverted = status === 'reverted';
  const index = LADDER.findIndex((rung) => rung.status === status);

  return (
    <ol className="space-y-1.5">
      {LADDER.map((rung, i) => {
        const state = reverted ? 'past' : i < index ? 'past' : i === index ? 'current' : 'future';
        return (
          <li key={rung.status} className="grid grid-cols-[16px_140px_1fr] items-start gap-2 text-xs">
            <span className={cn(
              'mt-0.5 text-center',
              state === 'current' ? 'text-primary' : state === 'past' ? 'text-ok' : 'text-muted-foreground/50',
            )}>
              {state === 'past' ? '✓' : state === 'current' ? '●' : '○'}
            </span>
            <span className={state === 'current' ? 'text-foreground' : 'text-muted-foreground'}>{rung.title}</span>
            <span className="text-muted-foreground/80">{rung.blurb}</span>
          </li>
        );
      })}
      {reverted && (
        <li className="grid grid-cols-[16px_140px_1fr] items-start gap-2 text-xs">
          <span className="mt-0.5 text-center text-muted-foreground">↩</span>
          <span className="text-foreground">Reverted</span>
          <span className="text-muted-foreground/80">Taken back. It will not be re-proposed while the measurement still favours it.</span>
        </li>
      )}
    </ol>
  );
}
