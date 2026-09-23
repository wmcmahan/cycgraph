/**
 * The pr-revise input schema and current-branch PR resolution.
 */

import { describe, expect, it } from 'vitest';
import { params, resolveCurrentBranchPr } from '../src/pr-revise/context.js';

describe('params', () => {
  it('defaults pr to the current-branch sentinel', () => {
    expect(params.parse({}).pr).toBe(0);
  });

  it('keeps an explicit pull request number', () => {
    expect(params.parse({ pr: 366 }).pr).toBe(366);
  });

  it('rejects a negative pull request number', () => {
    expect(params.safeParse({ pr: -1 }).success).toBe(false);
  });
});

describe('resolveCurrentBranchPr', () => {
  it('resolves the number gh reports for the checked-out branch', async () => {
    const run = async (args: readonly string[]) => {
      expect(args).toEqual(['pr', 'view', '--json', 'number']);
      return JSON.stringify({ number: 366 });
    };

    await expect(resolveCurrentBranchPr('/repo', { run })).resolves.toBe(366);
  });

  it('throws the uniform error when gh fails', async () => {
    const run = async () => { throw new Error('gh: not logged in'); };

    await expect(resolveCurrentBranchPr('/repo', { run }))
      .rejects.toThrow('no pull request given and the checked-out branch has no open pull request');
  });

  it('throws the uniform error when gh reports no usable number', async () => {
    const run = async () => JSON.stringify({ number: 0 });

    await expect(resolveCurrentBranchPr('/repo', { run }))
      .rejects.toThrow('no pull request given and the checked-out branch has no open pull request');
  });
});
