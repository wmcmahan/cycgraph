/**
 * Knob enumeration
 *
 * Turns a finding or a profile into the candidate values worth measuring. Pure
 * and deterministic: it reads the node's current config from the graph and the
 * bounds from the table below, and returns changes. It never invents a value,
 * never calls a model, and never runs anything.
 *
 * A knob qualifies when three things hold, all checkable without executing
 * anything:
 *
 * 1. It is expressible as a `change.*` spec, which is exactly what `fork()`
 *    can apply and therefore exactly what can be measured.
 * 2. Its candidates are finite and derivable, from the bound and the current
 *    value or from a list the operator supplied.
 * 3. The thing motivating it names a node.
 *
 * Most findings fail one of the three and are reported without being swept.
 * That is not a gap: a dead-end route needs an edge that does not exist, and
 * no enumeration over existing knobs will invent one.
 *
 * @module sweep/knobs
 */

import { change } from '@cycgraph/orchestrator';
import type { Change, Graph, GraphNode } from '@cycgraph/orchestrator';
import type { Finding } from '../insights/types.js';
import type { NodeProfile, WorkflowProfile } from '../insights/profile.js';
import type { KnobSweep, SweepObjective } from './types.js';

/** How many candidate values one sweep may try. */
const MAX_CANDIDATES = 3;

/**
 * Visits per run above which a node's contribution is dominated by how often
 * it runs rather than by what one run of it costs.
 */
const REPEATED_VISITS = 1.5;

/** Share of a workflow's execution time that makes a node worth optimising. */
export const WORTH_OPTIMISING = 0.25;

/**
 * Draws per arm for a reliability sweep.
 *
 * Five detects only a large gap: a perfect arm against a control passing one
 * of five is significant, against two of five it is not. That is the exact
 * test being honest about five samples, not a defect — raise the sample count
 * to detect smaller gaps.
 */
export const RELIABILITY_SAMPLES = 5;

/**
 * A numeric knob, where it lives on a node, and what the schema allows.
 *
 * Bounds are duplicated from the graph schema rather than read from it,
 * because Zod does not expose them and a candidate outside them would be
 * rejected at fork time instead of never being proposed.
 */
interface KnobSpec {
  /**
   * Config object on the node holding it, which is also what selects the node.
   *
   * Presence of the container rather than the node's type, because several of
   * these are behaviours an `agent` node opts into rather than types of their
   * own: annealing and swarm are both `agent` nodes carrying a config. Keying
   * on the type silently matched nothing.
   */
  container: string;
  field: string;
  min: number;
  max: number;
}

/**
 * Every knob worth sweeping, which is every loop budget and nothing else.
 *
 * Deliberately short. `max_retries` is absent because a node that failed
 * non-retryably had its error classified as permanent, so no budget changes
 * the outcome. `temperature` is absent because no detector produces a finding
 * that motivates moving it. A knob enters this table when something can
 * observe that it is wrong, not when it exists.
 */
const KNOBS: readonly KnobSpec[] = [
  { container: 'supervisor_config', field: 'max_iterations', min: 1, max: 1000 },
  { container: 'annealing_config', field: 'max_iterations', min: 1, max: 1000 },
  { container: 'swarm_config', field: 'max_handoffs', min: 1, max: 1000 },
  { container: 'evolution_config', field: 'max_generations', min: 1, max: 100 },
  { container: 'evolution_config', field: 'population_size', min: 2, max: 100 },
  { container: 'evolution_config', field: 'stagnation_generations', min: 1, max: 100 },
];

/**
 * `max_concurrency` is deliberately absent, though it is a bounded integer on
 * both map-reduce and evolution. It changes how much work overlaps rather than
 * how much there is, so every node still executes for as long as it did and
 * the objective measures no difference. Sweeping it would need wall clock as
 * the objective, and wall clock is what a paused approval spends 31 seconds of
 * without doing anything.
 */

/** Signals whose remedy is to give a loop more room. */
const NEEDS_MORE_ROOM: Record<string, string> = {
  max_iterations_reached: 'max_iterations',
  swarm_max_handoffs: 'max_handoffs',
};

/** The knob a node carries, when it carries the one named. */
function specFor(node: GraphNode, field: string): KnobSpec | undefined {
  return KNOBS.find(knob => knob.field === field && currentValue(node, knob) !== undefined);
}

/** The value a node holds for a knob, when it declares one. */
function currentValue(node: GraphNode, spec: KnobSpec): number | undefined {
  const container = (node as unknown as Record<string, unknown>)[spec.container];
  if (typeof container !== 'object' || container === null) return undefined;
  const value = (container as Record<string, unknown>)[spec.field];
  return typeof value === 'number' ? value : undefined;
}

/**
 * Values below the current one, by repeated halving down to the bound.
 *
 * Halving rather than stepping, because the interesting question is whether a
 * loop needs four iterations or two, not whether it needs four or three. A
 * candidate the assertions reject is a measurement, not waste: it establishes
 * where the floor is.
 */
