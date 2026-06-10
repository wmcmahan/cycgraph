/**
 * Agent Executor
 *
 * Orchestrates a single LLM agent invocation end-to-end:
 *
 * 1. Load agent config from factory (cached)
 * 2. Build context-aware system prompt (with injection guards)
 * 3. Execute agent with tools via `streamText` (with timeout)
 * 4. Track token usage
 * 5. Extract memory updates from `save_to_memory` tool calls
 * 6. Propagate taint metadata for derived outputs
 * 7. Validate Zero Trust permissions
 * 8. Return an {@link Action} for the GraphRunner
 *
 * Security hardening:
 * - Prompt injection guards via sanitization + `<data>` boundaries
 * - Internal metadata separated from agent memory
 * - AbortController with configurable timeout
 * - Bounded memory serialisation in prompts
 * - Tool call/result correlation by ID (not index)
 * - Zero Trust permission validation
 *
 * @module agent-executor/executor
 */

import { streamText, tool, stepCountIs, jsonSchema } from 'ai';
import { classifyRetryable } from './error-classification.js';
import type { ToolSet } from 'ai';
import { agentFactory } from '../agent-factory/index.js';
import type { StateView, Action } from '../../types/state.js';
import { createLogger } from '../../utils/logger.js';
import { getTracer, withSpan } from '../../utils/tracing.js';
import { v4 as uuidv4 } from 'uuid';
import type { TaintMetadata } from '../../types/state.js';
import { getTaintRegistry, propagateDerivedTaint } from '../../utils/taint.js';
import { buildSystemPrompt, buildTaskPrompt } from './prompts.js';
import { DEFAULT_AGENT_TIMEOUT_MS } from '../constants.js';
import { extractMemoryUpdates } from './memory.js';
import { validateMemoryUpdatePermissions } from './validation.js';
import { AgentTimeoutError, AgentExecutionError, type PartialUsage } from './errors.js';

const logger = createLogger('agent.executor');
const tracer = getTracer('orchestrator.agent');

/** Token usage from a single agent execution. */
export interface TokenUsage {
  /** The number of input tokens consumed. */
  inputTokens: number;
  /** The number of output tokens generated. */
  outputTokens: number;
  /** The total number of tokens (input + output). */
  totalTokens: number;
}


/**
 * Minimal shape of a single step returned by `streamText().steps`.
 *
 * The AI SDK's `StepResult<ToolSet>` generic has complex conditional types
 * that don't narrow cleanly when tools are dynamic, so we define the subset
 * we actually access.
 */
interface AgentStep {
  toolCalls?: Array<{
    toolCallId: string;
    toolName: string;
    args?: unknown;
    input?: unknown;
  }>;
  toolResults?: Array<{
    toolCallId?: string;
    result?: unknown;
  }>;
}

/**
 * Execute a single agent invocation against the LLM.
 *
 * @param agent_id - The database ID of the agent to execute.
 * @param stateView - The current workflow state, scoped to this agent's read permissions.
 * @param rawTools - Tool definitions to expose to the LLM.
 * @param attempt - The current attempt number (1-based, increments on retry).
 * @param options - Optional execution configuration.
 * @param options.temperature_override - Override the agent's configured temperature.
 * @param options.node_id - The graph node ID, used to derive the fallback memory key.
 * @param options.timeout_ms - Override the default agent timeout.
 * @param options.abortSignal - External cancellation signal (e.g. workflow cancellation).
 * @param options.onToken - Callback invoked for each streamed token (best-effort).
 * @param options.onToolCall - Callback invoked when a tool call starts executing. Receives tool name, args, and call ID.
 * @param options.onToolCallComplete - Callback invoked when a tool call finishes. Receives tool name, call ID, duration, and success/error.
 * @returns The resulting {@link Action} containing memory updates and metadata.
 * @throws {AgentTimeoutError} If the LLM call exceeds the configured timeout.
 * @throws {AgentExecutionError} If the LLM call fails for any other reason.
 */
