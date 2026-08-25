/**
 * Parameter sweeps
 *
 * Run one scenario across a set of parameter variants and keep every result.
 * The variants come from the same Zod schema the CLI renders as flags, so a
 * sweep needs no per-scenario support: anything tweakable is sweepable.
 *
 * Runs are sequential. Concurrency would contend for the same Postgres, the
 * same Ollama, and the same scenario servers, which is exactly what the
 * timings are supposed to measure.
 *
 * @module run/sweep
 */

import type { z } from 'zod';
import type { Scenario } from '../scenarios/types.js';
import type { Stack } from '../stack/index.js';
import { executeScenario, type ExecuteOptions, type RunOutcome } from './execute.js';

/** One axis of a sweep: a parameter and the values to try. */
export interface SweepAxis {
  /** Dotted path into the parameter object. */
  path: string;
  /** Raw values, coerced by the same rules a flag would use. */
  values: unknown[];
}

/** One run of a sweep, paired with the variant that produced it. */
export interface SweepEntry {
  /** Only the swept values, for a table that shows what actually varied. */
  variant: Record<string, unknown>;
  outcome: RunOutcome;
}

export interface SweepResult {
  entries: SweepEntry[];
  /** Runs whose assertions all passed. */
  passed: number;
  totalMs: number;
  totalTokens: number;
  totalCostUsd: number;
}

/** Write `value` at a dotted path, creating intermediate objects. */
function assign(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  const last = segments.pop();
  if (!last) return;

  let cursor = target;
  for (const segment of segments) {
    if (typeof cursor[segment] !== 'object' || cursor[segment] === null) cursor[segment] = {};
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[last] = value;
}

/**
 * Every combination of the axes, in a stable order.
 *
 * The last axis varies fastest, so a table reads like nested loops written in
 * the order they were given.
 */
export function expandVariants(axes: readonly SweepAxis[]): Array<Record<string, unknown>> {
  return axes.reduce<Array<Record<string, unknown>>>(
    (acc, axis) => acc.flatMap((base) => axis.values.map((value) => ({ ...base, [axis.path]: value }))),
    [{}],
  );
}

/** Whether an outcome counts as a pass: it ran, and every assertion held. */
export function isPass(outcome: RunOutcome): boolean {
  return outcome.evals.length > 0 && outcome.evals.every((result) => result.passed);
}

/**
 * Run every variant, keeping each one's artifacts.
 *
 * A variant that fails does not stop the sweep. A sweep exists to compare
 * outcomes, and a failure is one of the outcomes being compared.
 */
export async function runSweep<P extends z.ZodTypeAny>(
  scenario: Scenario<P>,
  baseParams: Record<string, unknown>,
  axes: readonly SweepAxis[],
  repeat: number,
  stack: Stack,
  options: ExecuteOptions & { onVariantStart?: (variant: Record<string, unknown>, index: number, total: number) => void } = {},
): Promise<SweepResult> {
  const variants = expandVariants(axes);
  const entries: SweepEntry[] = [];
  const started = Date.now();

  const total = variants.length * repeat;
  let index = 0;

  for (const variant of variants) {
    for (let pass = 0; pass < repeat; pass++) {
      const raw = { ...baseParams };
      for (const [path, value] of Object.entries(variant)) assign(raw, path, value);

      options.onVariantStart?.(variant, index++, total);

      // Parsed per variant so defaults and refinements apply to the merged
      // object, not to the base alone.
      const params = scenario.params.parse(raw) as z.infer<P>;
      const outcome = await executeScenario(scenario, params, stack, options);
      entries.push({ variant: repeat > 1 ? { ...variant, pass: pass + 1 } : variant, outcome });
    }
  }

  return {
    entries,
    passed: entries.filter((entry) => isPass(entry.outcome)).length,
    totalMs: Date.now() - started,
    totalTokens: entries.reduce((sum, e) => sum + e.outcome.usage.totalTokens, 0),
    totalCostUsd: entries.reduce((sum, e) => sum + e.outcome.usage.totalCostUsd, 0),
  };
}
