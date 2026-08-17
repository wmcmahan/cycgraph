/**
 * A node's own output keys, as properties on the authored value.
 *
 * Node types write memory keys derived from their id: a map node writes
 * `${id}_results`, a tool node `${id}_result`, singular. Typing those strings
 * by hand is a silent failure — the reader gets an empty slice, produces
 * something plausible from nothing, and passes any assertion that only checks
 * the key exists. Naming them here makes a mistake a compile error:
 *
 * ```ts
 * const fan = mapReduce(worker, { id: 'fan', into: reduce });
 * node({ id: 'reduce', type: 'synthesizer', reads: [fan.results] });
 * ```
 *
 * The properties are non-enumerable, so `graph()` — which builds the wire node
 * by spreading the authored value — never sees them, and they cannot reach the
 * schema or a serialized graph.
 *
 * Mirrors `impliedResultKeys` in security/effective-permissions.ts, which is
 * the runtime authority. The two must agree: that one decides what a node is
 * permitted to write, this one tells the author what to read.
 *
 * @module authoring/outputs
 */

/** Output keys a `tool` node writes. */
export type ToolOutputs = {
  /** `${id}_result` — the tool's return value. */
  readonly result: string;
};

/** Output keys a `map` node writes. */
export type MapOutputs = {
  /** `${id}_results` — one entry per worker that succeeded. */
  readonly results: string;
  /** `${id}_errors` — one entry per worker that failed. */
  readonly errors: string;
  /** `${id}_count` — how many workers succeeded. */
  readonly count: string;
  /** `${id}_error_count` — how many failed. */
  readonly errorCount: string;
};

/** Output keys a `voting` node writes. */
export type VotingOutputs = {
  /** `${id}_consensus` — the winning answer. */
  readonly consensus: string;
  /** `${id}_votes` — every voter's answer. */
  readonly votes: string;
};

/** Output keys an `evolution` node writes. */
export type EvolutionOutputs = {
  readonly winner: string;
  readonly winnerFitness: string;
  readonly winnerReasoning: string;
  readonly generation: string;
  readonly fitnessHistory: string;
  readonly population: string;
  readonly budgetStopped: string;
};

/** Output keys a `verifier` node writes. */
export type VerifierOutputs = {
  /** The verification envelope, `${id}_verification` unless `resultKey` renames it. */
  readonly verification: string;
  /** `${verification}_passed` — the boolean verdict. */
  readonly passed: string;
};

/** Output keys a `reflection` node writes. */
export type ReflectionOutputs = {
  /** The reflection envelope, `${id}_reflection` unless `resultKey` renames it. */
  readonly reflection: string;
};

/** Output keys a `synthesizer` node writes when it merges without an agent. */
export type SynthesizerOutputs = {
  /** `${id}_synthesis` — the merged result. */
  readonly synthesis: string;
};

/** Fallback key an agent-style node routes text output to. */
export type AgentOutputs = {
  /** `${id}_output` — used when no write key claims the agent's text. */
  readonly output: string;
};

/**
 * A delegating node's output mapping, kept at the type it was written with.
 *
 * A `subgraph` or `a2a` node writes whatever its mapping renames things to, so
 * its keys are per-call rather than derived from its id. The mapping itself is
 * the answer — this only preserves it, since the helpers fold it into the
 * node's config and it would otherwise be gone by the time a reader asks.
 *
 * Reach through the delegate's own name for a value, not the parent's: the
 * child-side key is the delegate's declared output and stable across callers,
 * where the parent-side name is a local rename.
 *
 * ```ts
 * const research = subgraph(child, { id: 'research', outputs: { notes: 'findings' } });
 * node({ id: 'write', reads: [research.outputs.notes] });   // 'findings'
 * ```
 */
export type MappedOutputsFor<S extends { outputs?: Record<string, string> }> =
  S['outputs'] extends Record<string, string>
    ? { readonly outputs: Readonly<S['outputs']> }
    : { readonly outputs: Readonly<Record<string, string>> };

/**
 * Keep the output mapping on the authored value.
 *
 * Non-enumerable, so it does not travel back onto the wire node the helpers
 * already folded it into.
 */
export function withMappedOutputs<T extends object, O extends Record<string, string>>(
  value: T,
  mapping: O | undefined,
): T & { readonly outputs: Readonly<O> } {
  Object.defineProperty(value, 'outputs', {
    value: mapping ?? {},
    enumerable: false,
    writable: false,
  });
  return value as T & { readonly outputs: Readonly<O> };
}

/**
 * Attach output keys to an authored node value.
 *
 * Non-enumerable so the properties survive property access and type checking
 * but not object spread, which is how `graph()` strips them.
 */
export function withOutputs<T extends object, O extends Record<string, string>>(
  value: T,
  outputs: O,
): T & Readonly<O> {
  for (const [name, key] of Object.entries(outputs)) {
    Object.defineProperty(value, name, { value: key, enumerable: false, writable: false });
  }
  return value as T & Readonly<O>;
}

export const toolOutputs = (id: string): ToolOutputs => ({ result: `${id}_result` });

export const mapOutputs = (id: string): MapOutputs => ({
  results: `${id}_results`,
  errors: `${id}_errors`,
  count: `${id}_count`,
  errorCount: `${id}_error_count`,
});

export const votingOutputs = (id: string): VotingOutputs => ({
  consensus: `${id}_consensus`,
  votes: `${id}_votes`,
});

export const evolutionOutputs = (id: string): EvolutionOutputs => ({
  winner: `${id}_winner`,
  winnerFitness: `${id}_winner_fitness`,
  winnerReasoning: `${id}_winner_reasoning`,
  generation: `${id}_generation`,
  fitnessHistory: `${id}_fitness_history`,
  population: `${id}_population`,
  budgetStopped: `${id}_budget_stopped`,
});

export const verifierOutputs = (id: string, resultKey?: string): VerifierOutputs => {
  const verification = resultKey ?? `${id}_verification`;
  return { verification, passed: `${verification}_passed` };
};

export const reflectionOutputs = (id: string, resultKey?: string): ReflectionOutputs => ({
  reflection: resultKey ?? `${id}_reflection`,
});

export const synthesizerOutputs = (id: string): SynthesizerOutputs => ({ synthesis: `${id}_synthesis` });

export const agentOutputs = (id: string): AgentOutputs => ({ output: `${id}_output` });