export async function executeAgent(
  agent_id: string,
  stateView: StateView,
  rawTools: Record<string, unknown>,
  attempt: number,
  options?: {
    temperature_override?: number;
    node_id?: string;
    timeout_ms?: number;
    abortSignal?: AbortSignal;
    onToken?: (token: string) => void;
    onToolCall?: (event: { toolName: string; toolCallId: string; args: unknown }) => void;
    onToolCallComplete?: (event: { toolName: string; toolCallId: string; durationMs: number; success: boolean; error?: string }) => void;
    drainTaintEntries?: (tools?: Record<string, unknown>) => Map<string, TaintMetadata>;
    /** Override the model from agent config (used by budget-aware model resolution). */
    model_override?: string;
    /** Context compressor for memory serialization in prompts. */
    contextCompressor?: import('../context-compressor.js').ContextCompressor;
    /** Callback fired when context compression runs. */
    onContextCompressed?: (metrics: import('../context-compressor.js').ContextCompressionMetrics) => void;
    /** Default write key from node config for orchestrator-managed text output. */
    default_write_key?: string;
    /**
     * Memory retriever to call before prompt construction. Combined with
     * `memory_query` and rendered into the system prompt's Relevant Memory section.
     */
    memoryRetriever?: import('../memory-retriever.js').MemoryRetriever;
    /**
     * Per-node retrieval directive. When set alongside `memoryRetriever`,
     * the executor awaits a retrieval call and feeds the result into
     * `buildSystemPrompt`. Defaults `text` to `stateView.goal` if neither
     * `text` nor `entityIds` is set.
     */
    memory_query?: {
      text?: string;
      entityIds?: string[];
      tags?: string[];
      maxFacts?: number;
    };
  }
): Promise<Action> {
  return withSpan(tracer, 'agent.execute', async (span) => {
    span.setAttribute('agent.id', agent_id);
    span.setAttribute('agent.attempt', attempt);

    const startTime = Date.now();

    // Load agent config from database (cached)
    const config = await agentFactory.loadAgent(agent_id);
    // Budget-aware model resolution: use override if provided, else config.model
    const validatedOverride = options?.model_override && typeof options.model_override === 'string' && options.model_override.trim().length > 0
      ? options.model_override
      : undefined;

    if (options?.model_override && !validatedOverride) {
      logger.warn('invalid_model_override', {
        agent_id,
        node_id: options?.node_id,
        model_override: options.model_override,
        fallback_model: config.model,
      });
    }

    const effectiveConfig = validatedOverride
      ? { ...config, model: validatedOverride }
      : config;
    const model = agentFactory.getModel(effectiveConfig);

    // Wrap resolved tools into AI SDK v6 tool() format (before prompt so we
    // can detect save_to_memory presence for conditional instructions)
    const tools = buildToolSet(rawTools, agent_id);
    const hasSaveToMemoryTool = 'save_to_memory' in tools;

    // Resolve memory retrieval (best-effort — failures must never block
    // execution; the agent still gets the workflow-state memory below).
    const retrievedMemory = await retrieveForPrompt(
      options?.memoryRetriever,
      options?.memory_query,
      stateView,
      effectiveConfig.model,
    );

    // Build context-aware prompt (with injection guards)
    const systemPrompt = buildSystemPrompt(config, stateView, {
      contextCompressor: options?.contextCompressor,
      model: effectiveConfig.model,
      onCompressed: options?.onContextCompressed,
      hasSaveToMemoryTool,
      retrievedMemory,
    });
    const taskPrompt = buildTaskPrompt(stateView, attempt);

    logger.info('executing', {
      agent_id,
      agent_name: config.name,
      model: effectiveConfig.model,
      ...(options?.model_override ? { original_model: config.model } : {}),
      attempt,
      tool_count: Object.keys(tools).length,
    });

    // AbortController with configurable timeout to prevent hung LLM calls.
    // If an external abort signal is provided (workflow cancellation), combine
    // it with the internal timeout so either can abort the stream.
    const timeoutMs = options?.timeout_ms ?? DEFAULT_AGENT_TIMEOUT_MS;
    const { timeoutId, controller } = createAbortControllerWithTimeout(timeoutMs);

    // Combine external cancellation signal with internal timeout
    const combinedSignal = options?.abortSignal
      ? AbortSignal.any([controller.signal, options.abortSignal])
      : controller.signal;

    let text: string;
    let usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;
    let steps: AgentStep[];
    // Hoisted so the catch can best-effort read partial usage on failure —
    // a failed/timed-out attempt may still have spent tokens, which must be
    // accounted for (a max_retries:3 node can otherwise spend ~4× its visible
    // budget uncounted).
    let result: Awaited<ReturnType<typeof streamText>> | undefined;

    try {
      // Execute agent with streaming
      // stopWhen enables multi-step tool use: LLM generates text, calls tools,
      // sees results, and can call more tools — critical for save_to_memory
      result = await streamText({
        model,
        system: systemPrompt,
        prompt: taskPrompt,
        tools,
        stopWhen: stepCountIs(config.maxSteps),
        abortSignal: combinedSignal,
        ...(options?.temperature_override !== undefined ? { temperature: options.temperature_override } : {}),
        ...(config.providerOptions ? { providerOptions: config.providerOptions } : {}),
        // Real-time tool call callbacks — fire as tools execute, not post-hoc
        ...(options?.onToolCall ? {
          experimental_onToolCallStart: (event) => {
            try {
              const tc = event.toolCall;
              options.onToolCall!({
                toolName: tc.toolName,
                toolCallId: tc.toolCallId,
                args: 'args' in tc ? tc.args : ('input' in tc ? tc.input : undefined),
              });
            } catch { /* best-effort */ }
          },
        } : {}),
        ...(options?.onToolCallComplete ? {
          experimental_onToolCallFinish: (event) => {
            try {
              options.onToolCallComplete!({
                toolName: event.toolCall.toolName,
                toolCallId: event.toolCall.toolCallId,
                durationMs: event.durationMs,
                success: event.success,
                ...(!event.success ? { error: String(event.error) } : {}),
              });
            } catch { /* best-effort */ }
          },
        } : {}),
      });

      // When onToken is provided, consume the textStream for token-by-token
      // streaming. Otherwise use the existing await path (zero overhead).
      if (options?.onToken) {
        text = '';
        for await (const delta of result.textStream) {
          text += delta;
          try { options.onToken(delta); } catch { /* best-effort streaming */ }
        }
      } else {
        text = await result.text;
      }

      // Track AGGREGATE token usage across ALL tool-use rounds
      usage = await result.totalUsage;

      // Extract tool calls and results from ALL steps.
      steps = ((await result.steps) ?? []) as AgentStep[];
    } catch (error) {
      // Best-effort: a failed/aborted attempt may still have spent tokens.
      // Read them so the runner can account for failed-attempt spend instead
      // of discarding it. Bounded so a never-settling promise can't hang the
      // error path; any rejection is swallowed (usage simply stays absent).
      const partialUsage = await capturePartialUsage(result, config.model);

      if (error instanceof Error && error.name === 'AbortError') {
        const duration = Date.now() - startTime;
        logger.error('agent_timeout', error, {
          agent_id,
          timeout_ms: timeoutMs,
          duration_ms: duration,
        });
        span.setAttribute('agent.error', 'timeout');
        throw new AgentTimeoutError(agent_id, timeoutMs, partialUsage);
      }

      // Structured error handling — log and re-wrap
      const duration = Date.now() - startTime;
      logger.error('agent_execution_failed', error, {
        agent_id,
        model: config.model,
        attempt,
        duration_ms: duration,
      });
      span.setAttribute('agent.error', error instanceof Error ? error.message : String(error));
      throw new AgentExecutionError(agent_id, error, partialUsage, classifyRetryable(error));
    } finally {
      clearTimeout(timeoutId);
    }

    const tokenUsage: TokenUsage = {
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      totalTokens: usage?.totalTokens ?? 0,
    };

    // Flatten tool calls and results from all steps
    const toolCalls = steps.flatMap((step) => step.toolCalls ?? []);
    const toolResults = steps.flatMap((step) => step.toolResults ?? []);

    // Build a lookup map for tool results by toolCallId (not index).
    // Index-based alignment breaks when a call has no result or steps
    // have variable numbers of calls.
    const toolResultById = new Map<string, unknown>();
    for (const tr of toolResults) {
      if (tr.toolCallId) {
        toolResultById.set(tr.toolCallId, tr.result);
      }
    }

    // Log individual tool calls for observability
    for (const call of toolCalls) {
      logger.info('tool_called', {
        agent_id,
        tool_name: call.toolName,
        tool_call_id: call.toolCallId,
      });
      logger.debug('tool_call_detail', {
        agent_id,
        tool_name: call.toolName,
        tool_call_id: call.toolCallId,
        args: call.input ?? call.args,
      });
    }

    // Extract memory updates from tool results
    const fallbackKey = options?.node_id ? `${options.node_id}_output` : 'agent_response';
    const memoryUpdates = extractMemoryUpdates(text, toolCalls, config.write_keys, fallbackKey, options?.default_write_key);

    // Apply MCP taint: if any MCP tools were called during this execution,
    // mark all output memory keys as tainted by MCP tool origin.
    const mcpToolCalls = toolCalls.filter((c) => c.toolName !== 'save_to_memory');
    // Pass the toolset so taint is drained from THIS execution's collector —
    // race-free when sibling executions (voting/evolution/map) run concurrently.
    const mcpTaintEntries = options?.drainTaintEntries?.(rawTools);

    // Propagate taint: if any input memory keys were tainted, mark outputs as derived-tainted
    const outputKeys = Object.keys(memoryUpdates);
    if (outputKeys.length > 0) {
      const taintUpdates = propagateDerivedTaint(stateView.memory, outputKeys, agent_id);

      // Merge MCP direct taint: when MCP tools were called and taint entries exist,
      // apply mcp_tool taint to all output keys (we can't trace which specific
      // MCP result ended up in which key, so taint conservatively)
      if (mcpToolCalls.length > 0 && mcpTaintEntries && mcpTaintEntries.size > 0) {
        for (const key of outputKeys) {
          if (key === '_taint_registry') continue;
          // Use the first taint entry as representative (all originated from MCP tools in this execution)
          const [, firstEntry] = mcpTaintEntries.entries().next().value as [string, TaintMetadata];
          taintUpdates[key] = {
            source: 'mcp_tool',
            tool_name: [...new Set(mcpToolCalls.map((c) => c.toolName))].join(','),
            server_id: firstEntry.server_id,
            agent_id,
            created_at: new Date().toISOString(),
          };
        }
      }

      if (Object.keys(taintUpdates).length > 0) {
        const existingRegistry = getTaintRegistry(stateView.memory);
        memoryUpdates['_taint_registry'] = { ...existingRegistry, ...taintUpdates };
      }
    }

    // Collect tool execution metadata separately — not stored in memory
    // Correlate by toolCallId for correctness
    const toolExecutions = toolCalls
      .filter((call) => call.toolName !== 'save_to_memory')
      .map((call) => ({
        tool: call.toolName,
        args: call.input ?? call.args,
        result: toolResultById.get(call.toolCallId),
      }));

    const duration = Date.now() - startTime;

    // Build action — internal metadata is in metadata, not polluting memory
    const action: Action = {
      id: uuidv4(),
      idempotency_key: uuidv4(),
      type: 'update_memory',
      payload: {
        updates: memoryUpdates,
      },
      metadata: {
        node_id: agent_id,
        agent_id: agent_id,
        model: effectiveConfig.model,
        ...(options?.model_override ? {
          model_resolution: {
            original_model: config.model,
            resolved_model: options.model_override,
          },
        } : {}),
        timestamp: new Date(),
        attempt,
        duration_ms: duration,
        token_usage: tokenUsage,
        tool_executions: toolExecutions.length > 0 ? toolExecutions : undefined,
      },
    };

    logger.info('completed', {
      agent_id,
      duration_ms: duration,
      tool_calls: toolCalls.length,
      tool_names: [...new Set(toolCalls.map((c) => c.toolName))].join(','),
      input_tokens: tokenUsage.inputTokens,
      output_tokens: tokenUsage.outputTokens,
      total_tokens: tokenUsage.totalTokens,
      memory_keys_updated: Object.keys(memoryUpdates),
    });

    // Add span attributes for observability
    span.setAttribute('agent.model', effectiveConfig.model);
    span.setAttribute('agent.provider', config.provider);
    span.setAttribute('agent.duration_ms', duration);
    span.setAttribute('agent.tokens.input', tokenUsage.inputTokens);
    span.setAttribute('agent.tokens.output', tokenUsage.outputTokens);
    span.setAttribute('agent.tokens.total', tokenUsage.totalTokens);
    span.setAttribute('agent.tools_called', toolCalls.length);

    // Validate against Zero Trust permissions
    validateMemoryUpdatePermissions(action, config.write_keys);

    return action;
  });
}