function downward(current: number, min: number): number[] {
  const values: number[] = [];
  let value = current;
  while (values.length < MAX_CANDIDATES) {
    value = Math.max(min, Math.floor(value / 2));
    if (value >= current || values.includes(value)) break;
    values.push(value);
    if (value === min) break;
  }
  return values;
}

/** Values above the current one, by repeated doubling up to the bound. */
function upward(current: number, max: number): number[] {
  const values: number[] = [];
  let value = Math.max(current, 1);
  while (values.length < MAX_CANDIDATES) {
    value = Math.min(max, value * 2);
    if (value <= current || values.includes(value)) break;
    values.push(value);
    if (value === max) break;
  }
  return values;
}

/** Candidate values an operator supplied rather than a schema implied. */
export interface SweepInputs {
  /**
   * Models to try, which is the one candidate list nothing can derive.
   *
   * A schema bound says what a budget may be; nothing says which models are
   * installed, affordable, or allowed. So this is supplied rather than
   * enumerated, and no model sweep happens without it.
   */
  models?: string[];
  /** The model in force, excluded from its own sweep. */
  currentModel?: string;
}

/**
 * The model sweep a node's share of its workflow motivates.
 *
 * The one knob that reaches every node rather than one node type: anything
 * backed by an agent can be run against a different model. It applies equally
 * to a node visited once, which is what separates it from every loop budget
 * here — those need a loop, and most nodes do not have one.
 */
function modelSweep(
  workflow: string,
  node: GraphNode,
  share: number,
  inputs: SweepInputs,
): KnobSweep | undefined {
  if (!inputs.models?.length) return undefined;
  // The change repoints a node's agent, so a node without one has nothing to
  // repoint. That is the honest test rather than a list of node types, which
  // would go stale the moment a type gains or loses an agent.
  if (!node.agent_id) return undefined;
  if (share < WORTH_OPTIMISING) return undefined;

  const candidates = inputs.models.filter(model => model !== inputs.currentModel);
  if (candidates.length === 0) return undefined;

  const variants: Record<string, Change[]> = {};
  for (const model of candidates) {
    variants[`model=${model}`] = [change.model(node.id, model)];
  }

  return {
    id: `sweep:${workflow}:${node.id}:model`,
    workflow,
    nodeId: node.id,
    knob: 'model',
    current: inputs.currentModel ?? 'unknown',
    objective: 'cost',
    reason: `it takes ${Math.round(share * 100)}% of execution time, so the question is whether another model does the same work for less`,
    variants,
  };
}

/** One sweep over the given values of one knob. */
function sweepOver(
  workflow: string,
  node: GraphNode,
  spec: KnobSpec,
  current: number,
  candidates: readonly number[],
  objective: SweepObjective,
  reason: string,
): KnobSweep | undefined {
  if (candidates.length === 0) return undefined;

  const variants: Record<string, Change[]> = {};
  for (const value of candidates) {
    variants[`${spec.field}=${value}`] = [
      change.config(node.id, { [spec.container]: { ...(node as never)[spec.container] as object, [spec.field]: value } }),
    ];
  }

  return {
    id: `sweep:${workflow}:${node.id}:${spec.container}.${spec.field}`,
    workflow,
    nodeId: node.id,
    knob: `${spec.container}.${spec.field}`,
    current,
    objective,
    reason,
    variants,
  };
}

/**
 * The sweep a finding motivates, when it motivates one.
 *
 * A finding that names no node, or names a node the graph does not hold, or
 * whose remedy is not a knob, produces nothing. That is the common case.
 */
export function enumerateFromFinding(finding: Finding, graph: Graph): KnobSweep | undefined {
  if (!finding.nodeId) return undefined;

  const node = graph.nodes.find(n => n.id === finding.nodeId);
  if (!node) return undefined;

  const signal = finding.id.startsWith('signal:') ? finding.id.split(':')[2] : undefined;
  if (!signal) return undefined;

  const roomField = NEEDS_MORE_ROOM[signal];
  if (roomField) {
    const spec = specFor(node, roomField);
    if (!spec) return undefined;
    const current = currentValue(node, spec);
    if (current === undefined) return undefined;

    const sweep = sweepOver(
      finding.workflow, node, spec, current, upward(current, spec.max), 'correctness',
      'the loop exhausts its budget rather than converging, so the question is whether more room lets it finish',
    );
    if (!sweep) return undefined;

    // A control at the current value, because the prefixes are failing runs
    // and a flaky tail can pass on a re-run at any value. A fix that the
    // unchanged budget also delivers is a resample, not a fix.
    const controlName = `${spec.field}=${current}`;
    sweep.variants = {
      [controlName]: [
        change.config(node.id, { [spec.container]: { ...(node as never)[spec.container] as object } }),
      ],
      ...sweep.variants,
    };
    sweep.control = controlName;
    sweep.prefixes = 'failing';
    return sweep;
  }

  return undefined;
}

