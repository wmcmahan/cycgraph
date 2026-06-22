/**
 * SUT Dispatcher
 *
 * Single entry point that takes a {@link RecordingPlan} and executes the
 * appropriate System-Under-Test for the trajectory's suite. Used by both
 * the recording script (to refresh goldens) and the SUT-driven semantic
 * track (to produce real outputs at gate time).
 *
 * Tool fixtures (stateful closures) are resolved fresh per dispatch so
 * each invocation starts from a clean counter. Callers MUST NOT share
 * fixture closures across dispatches.
 *
 * @module sut/dispatch
 */

import { runOrchestratorSut } from './orchestrator-sut.js';
import { runMemorySut } from './memory-sut.js';
import { runContextEngineSut } from './context-engine-sut.js';
import { buildSingleAgentGraph } from './graphs/single-agent.js';
import { buildSupervisorGraph } from './graphs/supervisor.js';
import { buildBranchingGraph } from './graphs/branching.js';
import { buildRetryGraph } from './graphs/retry.js';
import { createFlakyFetch, createRateLimitedCall } from './fixtures/retry-tools.js';
import type { SuiteName } from '../dataset/types.js';
import type {
  RecordingPlan,
  OrchestratorToolKind,
} from './recording-planner.js';
import type {
  SutRunResult,
  ToolResponseMap,
} from './types.js';

/** Options for a single dispatch invocation. */
export interface SutDispatchOptions {
  /** Which suite the trajectory belongs to. */
  suite: SuiteName;
  /** Recording plan produced by `planForTrajectory(suite, trajectory)`. */
  plan: RecordingPlan;
  /**
   * Model identifier for the orchestrator SUT. Ignored for memory and
   * context-engine suites (their library calls are deterministic).
   */
  model: string;
  /**
   * Per-run wall-clock timeout in ms for orchestrator SUT runs.
   * Defaults to the orchestrator SUT's built-in timeout (120s).
   */
  timeoutMs?: number;
}

/**
 * Resolve a `toolKind` to a fresh `{ toolResponses, toolDescriptions }`
 * pair. Stateful fixtures are re-created on each call.
 */
function resolveToolFixtures(toolKind: OrchestratorToolKind): {
  toolResponses?: ToolResponseMap;
  toolDescriptions?: Record<string, string>;
} {
  switch (toolKind) {
    case 'none':
      return {};
    case 'web_search':
      return {
        toolResponses: {
          web_search: (args) => ({
            query: args.query,
            results: [
              {
                title: 'Wikipedia: TypeScript',
                snippet:
                  'TypeScript is a strongly typed programming language developed by Microsoft. First released in 2012, designed by Anders Hejlsberg.',
              },
            ],
          }),
        },
        toolDescriptions: {
          web_search:
            'Search the web for current information. Returns a list of result snippets.',
        },
      };
    case 'flaky_fetch':
      return {
        toolResponses: {
          flaky_fetch: createFlakyFetch({ failuresBeforeSuccess: 2 }),
        },
        toolDescriptions: {
          flaky_fetch:
            'Fetch data from an unreliable API. Early attempts may return errors; retry until success.',
        },
      };
    case 'rate_limited_call':
      return {
        toolResponses: {
          rate_limited_call: createRateLimitedCall({
            totalCalls: 5,
            rateLimitEvery: 3,
          }),
        },
        toolDescriptions: {
          rate_limited_call:
            'Make an API call subject to rate limits. May return 429 and require backoff.',
        },
      };
  }
}

/**
 * Dispatch a trajectory to its appropriate SUT and return the observed
 * result. The caller is responsible for calling this multiple times
 * (with the same plan) when sampling for stability.
 */
export async function runSutDispatch(
  opts: SutDispatchOptions,
): Promise<SutRunResult> {
  if (opts.suite === 'memory') {
    return runMemorySut({ trajectory: opts.plan.trajectory });
  }
  if (opts.suite === 'context-engine') {
    return runContextEngineSut({ trajectory: opts.plan.trajectory });
  }
  if (opts.suite === 'orchestrator') {
    return runOrchestratorSample(opts);
  }
  return {
    output: '',
    toolCalls: [],
    durationMs: 0,
    finalMemory: {},
    status: 'failed',
    error: `No SUT for suite "${opts.suite}"`,
  };
}

/** Build the appropriate reference graph + tool fixtures and invoke the orchestrator SUT. */
async function runOrchestratorSample(
  opts: SutDispatchOptions,
): Promise<SutRunResult> {
  const { plan, model, timeoutMs } = opts;
  const { toolResponses, toolDescriptions } = resolveToolFixtures(
    plan.toolKind ?? 'none',
  );
  const toolNames = Object.keys(toolResponses ?? {});

  if (plan.graphKind === 'supervisor') {
    const artifacts = buildSupervisorGraph({
      input: plan.trajectory.input,
      model,
    });
    return runOrchestratorSut({
      graph: artifacts.graph,
      initialState: artifacts.initialState,
      agentRegistry: artifacts.agentRegistry,
      toolResponses,
      toolDescriptions,
      outputKey: artifacts.outputKey,
      timeoutMs,
    });
  }

  if (plan.graphKind === 'branching') {
    const artifacts = buildBranchingGraph({
      input: plan.trajectory.input,
      model,
    });
    return runOrchestratorSut({
      graph: artifacts.graph,
      initialState: artifacts.initialState,
      agentRegistry: artifacts.agentRegistry,
      toolResponses,
      toolDescriptions,
      outputKey: artifacts.outputKey,
      timeoutMs,
    });
  }

  if (plan.graphKind === 'retry') {
    const toolName = toolNames[0] ?? 'flaky_fetch';
    const artifacts = buildRetryGraph({
      input: plan.trajectory.input,
      model,
      toolName,
    });
    return runOrchestratorSut({
      graph: artifacts.graph,
      initialState: artifacts.initialState,
      agentRegistry: artifacts.agentRegistry,
      toolResponses,
      toolDescriptions,
      outputKey: artifacts.outputKey,
      timeoutMs,
    });
  }

  // Default: single-agent
  const artifacts = buildSingleAgentGraph({
    input: plan.trajectory.input,
    tools: toolNames.length > 0
      ? [{ type: 'mcp', serverId: 'mock', toolNames: toolNames }]
      : [],
    model,
  });
  return runOrchestratorSut({
    graph: artifacts.graph,
    initialState: artifacts.initialState,
    agentRegistry: artifacts.agentRegistry,
    toolResponses,
    toolDescriptions,
    outputKey: artifacts.outputKey,
    timeoutMs,
  });
}