/**
 * Resolve memory for the upcoming agent prompt via the injected
 * `memoryRetriever`. Best-effort: any failure is logged and swallowed so
 * a downed knowledge store never blocks the workflow. Returns `null` when
 * no retriever or no query is provided.
 *
 * Defaults `text` to `stateView.goal` when neither `text` nor `entityIds`
 * is set on the query so RAG-style use cases work with `memory_query: {}`.
 */
async function retrieveForPrompt(
  retriever: import('../memory-retriever.js').MemoryRetriever | undefined,
  rawQuery:
    | { text?: string; entityIds?: string[]; tags?: string[]; maxFacts?: number }
    | undefined,
  stateView: StateView,
  model: string,
): Promise<import('../memory-retriever.js').MemoryRetrievalResult | null> {
  if (!retriever || !rawQuery) return null;

  const query: { text?: string; entityIds?: string[]; tags?: string[] } = {};
  if (rawQuery.text) query.text = rawQuery.text;
  if (rawQuery.entityIds && rawQuery.entityIds.length > 0) query.entityIds = rawQuery.entityIds;
  if (rawQuery.tags && rawQuery.tags.length > 0) query.tags = rawQuery.tags;

  // Default text to goal so RAG-style use (`memory_query: {}`) needs zero
  // configuration. Skip the fallback when tags or entityIds are present —
  // those queries are intentional and adding a goal-derived text would
  // muddy the retriever's intent.
  if (
    query.text === undefined &&
    query.entityIds === undefined &&
    query.tags === undefined
  ) {
    query.text = stateView.goal;
  }

  try {
    return await retriever(query, {
      ...(rawQuery.maxFacts !== undefined ? { maxFacts: rawQuery.maxFacts } : {}),
      model,
    });
  } catch (err) {
    logger.warn('memory_retriever_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Create an {@link AbortController} that auto-aborts after the given timeout.
 *
 * @param timeoutMs - Milliseconds before the controller aborts.
 * @returns The timeout ID (for cleanup) and the controller.
 */
function createAbortControllerWithTimeout(timeoutMs: number) {
  const controller = new AbortController();
  return {
    timeoutId: setTimeout(() => controller.abort(), timeoutMs),
    controller,
  };
}

/**
 * Best-effort read of token usage from a streamText result after the call
 * failed or was aborted. Bounded by a short timeout so a never-settling
 * `totalUsage` promise can't hang the error path; any rejection or absence
 * yields `undefined` (no usage attributed — same as before this change, no
 * regression).
 */
async function capturePartialUsage(
  result: Awaited<ReturnType<typeof streamText>> | undefined,
  model: string,
): Promise<PartialUsage | undefined> {
  if (!result) return undefined;
  try {
    const usage = await Promise.race([
      result.totalUsage,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 200)),
    ]);
    if (!usage) return undefined;
    const total = usage.totalTokens ?? ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0));
    if (!total) return undefined;
    return {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      totalTokens: total,
      model,
    };
  } catch {
    return undefined;
  }
}

