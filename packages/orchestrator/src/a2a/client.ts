/**
 * A2A Client Port
 *
 * The narrow surface the engine needs from an Agent2Agent client, owned by
 * the orchestrator and implemented by the host.
 *
 * Same arrangement as `ContextCompressor` and `MemoryRetriever`: the engine
 * declares the contract, a host injects an implementation, and core takes
 * on no A2A dependency. `@a2a-js/sdk` is the obvious implementation,
 * not a requirement — and keeping it out of core means the executor is
 * testable without a network or a live agent.
 *
 * Deliberately smaller than the protocol. Streaming, push notifications,
 * and task listing exist in A2A and are absent here, because the engine
 * does not need them to run a task to completion. Widen this when a phase
 * actually requires it.
 *
 * @module a2a/client
 */

/**
 * Terminal and interrupted task states, normalized from the protocol's
 * `TaskState`.
 *
 * `rejected` is kept distinct from `failed` because the two demand
 * different handling: a failure may be worth retrying, a refusal never is.
 * `auth-required` is kept distinct from `input-required` because one is
 * resolved by refreshing a credential and the other by asking a human.
 */
export type A2ATaskState =
  | 'completed'
  | 'failed'
  | 'rejected'
  | 'canceled'
  | 'input-required'
  | 'auth-required';

/** One result produced by a remote agent, keyed by its artifact name. */
export interface A2AArtifact {
  /**
   * The artifact's human-readable name, which is what `output_mapping`
   * matches on. Weaker than a graph output key: nothing in the protocol
   * guarantees it is stable across versions of the remote agent.
   */
  name: string;
  /**
   * The artifact's content, already flattened from protocol `Part`s.
   * Structured `data` parts survive as objects; text parts as strings.
   */
  value: unknown;
}

/** The outcome of running a remote task. */
export interface A2ATaskResult {
  /** Server-generated task id, persisted so a paused task can be resumed. */
  taskId: string;
  /** Normalized terminal or interrupted state. */
  state: A2ATaskState;
  /** Results, by artifact name. Empty unless `state` is `completed`. */
  artifacts: A2AArtifact[];
  /** Human-readable detail for a non-completed state. */
  message?: string;
}

/** What the engine sends to start a task. */
export interface A2ATaskRequest {
  /** Resolved endpoint from the server registry. */
  agentCardUrl: string;
  /** Auth headers resolved at call time. Never logged. */
  headers: Record<string, string>;
  /** The mapped input, one entry per `input_mapping` target. */
  input: Record<string, unknown>;
  /** Advisory skill id from node config, if the implementation can use it. */
  skillId?: string;
  /** How long to wait for a terminal or interrupted state. */
  timeoutMs: number;
  /** Cancellation from the run's abort controller. */
  abortSignal?: AbortSignal;
}

/**
 * Runs a task against a remote agent and resolves once it reaches a
 * terminal or interrupted state.
 *
 * An implementation MUST NOT throw for a `failed`, `rejected`, or
 * interrupted task: those are outcomes the executor maps to node behaviour,
 * and turning them into exceptions would erase the distinction between a
 * refusal and a transport error. Throw only when the task could not be run
 * at all.
 */
export interface A2AClient {
  runTask(request: A2ATaskRequest): Promise<A2ATaskResult>;

  /**
   * Continue a task that stopped in `input-required`, supplying the answer.
   *
   * A2A models this as a message carrying the existing `taskId`, so the
   * remote agent resumes the same task rather than starting a new one. Same
   * contract as {@link runTask} on the way back: interrupted and failed
   * states are results, not exceptions, so a task may legitimately ask a
   * second question.
   */
  resumeTask(request: A2AResumeRequest): Promise<A2ATaskResult>;
}

/** What the engine sends to continue an interrupted task. */
export interface A2AResumeRequest {
  /** Resolved endpoint from the server registry. */
  agentCardUrl: string;
  /** Auth headers resolved at call time. Never logged. */
  headers: Record<string, string>;
  /** The task to continue, from the stashed checkpoint. */
  taskId: string;
  /** The human's answer. */
  response: unknown;
  /** How long to wait for the next terminal or interrupted state. */
  timeoutMs: number;
  /** Cancellation from the run's abort controller. */
  abortSignal?: AbortSignal;
}
