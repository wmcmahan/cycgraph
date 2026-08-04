/**
 * Orchestrator SUT
 *
 * Wraps `GraphRunner` to produce a recorded trajectory: the textual output
 * extracted from final workflow memory plus the ordered sequence of tool
 * calls the LLM made. Used by `scripts/record-goldens.ts` to ground
 * orchestrator golden trajectories in observable model behavior.
 *
 * Runs are serial (the underlying agent factory + provider registry are
 * process-global singletons). Mock MCP tools keep the SUT network-free
 * apart from the LLM call itself.
 *
 * @module sut/orchestrator-sut
 */

import {
  GraphRunner,
  configureAgentFactory,
  configureProviderRegistry,
  createProviderRegistry,
} from '@cycgraph/orchestrator';
import type {
  Graph,
  WorkflowState,
  AgentRegistry,
  ProviderRegistry,
} from '@cycgraph/orchestrator';
import { createMockToolResolver } from './mock-tool-resolver.js';
import type {
  RecordedToolCall,
  SutRunResult,
  SutStatus,
  ToolResponseMap,
} from './types.js';

/** Options for a single orchestrator SUT run. */
export interface RunOrchestratorSutOptions {
  /** Graph definition to execute. */
  graph: Graph;

  /** Initial workflow state (must reference `graph.id` as `workflow_id`). */
  initialState: WorkflowState;

  /** Agent registry containing every agent referenced by the graph. */
  agentRegistry: AgentRegistry;

  /**
   * Provider registry for LLM resolution. If omitted, the built-in registry
   * (OpenAI + Anthropic, depending on environment keys) is used.
   */
  providerRegistry?: ProviderRegistry;

  /**
   * Canned responses for MCP tools the agents may invoke. Tool names that the
   * LLM calls but aren't in this map will silently return `undefined` — graphs
   * should only declare tools they expect the LLM to use.
   */
  toolResponses?: ToolResponseMap;

  /** Human-readable descriptions surfaced to the LLM for each mock tool. */
  toolDescriptions?: Record<string, string>;

  /**
   * Memory key(s) whose final value(s) form the textual output. When an array,
   * keys are concatenated with `\n\n`. Missing keys are skipped silently.
   */
  outputKey: string | string[];

  /** Per-run wall-clock timeout in milliseconds (default: 120 000). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Run a graph through the orchestrator and capture (output, toolCalls).
 *
 * The function applies the supplied `agentRegistry` and `providerRegistry`
 * to the process-global agent factory before running. Callers must
 * serialize concurrent invocations to avoid registry contamination.
 */
export async function runOrchestratorSut(
  opts: RunOrchestratorSutOptions,
): Promise<SutRunResult> {
  configureAgentFactory(opts.agentRegistry);
  configureProviderRegistry(opts.providerRegistry ?? createProviderRegistry());

  const toolResolver = opts.toolResponses
    ? createMockToolResolver(opts.toolResponses, opts.toolDescriptions)
    : undefined;

  const runner = new GraphRunner(opts.graph, opts.initialState, {
    tools: toolResolver ? [toolResolver] : undefined,
  });

  const toolCalls: RecordedToolCall[] = [];
  let callOrder = 0;

  runner.on('tool:call_start', (event) => {
    toolCalls.push({
      toolName: event.tool_name,
      args: (event.args ?? {}) as Record<string, unknown>,
      nodeId: event.node_id,
      callId: event.tool_call_id,
      order: callOrder++,
    });
  });

  const start = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let status: SutStatus = 'completed';
  let errorMessage: string | undefined;
  let finalState: WorkflowState = opts.initialState;

  try {
    finalState = await withTimeout(runner.run(), timeoutMs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === '__sut_timeout__') {
      status = 'timeout';
      errorMessage = `SUT exceeded ${timeoutMs}ms`;
    } else {
      status = 'failed';
      errorMessage = message;
    }
  }

  const durationMs = Date.now() - start;
  const output = extractOutput(finalState.memory, opts.outputKey);

  return {
    output,
    toolCalls,
    durationMs,
    finalMemory: finalState.memory,
    status,
    error: errorMessage,
  };
}

/** Race a promise against a timeout, throwing a sentinel error on expiry. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('__sut_timeout__')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Pull the textual output from final memory using the supplied key(s).
 * Single-key string values are returned verbatim; objects are JSON-serialized
 * for predictable comparison against goldens. Exported for unit testing.
 */
export function extractOutput(
  memory: Record<string, unknown>,
  outputKey: string | string[],
): string {
  const keys = Array.isArray(outputKey) ? outputKey : [outputKey];
  const parts: string[] = [];

  for (const key of keys) {
    if (!(key in memory)) continue;
    const value = memory[key];
    if (typeof value === 'string') {
      parts.push(value);
    } else if (value !== undefined) {
      parts.push(JSON.stringify(value));
    }
  }

  return parts.join('\n\n');
}