/**
 * Check whether a resolved tool entry is already a well-formed AI SDK `Tool`.
 *
 * The AI SDK `Tool` type discriminates on `type`:
 * - `undefined | 'function'` — standard tools created by `tool()`
 * - `'dynamic'`              — runtime tools created by `dynamicTool()` (e.g. `@ai-sdk/mcp`)
 * - `'provider'`             — provider-specific tools
 *
 * All three variants require `inputSchema` to be present, so we use that as
 * the structural guard in addition to `type`.
 *
 * @see https://github.com/vercel/ai — `@ai-sdk/provider-utils/src/types/tool.ts`
 */
function isAISDKTool(entry: Record<string, unknown>): boolean {
  const type = entry.type;
  const hasInputSchema = 'inputSchema' in entry;

  // dynamicTool() always sets type: 'dynamic'
  if (type === 'dynamic' && hasInputSchema) return true;

  // tool() leaves type undefined (or explicitly 'function')
  if ((type === undefined || type === 'function') && hasInputSchema) return true;

  // Provider tools have type: 'provider' + an id field
  if (type === 'provider' && typeof entry.id === 'string') return true;

  return false;
}

/**
 * Build an AI SDK {@link ToolSet} from resolved tool definitions.
 *
 * Tools arrive from `MCPConnectionManager.resolveTools()` in two shapes:
 *
 * 1. **Pre-formed AI SDK tools** (`dynamicTool()` objects from `@ai-sdk/mcp`,
 *    or `tool()` objects from other sources). Detected via {@link isAISDKTool}
 *    and passed through directly — re-wrapping would strip internal state.
 *
 * 2. **Raw tool definitions** — plain `{ description, parameters, execute }`
 *    objects (e.g. built-in tools like `save_to_memory`). Wrapped with the
 *    AI SDK `tool()` helper for schema validation.
 *
 * @param rawTools - Resolved tool definitions (may include execute callbacks).
 * @param agentId - The agent ID, for logging context.
 * @returns A {@link ToolSet} compatible with `streamText`.
 */
