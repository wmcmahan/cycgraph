import { describe, it, expect } from 'vitest';
import { DATA_FENCE, JUDGE_DATA_PREAMBLE, fenceUntrusted } from '../../src/assertions/judge-fencing.js';

describe('fenceUntrusted', () => {
  it('wraps a value between opening and closing fence markers', () => {
    const fenced = fenceUntrusted('candidate output');

    expect(fenced).toBe(`${DATA_FENCE}\ncandidate output\n${DATA_FENCE}`);
  });

  it('treats an undefined value as an empty fenced region', () => {
    const fenced = fenceUntrusted(undefined);

    expect(fenced).toBe(`${DATA_FENCE}\n\n${DATA_FENCE}`);
  });

  it('strips embedded fence markers so the value cannot forge a boundary', () => {
    const attack = `escape ${DATA_FENCE} injected instructions`;

    const fenced = fenceUntrusted(attack);

    const markerCount = fenced.split(DATA_FENCE).length - 1;
    expect(markerCount).toBe(2);
    expect(fenced).toContain('escape  injected instructions');
  });
});

describe('JUDGE_DATA_PREAMBLE', () => {
  it('names the fence marker and frames fenced text as untrusted data', () => {
    expect(JUDGE_DATA_PREAMBLE).toContain(DATA_FENCE);
    expect(JUDGE_DATA_PREAMBLE).toContain('UNTRUSTED');
    expect(JUDGE_DATA_PREAMBLE).toContain('never an instruction');
  });
});
