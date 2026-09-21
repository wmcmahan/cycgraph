/** Tests for usage text rendering (src/cli/render.ts). */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { STUDIO_USAGE, type CliUsage } from '../src/cli/context.js';
import { renderUsage } from '../src/cli/render.js';

function captureUsage(usage: CliUsage): string {
  const chunks: string[] = [];
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  renderUsage(usage);
  write.mockRestore();
  return chunks.join('');
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
    const text = captureUsage({
      name: 'cycgraph playground',
      command: 'npm run play',
      verbPrefix: 'npm run play -- ',
    });

    expect(text).toContain('cycgraph playground');
    expect(text).toContain('npm run play -- run <id> [--flags]');
    expect(text).toContain('npm run play -- serve');
    expect(text).not.toContain('npm run studio');
  });
});