function buildToolSet(
  rawTools: Record<string, unknown>,
  agentId: string,
): ToolSet {
  const tools: ToolSet = {};

  for (const [name, raw] of Object.entries(rawTools)) {
    if (!raw || typeof raw !== 'object') {
      logger.warn('tool_skipped_invalid', { agent_id: agentId, tool_name: name, reason: 'not an object' });
      continue;
    }

    const entry = raw as Record<string, unknown>;

    // ── Pre-formed AI SDK tool ─────────────────────────────────────
    if (isAISDKTool(entry)) {
      tools[name] = raw as ToolSet[string];
      continue;
    }

    // ── Raw tool definition (built-in tools) ───────────────────────
    const description = entry.description;
    const schema = entry.inputSchema ?? entry.parameters;

    if (typeof description !== 'string' || !description) {
      logger.warn('tool_skipped_invalid', { agent_id: agentId, tool_name: name, reason: 'missing description' });
      continue;
    }

    if (!schema || typeof schema !== 'object') {
      logger.warn('tool_skipped_invalid', { agent_id: agentId, tool_name: name, reason: 'missing parameters/inputSchema' });
      continue;
    }

    const executeFn = typeof entry.execute === 'function'
      ? entry.execute as (args: Record<string, unknown>) => Promise<unknown>
      : undefined;

    tools[name] = tool({
      description,
      inputSchema: jsonSchema(schema as Parameters<typeof jsonSchema>[0]),
      execute: executeFn
        ? async (args: Record<string, unknown>) => executeFn(args)
        : async (args: Record<string, unknown>) => args,
    });
  }

  return tools;
}
