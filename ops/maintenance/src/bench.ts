/**
 * The benchmark harness behind optimization proposals.
 *
 * An optimization claim is only worth a ticket if it measured. The
 * harness runs the repository's vitest bench suites against the
 * orchestrator's *source* via aliases — a clone's node_modules symlinks
 * back to the real repository, so resolving normally would benchmark
 * unedited code — and both sides of a comparison run the same way, so
 * before and after are apples to apples. Verdicts respect noise: an
 * improvement must clear the configured floor and the two runs'
 * combined margins of error.
 *
 * @module maintenance/bench
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { checksEnv } from './repo.js';

const exec = promisify(execFile);

/** One benchmark's measurement. `rme` is its relative margin of error, %. */
export interface BenchRow {
  id: string;
  hz: number;
  rme: number;
}

interface BenchJson {
  files: {
    groups: {
      fullName: string;
      benchmarks: { name: string; hz: number; rme: number }[];
    }[];
  }[];
}

/** Flatten vitest's `--outputJson` report into rows keyed by full name. */
export function parseBenchJson(json: string): BenchRow[] {
  const report = JSON.parse(json) as BenchJson;
  return report.files.flatMap((file) =>
    file.groups.flatMap((group) =>
      group.benchmarks.map((bench) => ({
        id: `${group.fullName} > ${bench.name}`,
        hz: bench.hz,
        rme: bench.rme,
      }))));
}

/**
 * Run the bench suites in a clone, resolving `@cycgraph/orchestrator`
 * from the clone's own source so edits are what gets measured. The
 * generated config lives outside the clone to keep its diff pure; it
 * exports a plain object because a file in the temp directory cannot
 * resolve vitest's config helper.
 */
export async function runAliasedBench(
  cloneRoot: string,
  options: { filter?: string } = {},
): Promise<BenchRow[]> {
  const scratch = await mkdtemp(join(tmpdir(), 'cycgraph-bench-'));
  const outputAt = join(scratch, 'report.json');
  const configAt = join(scratch, 'bench.config.mts');
  const orchestratorSrc = join(cloneRoot, 'packages', 'orchestrator', 'src');
  await writeFile(configAt, [
    'export default {',
    `  root: ${JSON.stringify(join(cloneRoot, 'packages', 'benchmarks'))},`,
    '  resolve: { alias: [',
    `    { find: '@cycgraph/orchestrator/internal', replacement: ${JSON.stringify(join(orchestratorSrc, 'internal.ts'))} },`,
    `    { find: '@cycgraph/orchestrator', replacement: ${JSON.stringify(join(orchestratorSrc, 'index.ts'))} },`,
    '  ]},',
    `  test: { benchmark: { include: ['src/**/*.bench.ts'], outputJson: ${JSON.stringify(outputAt)} } },`,
    '};',
    '',
  ].join('\n'));

  await exec(
    'npx', ['vitest', 'bench', '--run', '--config', configAt,
      ...(options.filter !== undefined && options.filter !== '' ? [options.filter] : [])],
    {
      cwd: join(cloneRoot, 'packages', 'benchmarks'),
      env: { ...checksEnv(), LOG_LEVEL: 'error' },
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return parseBenchJson(await readFile(outputAt, 'utf8'));
}

/** A measured before/after delta for one benchmark. */
export interface BenchDelta {
  id: string;
  /** Percent change in throughput; positive is faster. */
  pct: number;
  /** The two runs' combined relative margins of error, %. */
  noise: number;
}

/** What a comparison concluded. */
export interface BenchComparison {
  improved: BenchDelta[];
  regressed: BenchDelta[];
  unchanged: number;
  /**
   * Ids present in `before` but absent from `after`. A bench that
   * vanished was broken, renamed, or timed out by the edit under test —
   * never a pass, so consumers must treat any entry here as a block.
   */
  disappeared: string[];
}

/**
 * Compare two bench runs. An improvement counts only when it clears
 * both `minImprovementPct` and the combined noise; a regression counts
 * when it exceeds the combined noise plus a small floor, so ordinary
 * jitter never reads as either.
 */
export function compareBench(
  before: readonly BenchRow[],
  after: readonly BenchRow[],
  minImprovementPct: number,
): BenchComparison {
  const baseline = new Map(before.map((row) => [row.id, row]));
  const afterIds = new Set(after.map((row) => row.id));
  const disappeared = before.filter((row) => !afterIds.has(row.id)).map((row) => row.id);
  const improved: BenchDelta[] = [];
  const regressed: BenchDelta[] = [];
  let unchanged = 0;
  for (const row of after) {
    const base = baseline.get(row.id);
    if (base === undefined || base.hz === 0) continue;
    const pct = ((row.hz - base.hz) / base.hz) * 100;
    const noise = base.rme + row.rme;
    if (pct >= Math.max(minImprovementPct, noise)) improved.push({ id: row.id, pct, noise });
    else if (pct <= -Math.max(5, noise)) regressed.push({ id: row.id, pct, noise });
    else unchanged += 1;
  }
  return { improved, regressed, unchanged, disappeared };
}
