/**
 * Assertion-failure detection
 *
 * The strongest signal in the corpus, because it is the only one that knows
 * what the workflow was *for*. An engine warning says something went wrong
 * mechanically; a failing assertion says the run did not do what its author
 * claimed it would.
 *
 * This is also the detector whose findings are most worth testing with a fork,
 * since the same assertions supply the verdict: a change either turns them
 * green or it does not.
 *
 * @module insights/assertions
 */

import type { Detector, Finding, RunTelemetry } from './types.js';
import { seenAt, startTimes } from './recency.js';

/** How many run ids a finding carries. */
const SAMPLE_LIMIT = 5;

/** Rate at which failing stops being a flake and starts being the workflow. */
const PERVASIVE = 0.5;

/** The runs one assertion type failed in, and what it said. */
interface TypeFailures {
  runIds: string[];
  messages: Set<string>;
}

/** Assertions that failed together, in the same runs. */
interface FailureGroup {
  workflow: string;
  types: Set<string>;
  runIds: string[];
  messages: Set<string>;
}

/** The runs each assertion type failed in, per workflow. */
function failuresByType(runs: readonly RunTelemetry[]): Map<string, Map<string, TypeFailures>> {
  const byWorkflow = new Map<string, Map<string, TypeFailures>>();

  for (const run of runs) {
    for (const assertion of run.assertions) {
      if (assertion.passed) continue;

      const workflow = byWorkflow.get(run.workflow) ?? new Map<string, TypeFailures>();
      const entry = workflow.get(assertion.type) ?? { runIds: [], messages: new Set<string>() };
      if (!entry.runIds.includes(run.runId)) entry.runIds.push(run.runId);
      if (assertion.message) entry.messages.add(assertion.message);
      workflow.set(assertion.type, entry);
      byWorkflow.set(run.workflow, workflow);
    }
  }

  return byWorkflow;
}

/**
 * Report assertions that fail, grouped by the runs they failed in.
 *
 * Grouped by run set rather than by assertion type, because a run that ends
 * `failed` trips every assertion downstream of the failure and reporting each
 * separately turns one incident into four findings. It is also the unit a fork
 * can test: a change re-runs the tail once and every assertion answers at once.
 *
 * Severity follows the rate rather than the count. An assertion failing in
 * every run is a broken workflow, and one failing occasionally is a flake or a
 * capability limit, and those want different attention.
 */
export const detectAssertionFailures: Detector = (runs: readonly RunTelemetry[]): Finding[] => {
  const times = startTimes(runs);
  const runsWithAssertions = new Map<string, number>();
  for (const run of runs) {
    if (run.assertions.length === 0) continue;
    runsWithAssertions.set(run.workflow, (runsWithAssertions.get(run.workflow) ?? 0) + 1);
  }

  const groups = new Map<string, FailureGroup>();
  for (const [workflow, byType] of failuresByType(runs)) {
    for (const [type, entry] of byType) {
      const signature = `${workflow} ${[...entry.runIds].sort().join(',')}`;
      const group = groups.get(signature)
        ?? { workflow, types: new Set<string>(), runIds: entry.runIds, messages: new Set<string>() };
      group.types.add(type);
      for (const message of entry.messages) group.messages.add(message);
      groups.set(signature, group);
    }
  }

  const findings: Finding[] = [];
  for (const group of groups.values()) {
    const types = [...group.types].sort();
    const of = runsWithAssertions.get(group.workflow) ?? group.runIds.length;
    const rate = group.runIds.length / of;
    const pervasive = rate >= PERVASIVE;

    findings.push({
      id: `assertion:${group.workflow}:${types.join('+')}`,
      detector: 'assertions',
      severity: pervasive ? 'high' : 'medium',
      workflow: group.workflow,
      title: types.length === 1
        ? `${group.workflow} fails its '${types[0]}' assertion`
        : `${group.workflow} fails ${types.length} assertions together: ${types.join(', ')}`,
      detail: [
        `${group.runIds.length} of ${of} runs (${Math.round(rate * 100)}%)`,
        ...[...group.messages].slice(0, 2),
      ].join(' — '),
      evidence: {
        runs: group.runIds.length,
        occurrences: group.runIds.length * types.length,
        sampleRunIds: group.runIds.slice(0, SAMPLE_LIMIT),
        of,
        ...seenAt(group.runIds, times),
      },
      addresses: pervasive
        ? 'the workflow does not do what its assertions claim, in most runs'
        : 'the workflow meets its assertions only sometimes, so something in it is not reliable',
    });
  }

  return findings;
};
