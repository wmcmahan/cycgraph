/** Tests for the prepared PR script (src/run/workspace.ts prCommand). */

import { describe, it, expect } from 'vitest';
import { prCommand } from '../src/improve/workspace.js';
import type { ProposalRecord } from '../src/improve/proposals.js';

const RECORD = {
  id: 'sweep:wf:boss:supervisor_config.max_iterations',
  workflow: 'wf',
  nodeId: 'boss',
  knob: 'supervisor_config.max_iterations',
  from: 8,
  to: 4,
} as ProposalRecord;

describe('prCommand', () => {
  it('hands the branch to the source repository before publishing from it', () => {
    const script = prCommand({ root: '/tmp/ws', branch: 'tune/x' }, RECORD, '/repo');

    const lines = script.split('\n');
    expect(lines[0]).toBe('git -C /tmp/ws push origin tune/x');
    expect(lines).toContain('cd /repo');
    expect(lines).toContain('git push -u origin tune/x');
    expect(lines.some((line) => line.startsWith('gh pr create --title'))).toBe(true);
  });

  it('names the measured move in the PR title', () => {
    const script = prCommand({ root: '/tmp/ws', branch: 'tune/x' }, RECORD, '/repo');

    expect(script).toContain('"tune: boss.supervisor_config.max_iterations 8 → 4"');
  });
});
