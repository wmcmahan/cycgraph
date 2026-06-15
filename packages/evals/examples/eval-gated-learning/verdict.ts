/**
 * Verdict — the demo's success criteria, factored out so the live run and
 * the deterministic CI regression test assert the SAME invariants.
 *
 * The live demo (real LLMs) calls this after its 11-run experiment and
 * exits non-zero if `passed` is false — so a broken mechanism fails loudly
 * instead of printing a happy summary. The deterministic test feeds it
 * synthetic run records to lock the verdict logic itself.
 *
 * @module examples/eval-gated-learning/verdict
 */

/** The minimum a run record needs to expose for the verdict. */
export interface VerdictRecord {
  run: number;
  fitness: number;
  injected_fact_ids: string[];
  poison_injected_count: number;
}

export interface VerdictInput {
  records: VerdictRecord[];
  /** The seeded poison fact IDs. */
  poisonIds: string[];
  /** How many poison facts the gate invalidated (`invalidated_by: 'eval-gate:*'`). */
  poisonEvicted: number;
  /** The run after which the last poison fact was cleared, or null. */
  poisonEvictedAfterRun: number | null;
  /** How many lessons the gate promoted to `verified`. */
  verifiedCount: number;
}

export interface VerdictCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface Verdict {
  passed: boolean;
  checks: VerdictCheck[];
  cleanBeforeAvg: number | null;
  poisonRunsAvg: number | null;
  afterEvictionAvg: number | null;
}

const avg = (rs: VerdictRecord[]): number | null =>
  rs.length === 0 ? null : rs.reduce((s, r) => s + r.fitness, 0) / rs.length;

const fmt = (v: number | null): string => (v === null ? 'n/a' : v.toFixed(3));

/**
 * Evaluate the demo's claims against its run records and gate outcomes.
 * Pure — no I/O — so it's identical in the live run and in tests.
 */
export function computeVerdict(input: VerdictInput): Verdict {
  const { records, poisonIds, poisonEvicted, poisonEvictedAfterRun, verifiedCount } = input;

  const poisonRuns = records.filter((r) => r.poison_injected_count > 0);
  const firstPoisonRun = poisonRuns[0]?.run ?? null;
  const cleanBefore = records.filter(
    (r) => r.injected_fact_ids.length > 0 && (firstPoisonRun === null || r.run < firstPoisonRun),
  );
  const afterEviction =
    poisonEvictedAfterRun !== null ? records.filter((r) => r.run > poisonEvictedAfterRun) : [];

  const cleanBeforeAvg = avg(cleanBefore);
  const poisonRunsAvg = avg(poisonRuns);
  const afterEvictionAvg = avg(afterEviction);

  const checks: VerdictCheck[] = [];

  // The gate must decide on real trial evidence — the poison has to have
  // actually been injected into at least one run before it can be evicted.
  checks.push({
    name: 'poison was trialled (not pre-emptively blocked)',
    passed: poisonRuns.length > 0,
    detail: `${poisonRuns.length} run(s) had poison in their prompt`,
  });

  // Every seeded poison lesson is evicted.
  checks.push({
    name: 'all poison evicted on outcome evidence',
    passed: poisonIds.length > 0 && poisonEvicted === poisonIds.length,
    detail: `${poisonEvicted}/${poisonIds.length} poison lessons invalidated by eval-gate`,
  });

  // Eviction is attributable to a specific run boundary, not "eventually".
  checks.push({
    name: 'poison cleared during the experiment',
    passed: poisonEvictedAfterRun !== null,
    detail:
      poisonEvictedAfterRun !== null ? `cleared after run ${poisonEvictedAfterRun}` : 'never cleared',
  });

  // Self-healing: scores after eviction beat the poisoned trough. (Trivially
  // satisfied if there were no post-eviction runs to measure.)
  const recovered =
    poisonRunsAvg === null || afterEvictionAvg === null || afterEvictionAvg >= poisonRunsAvg;
  checks.push({
    name: 'fitness recovered after eviction',
    passed: recovered,
    detail: `poison-trough avg=${fmt(poisonRunsAvg)} → post-eviction avg=${fmt(afterEvictionAvg)}`,
  });

  // The good lessons survive: at least one is promoted to verified.
  checks.push({
    name: 'genuine lessons promoted to verified',
    passed: verifiedCount >= 1,
    detail: `${verifiedCount} verified`,
  });

  return {
    passed: checks.every((c) => c.passed),
    checks,
    cleanBeforeAvg,
    poisonRunsAvg,
    afterEvictionAvg,
  };
}

/** Render a verdict as `✓`/`✗` lines for the console. */
export function formatVerdict(v: Verdict): string {
  const lines = v.checks.map((c) => `  ${c.passed ? '✓' : '✗'} ${c.name} — ${c.detail}`);
  lines.push('', `  ${v.passed ? '✓ PASS' : '✗ FAIL'}`);
  return lines.join('\n');
}
