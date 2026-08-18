/**
 * Tests for detectSignals (src/insights/signals.ts).
 */

import { describe, it, expect } from 'vitest';
import { detectSignals } from '../../src/insights/signals.js';
import { run, warn } from './helpers.js';

describe('detectSignals', () => {
  it('reports a warning that recurs across runs', () => {
    const findings = detectSignals([
      run({ runId: 'a', logs: [warn('runner.node.agent.node_retry', 'draft')] }),
      run({ runId: 'b', logs: [warn('runner.node.agent.node_retry', 'draft')] }),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]!.title).toBe("'draft' retries");
  });

  it('ignores a warning seen in only one run', () => {
    const findings = detectSignals([
      run({ runId: 'a', logs: [warn('runner.node.agent.node_retry', 'draft')] }),
      run({ runId: 'b', logs: [] }),
    ]);

    expect(findings).toEqual([]);
  });

  it('ignores info and debug lines', () => {
    const findings = detectSignals([
      run({ runId: 'a', logs: [{ level: 'info', event: 'runner.node_retry' }] }),
      run({ runId: 'b', logs: [{ level: 'debug', event: 'runner.node_retry' }] }),
    ]);

    expect(findings).toEqual([]);
  });

  it('separates the same signal on different nodes into distinct findings', () => {
    const findings = detectSignals([
      run({ runId: 'a', logs: [warn('x.node_retry', 'draft'), warn('x.node_retry', 'review')] }),
      run({ runId: 'b', logs: [warn('x.node_retry', 'draft'), warn('x.node_retry', 'review')] }),
    ]);

    expect(findings.map(f => f.nodeId).sort()).toEqual(['draft', 'review']);
  });

  it('separates the same signal in different workflows', () => {
    const findings = detectSignals([
      run({ runId: 'a', workflow: 'one', logs: [warn('x.node_retry')] }),
      run({ runId: 'b', workflow: 'one', logs: [warn('x.node_retry')] }),
      run({ runId: 'c', workflow: 'two', logs: [warn('x.node_retry')] }),
      run({ runId: 'd', workflow: 'two', logs: [warn('x.node_retry')] }),
    ]);

    expect(findings.map(f => f.workflow).sort()).toEqual(['one', 'two']);
  });

  it('groups signals emitted from different components under one name', () => {
    const findings = detectSignals([
      run({ runId: 'a', logs: [warn('runner.router.no_matching_edge', 'route')] }),
      run({ runId: 'b', logs: [warn('runner.graph.no_matching_edge', 'route')] }),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]!.evidence.runs).toBe(2);
  });

  it('counts occurrences separately from runs', () => {
    const findings = detectSignals([
      run({ runId: 'a', logs: [warn('x.node_retry'), warn('x.node_retry'), warn('x.node_retry')] }),
      run({ runId: 'b', logs: [warn('x.node_retry')] }),
    ]);

    expect(findings[0]!.evidence).toMatchObject({ runs: 2, occurrences: 4, of: 2 });
  });

  it('assigns the severity the signal table declares', () => {
    const findings = detectSignals([
      run({ runId: 'a', logs: [warn('x.max_iterations_reached')] }),
      run({ runId: 'b', logs: [warn('x.max_iterations_reached')] }),
    ]);

    expect(findings[0]!.severity).toBe('high');
  });

  it('reports an unrecognised signal at low severity rather than dropping it', () => {
    const findings = detectSignals([
      run({ runId: 'a', logs: [warn('x.brand_new_warning')] }),
      run({ runId: 'b', logs: [warn('x.brand_new_warning')] }),
    ]);

    expect(findings[0]!.severity).toBe('low');
    expect(findings[0]!.title).toBe("wf emits 'brand_new_warning'");
  });

  it('admits it has no interpretation for an unrecognised signal', () => {
    const findings = detectSignals([
      run({ runId: 'a', logs: [warn('x.brand_new_warning')] }),
      run({ runId: 'b', logs: [warn('x.brand_new_warning')] }),
    ]);

    expect(findings[0]!.addresses).toContain('no interpretation for it yet');
  });

  it('caps the sample run ids it carries', () => {
    const runs = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(runId =>
      run({ runId, logs: [warn('x.node_retry')] }));

    const findings = detectSignals(runs);

    expect(findings[0]!.evidence.sampleRunIds).toHaveLength(5);
    expect(findings[0]!.evidence.runs).toBe(7);
  });

  it('derives an id from the workflow, signal, and node', () => {
    const findings = detectSignals([
      run({ runId: 'a', logs: [warn('x.node_retry', 'draft')] }),
      run({ runId: 'b', logs: [warn('x.node_retry', 'draft')] }),
    ]);

    expect(findings[0]!.id).toBe('signal:wf:node_retry:draft');
  });

  it('ignores an iteration cap of one, which has no headroom to not exhaust', () => {
    const capped = {
      level: 'warn' as const,
      event: 'agent.supervisor.max_iterations_reached',
      context: { max: 1 },
    };

    const findings = detectSignals([
      run({ runId: 'a', logs: [capped] }),
      run({ runId: 'b', logs: [capped] }),
    ]);

    expect(findings).toEqual([]);
  });

  it('reports an iteration cap with headroom that was still exhausted', () => {
    const capped = {
      level: 'warn' as const,
      event: 'agent.supervisor.max_iterations_reached',
      context: { max: 6 },
    };

    const findings = detectSignals([
      run({ runId: 'a', logs: [capped] }),
      run({ runId: 'b', logs: [capped] }),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('high');
  });

  it('records when the signal was last seen', () => {
    const findings = detectSignals([
      run({ runId: 'a', startedAt: '2026-08-01T00:00:00.000Z', logs: [warn('x.node_retry')] }),
      run({ runId: 'b', startedAt: '2026-08-17T00:00:00.000Z', logs: [warn('x.node_retry')] }),
    ]);

    expect(findings[0]!.evidence.lastSeen).toBe('2026-08-17T00:00:00.000Z');
  });

  it('returns nothing for an empty corpus', () => {
    expect(detectSignals([])).toEqual([]);
  });
});

describe('detectSignals — weighed against assertion outcomes', () => {
  const RETRY = warn('x.node_retry', 'draft');
  const PASSED = { type: 'status_equals', passed: true };
  const FAILED = { type: 'status_equals', passed: false };

  it('demotes a signal never seen in a run that missed its assertions', () => {
    const findings = detectSignals([
      run({ runId: 'a', logs: [RETRY], assertions: [PASSED] }),
      run({ runId: 'b', logs: [RETRY], assertions: [PASSED] }),
    ]);

    expect(findings[0]!.severity).toBe('low');
  });

  it('says what the demotion was based on', () => {
    const findings = detectSignals([
      run({ runId: 'a', logs: [RETRY], assertions: [PASSED] }),
      run({ runId: 'b', logs: [RETRY], assertions: [PASSED] }),
    ]);

    expect(findings[0]!.detail).toContain('never seen in a run that missed its assertions (2 clean)');
  });

  it('promotes an unnamed signal seen only in runs that missed their assertions', () => {
    const findings = detectSignals([
      run({ runId: 'a', logs: [warn('x.runner_wiring_failed')], assertions: [FAILED] }),
      run({ runId: 'b', logs: [warn('x.runner_wiring_failed')], assertions: [FAILED] }),
    ]);

    expect(findings[0]!.severity).toBe('high');
    expect(findings[0]!.detail).toContain('only ever seen in runs that missed their assertions (2)');
  });

  it('leaves a signal seen on both sides at its declared severity', () => {
    const findings = detectSignals([
      run({ runId: 'a', logs: [RETRY], assertions: [PASSED] }),
      run({ runId: 'b', logs: [RETRY], assertions: [FAILED] }),
    ]);

    expect(findings[0]!.severity).toBe('medium');
  });

  it('leaves a signal at its declared severity when no run carried assertions', () => {
    const findings = detectSignals([
      run({ runId: 'a', logs: [RETRY] }),
      run({ runId: 'b', logs: [RETRY] }),
    ]);

    expect(findings[0]!.severity).toBe('medium');
  });

  it('needs more than one clean run before demoting', () => {
    const findings = detectSignals([
      run({ runId: 'a', logs: [RETRY], assertions: [PASSED] }),
      run({ runId: 'b', logs: [RETRY] }),
    ]);

    expect(findings[0]!.severity).toBe('medium');
  });
});

describe('detectSignals — spanning workflows', () => {
  const WIRING = warn('runner.graph.runner_wiring_failed');

  it('reports a signal firing once in each of several workflows', () => {
    const findings = detectSignals([
      run({ runId: 'a', workflow: 'one', logs: [WIRING] }),
      run({ runId: 'b', workflow: 'two', logs: [WIRING] }),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]!.workflow).toBe('*');
  });

  it('names how many workflows it spans', () => {
    const findings = detectSignals([
      run({ runId: 'a', workflow: 'one', logs: [WIRING] }),
      run({ runId: 'b', workflow: 'two', logs: [WIRING] }),
      run({ runId: 'c', workflow: 'three', logs: [WIRING] }),
    ]);

    expect(findings[0]!.detail).toContain('3 run(s) across 3 workflows, once each');
  });

  it('stays silent for a signal confined to one workflow', () => {
    const findings = detectSignals([run({ runId: 'a', workflow: 'one', logs: [WIRING] })]);

    expect(findings).toEqual([]);
  });

  it('does not repeat a signal already reported against a workflow', () => {
    const findings = detectSignals([
      run({ runId: 'a', workflow: 'one', logs: [WIRING] }),
      run({ runId: 'b', workflow: 'one', logs: [WIRING] }),
      run({ runId: 'c', workflow: 'two', logs: [WIRING] }),
    ]);

    expect(findings.map(f => f.workflow)).toEqual(['one']);
  });

  it('weighs a spanning signal against assertion outcomes too', () => {
    const findings = detectSignals([
      run({ runId: 'a', workflow: 'one', logs: [WIRING], assertions: [{ type: 's', passed: false }] }),
      run({ runId: 'b', workflow: 'two', logs: [WIRING], assertions: [{ type: 's', passed: false }] }),
    ]);

    expect(findings[0]!.severity).toBe('high');
  });

  it('uses the signal table title when it recognises the signal', () => {
    const findings = detectSignals([
      run({ runId: 'a', workflow: 'one', logs: [warn('x.node_retry')] }),
      run({ runId: 'b', workflow: 'two', logs: [warn('x.node_retry')] }),
    ]);

    expect(findings[0]!.title).toBe('every workflow retries');
  });

  it('derives an id that does not name any one workflow', () => {
    const findings = detectSignals([
      run({ runId: 'a', workflow: 'one', logs: [WIRING] }),
      run({ runId: 'b', workflow: 'two', logs: [WIRING] }),
    ]);

    expect(findings[0]!.id).toBe('signal:*:runner_wiring_failed:-');
  });

  it('counts the whole corpus as the denominator', () => {
    const findings = detectSignals([
      run({ runId: 'a', workflow: 'one', logs: [WIRING] }),
      run({ runId: 'b', workflow: 'two', logs: [WIRING] }),
      run({ runId: 'c', workflow: 'three' }),
    ]);

    expect(findings[0]!.evidence.of).toBe(3);
  });
});
