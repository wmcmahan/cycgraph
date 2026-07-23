import { describe, it, expect } from 'vitest';
import { runDeterministic } from '../../src/suites/memory/suite.js';

describe('memory deterministic suite', () => {
  it('runs all deterministic test cases', async () => {
    const results = await runDeterministic();
    expect(results.length).toBe(11); // 8 plumbing + 2 extraction efficacy + 1 blind corpus
  });

  it('all tests pass on known-good fixtures', async () => {
    const results = await runDeterministic();

    for (const testCase of results) {
      expect(testCase.suite).toBe('memory');

      for (const det of testCase.deterministicResults ?? []) {
        expect(det.passed, `Failed: ${det.metric} — ${det.description}`).toBe(true);
      }
    }
  });

  it('temporal filtering excludes expired facts', async () => {
    const results = await runDeterministic();
    const temporal = results.find(r =>
      r.deterministicResults?.some(d => d.metric === 'temporal_expired_filtered'),
    );
    expect(temporal).toBeDefined();

    const det = temporal!.deterministicResults!.find(d => d.metric === 'temporal_expired_filtered')!;
    expect(det.passed).toBe(true);
    expect(det.actual).toBe(1);
  });

  it('subgraph 1-hop returns correct entities', async () => {
    const results = await runDeterministic();
    const subgraph = results.find(r =>
      r.deterministicResults?.some(d => d.metric === 'subgraph_1hop_entities'),
    );
    expect(subgraph).toBeDefined();

    const det = subgraph!.deterministicResults!.find(d => d.metric === 'subgraph_1hop_entities')!;
    expect(det.passed).toBe(true);
  });

  it('subgraph 2-hop expands to all connected entities', async () => {
    const results = await runDeterministic();
    const subgraph = results.find(r =>
      r.deterministicResults?.some(d => d.metric === 'subgraph_2hop_entities'),
    );
    expect(subgraph).toBeDefined();

    const det = subgraph!.deterministicResults!.find(d => d.metric === 'subgraph_2hop_entities')!;
    expect(det.passed).toBe(true);
  });

  it('episode segmentation is deterministic', async () => {
    const results = await runDeterministic();
    const seg = results.find(r =>
      r.deterministicResults?.some(d => d.metric === 'segmentation_determinism'),
    );
    expect(seg).toBeDefined();

    const det = seg!.deterministicResults!.find(d => d.metric === 'segmentation_determinism')!;
    expect(det.passed).toBe(true);
  });

  it('theme→fact linkage is complete', async () => {
    const results = await runDeterministic();
    const linkage = results.find(r =>
      r.deterministicResults?.some(d => d.metric === 'theme_fact_linkage'),
    );
    expect(linkage).toBeDefined();

    const det = linkage!.deterministicResults!.find(d => d.metric === 'theme_fact_linkage')!;
    expect(det.passed).toBe(true);
  });
});
