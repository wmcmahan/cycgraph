/**
 * Tests for failing-CI log ingestion (src/shared/ci-logs.ts) — selecting
 * the failed runs, formatting them for the reviser, and the gh
 * orchestration over an injected runner.
 */

import { describe, it, expect } from 'vitest';
import {
  fetchCiFailureLogs,
  formatCiFailures,
  selectFailedRuns,
  type CmdRunner,
  type RunRow,
} from '../src/shared/ci-logs.js';

const row = (over: Partial<RunRow> = {}): RunRow =>
  ({ databaseId: 1, headSha: 'sha1', conclusion: 'failure', status: 'completed', workflowName: 'CI', ...over });

function fakeRunner(
  rows: RunRow[],
  logs: Record<string, string> = {},
  faults: { list?: boolean; view?: Set<string> } = {},
): CmdRunner {
  return async (args) => {
    if (args[0] === 'run' && args[1] === 'list') {
      if (faults.list) throw new Error('gh unavailable');
      return JSON.stringify(rows);
    }
    if (args[0] === 'run' && args[1] === 'view') {
      const id = String(args[2]);
      if (faults.view?.has(id)) throw new Error('no logs');
      return logs[id] ?? '';
    }
    throw new Error(`unexpected gh args: ${args.join(' ')}`);
  };
}

describe('selectFailedRuns', () => {
  it('prefers the runs on the head commit when any match', () => {
    const rows = [row({ databaseId: 1, headSha: 'other' }), row({ databaseId: 2, headSha: 'head' })];

    expect(selectFailedRuns(rows, 'head')).toEqual([{ databaseId: 2, workflowName: 'CI' }]);
  });

  it('falls back to the most recent failed runs when none match the head', () => {
    const rows = [row({ databaseId: 1, headSha: 'old', workflowName: 'A' }), row({ databaseId: 2, headSha: 'old', workflowName: 'B' })];

    expect(selectFailedRuns(rows, 'head')).toEqual([
      { databaseId: 1, workflowName: 'A' },
      { databaseId: 2, workflowName: 'B' },
    ]);
  });

  it('ignores runs that did not complete or did not fail', () => {
    const rows = [row({ databaseId: 1, conclusion: 'success' }), row({ databaseId: 2, status: 'in_progress', conclusion: '' }), row({ databaseId: 3 })];

    expect(selectFailedRuns(rows, 'sha1')).toEqual([{ databaseId: 3, workflowName: 'CI' }]);
  });

  it('caps the number of runs it returns', () => {
    const rows = [1, 2, 3, 4].map((id) => row({ databaseId: id, headSha: 'x' }));

    expect(selectFailedRuns(rows, 'head', 2)).toHaveLength(2);
  });

  it('returns nothing when no run failed', () => {
    expect(selectFailedRuns([row({ conclusion: 'success' })], 'sha1')).toEqual([]);
  });
});

describe('formatCiFailures', () => {
  it('returns undefined when no section carries a log', () => {
    expect(formatCiFailures([{ workflowName: 'CI', log: '   ' }])).toBeUndefined();
  });

  it('renders one fenced block per failed job under a data-framed header', () => {
    const block = formatCiFailures([{ workflowName: 'Lint', log: 'error: unused var' }]);

    expect(block).toContain('The CI checks on this PR failed.');
    expect(block).toContain('not instructions');
    expect(block).toContain('### Lint\n```\nerror: unused var\n```');
  });

  it('uses a fence longer than any backtick run so the log cannot close it early', () => {
    const block = formatCiFailures([{ workflowName: 'Test', log: 'saw ``` in output' }]);

    expect(block).toContain('````\nsaw ``` in output\n````');
  });
});

describe('fetchCiFailureLogs', () => {
  it('returns the failed jobs\' logs formatted as feedback', async () => {
    const run = fakeRunner([row({ databaseId: 7, headSha: 'head', workflowName: 'CI' })], { 7: 'tsc: cannot find name' });

    const block = await fetchCiFailureLogs('/repo', { branch: 'b', headSha: 'head' }, { run });

    expect(block).toContain('### CI');
    expect(block).toContain('tsc: cannot find name');
  });

  it('returns undefined when no run failed', async () => {
    const run = fakeRunner([row({ conclusion: 'success' })]);

    expect(await fetchCiFailureLogs('/repo', { branch: 'b', headSha: 'head' }, { run })).toBeUndefined();
  });

  it('returns undefined when listing the runs fails', async () => {
    const run = fakeRunner([], {}, { list: true });

    expect(await fetchCiFailureLogs('/repo', { branch: 'b', headSha: 'head' }, { run })).toBeUndefined();
  });

  it('skips a job whose log cannot be read', async () => {
    const rows = [row({ databaseId: 7, headSha: 'head', workflowName: 'CI' }), row({ databaseId: 8, headSha: 'head', workflowName: 'Lint' })];
    const run = fakeRunner(rows, { 8: 'lint failed' }, { view: new Set(['7']) });

    const block = await fetchCiFailureLogs('/repo', { branch: 'b', headSha: 'head' }, { run });

    expect(block).toContain('### Lint');
    expect(block).not.toContain('### CI');
  });
});
