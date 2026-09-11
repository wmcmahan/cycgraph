/**
 * Tests for the fleet scorecard's rendering (src/stats.ts).
 */

import { describe, it, expect } from 'vitest';
import { formatStats, type WorkflowStats } from '../src/stats.js';

const row = (overrides: Partial<WorkflowStats> = {}): WorkflowStats => ({
  name: 'docs-maintenance',
  runs: 10,
  completed: 9,
  gateRan: 8,
  gatePassed: 6,
  withLessons: 5,
  outcomes: 4,
  avgScore: 0.75,
  avgTokens: 152_000,
  costUsd: 12.34,
  tailFlags: 0,
  ...overrides,
});

describe('formatStats', () => {
  it('renders rates, outcomes, and cost for a workflow row', () => {
    const lines = formatStats([row()], 14);

    expect(lines[0]).toBe('fleet scorecard — primary runs, last 14 day(s)');
    expect(lines[2]).toContain('docs-maintenance');
    expect(lines[2]).toContain('90%');
    expect(lines[2]).toContain('75%');
    expect(lines[2]).toContain('4@0.75');
    expect(lines[2]).toContain('152k');
    expect(lines[2]).toContain('$12.34');
  });

  it('shows dashes for workflows with no gate runs or outcomes', () => {
    const lines = formatStats([row({ gateRan: 0, gatePassed: 0, outcomes: 0, avgScore: undefined, avgTokens: undefined })], 7);

    expect(lines[2]).toBe('docs-maintenance       10   90%     —      50%         —        —   $12.34 ');
  });

  it('flags degraded learning tails', () => {
    const lines = formatStats([row({ tailFlags: 3 })], 14);

    expect(lines[2]).toContain('3 degraded');
  });
});