/**
 * The sweep a node's share of its workflow motivates, when it motivates one.
 *
 * Only for nodes visited repeatedly, because that is when the knob is the
 * lever. A node visited once a run is dominated by what one visit costs, and
 * no iteration budget changes that.
 */
export function enumerateFromProfile(
  profile: WorkflowProfile,
  node: NodeProfile,
  graph: Graph,
): KnobSweep | undefined {
  if (node.visitsPerRun < REPEATED_VISITS) return undefined;
  if (node.timeShare < WORTH_OPTIMISING) return undefined;

  const graphNode = graph.nodes.find(n => n.id === node.nodeId);
  if (!graphNode) return undefined;

  for (const spec of KNOBS) {
    const current = currentValue(graphNode, spec);
    if (current === undefined) continue;

    const sweep = sweepOver(
      profile.workflow, graphNode, spec, current, downward(current, spec.min), 'cost',
      `it takes ${Math.round(node.timeShare * 100)}% of execution time across ${node.visitsPerRun.toFixed(1)} visits a run, so the question is whether it needs them all`,
    );
    if (sweep) return sweep;
  }

  return undefined;
}

/**
 * The temperature sweep a workflow's flakiness motivates, when one does.
 *
 * Fires on an intermittent assertion finding: the workflow holds its
 * assertions only sometimes, so the hypothesis worth buying is that sampling
 * colder makes the output reliable. The swept node is the one where most of
 * the work happens, because the finding itself names no node.
 *
 * The current value comes from what recorded calls actually sampled at, read
 * off the profile, not from any config — the graph does not carry temperature,
 * the agent registry does, and what the log says the calls used is the ground
 * truth either way. A node whose observed temperature varies is on a schedule
 * and is skipped: its temperature is a program, not a value.
 */
function temperatureSweep(
  workflow: string,
  findings: readonly Finding[],
  profile: WorkflowProfile,
  graph: Graph,
): KnobSweep | undefined {
  const flaky = findings.find(finding =>
    finding.workflow === workflow
    && finding.detector === 'assertions'
    && finding.severity === 'medium');
  if (!flaky) return undefined;

  const target = profile.nodes.find(node => {
    const graphNode = graph.nodes.find(n => n.id === node.nodeId);
    return graphNode?.agent_id !== undefined
      && node.timeShare >= WORTH_OPTIMISING
      && node.temperature !== undefined
      && node.temperature.min === node.temperature.max
      && node.temperature.min > 0;
  });
  if (!target) return undefined;

  const current = target.temperature!.min;
  const half = Math.round((current / 2) * 100) / 100;
  const candidates = [...new Set([half, 0])].filter(value => value < current);
  if (candidates.length === 0) return undefined;

  const variants: Record<string, Change[]> = {
    [`temperature=${current}`]: [change.temperature(target.nodeId, current)],
  };
  for (const value of candidates) {
    variants[`temperature=${value}`] = [change.temperature(target.nodeId, value)];
  }

  return {
    id: `sweep:${workflow}:${target.nodeId}:temperature`,
    workflow,
    nodeId: target.nodeId,
    knob: 'temperature',
    current,
    objective: 'reliability',
    reason: `the workflow holds its assertions only sometimes (${flaky.detail.split(' — ')[0]}), so the question is whether sampling colder makes it reliable`,
    variants,
    control: `temperature=${current}`,
    samples: RELIABILITY_SAMPLES,
  };
}

/**
 * Every sweep a report and a profile motivate, deduplicated by knob.
 *
 * A finding and a profile can reach the same knob from opposite directions,
 * and measuring it twice in one pass would spend the tail twice to answer one
 * question. The finding wins, because a workflow that is failing should be
 * made to work before it is made cheaper.
 */
export function enumerateSweeps(
  findings: readonly Finding[],
  profile: WorkflowProfile | undefined,
  graph: Graph,
  inputs: SweepInputs = {},
): KnobSweep[] {
  const byKnob = new Map<string, KnobSweep>();

  for (const finding of findings) {
    const sweep = enumerateFromFinding(finding, graph);
    if (sweep) byKnob.set(sweep.id, sweep);
  }

  for (const node of profile?.nodes ?? []) {
    const sweep = enumerateFromProfile(profile!, node, graph);
    if (sweep && !byKnob.has(sweep.id)) byKnob.set(sweep.id, sweep);

    const graphNode = graph.nodes.find(n => n.id === node.nodeId);
    if (!graphNode) continue;

    // A model sweep sits alongside a budget sweep rather than replacing it.
    // They are different questions about the same node, and the budget answer
    // does not tell you the model answer.
    const models = modelSweep(profile!.workflow, graphNode, node.timeShare, inputs);
    if (models && !byKnob.has(models.id)) byKnob.set(models.id, models);
  }

  if (profile) {
    const temperature = temperatureSweep(profile.workflow, findings, profile, graph);
    if (temperature && !byKnob.has(temperature.id)) byKnob.set(temperature.id, temperature);
  }

  return [...byKnob.values()];
}
