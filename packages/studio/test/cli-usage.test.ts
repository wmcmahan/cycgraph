/** Tests for host-spelled invocation text in CLI output (src/cli/render.ts). */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { STUDIO_USAGE, type CliUsage } from '../src/cli/context.js';
import { renderProposals, renderUsage, renderWatch } from '../src/cli/render.js';
import type { WatchRow } from '../src/improve/watch.js';

const PLAYGROUND_USAGE: CliUsage = {
  name: 'cycgraph playground',
  command: 'npm run play',
  verbPrefix: 'npm run play -- ',
};

function capture(render: () => void): string {
  const chunks: string[] = [];
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  render();
  write.mockRestore();
  return chunks.join('');
}

function captureUsage(usage: CliUsage): string {
  return capture(() => renderUsage(usage));
}

describe('renderUsage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints the studio invocation for the studio default', () => {
    const text = captureUsage(STUDIO_USAGE);

    expect(text).toContain('cycgraph studio');
    expect(text).toContain('npm run studio -- run <id> [--flags]');
    expect(text).toContain('npm run studio -- serve');
    expect(text).not.toContain('npm run play');
  });

  it("prints a host's own invocation when the harness names one", () => {
    const text = captureUsage(PLAYGROUND_USAGE);

    expect(text).toContain('cycgraph playground');
    expect(text).toContain('npm run play -- run <id> [--flags]');
    expect(text).toContain('npm run play -- serve');
    expect(text).not.toContain('npm run studio');
  });
});

describe('renderWatch', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const proposedRow: WatchRow = {
    workflow: 'triage',
    outcome: 'proposed',
    detail: 'one knob moved',
    forks: 3,
    proposals: ['p-1'],
  };

  it('spells the follow-up hint in the studio invocation by default', () => {
    const text = capture(() => renderWatch([proposedRow], STUDIO_USAGE));

    expect(text).toContain('`npm run studio -- proposals`');
    expect(text).not.toContain('npm run play');
  });

  it("spells the follow-up hint in a host's own invocation", () => {
    const text = capture(() => renderWatch([proposedRow], PLAYGROUND_USAGE));

    expect(text).toContain('`npm run play -- proposals`');
    expect(text).not.toContain('npm run studio');
  });
});

describe('renderProposals', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('spells the empty-ledger hint in the studio invocation by default', () => {
    const text = capture(() => renderProposals([], STUDIO_USAGE));

    expect(text).toContain('`npm run studio -- tune <id> --save`');
    expect(text).not.toContain('npm run play');
  });

  it("spells the empty-ledger hint in a host's own invocation", () => {
    const text = capture(() => renderProposals([], PLAYGROUND_USAGE));

    expect(text).toContain('`npm run play -- tune <id> --save`');
    expect(text).not.toContain('npm run studio');
  });
});
