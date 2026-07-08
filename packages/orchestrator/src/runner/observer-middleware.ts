/**
 * Observer Middleware
 *
 * Deterministic, zero-LLM-cost health checks that run inline via
 * `afterReduce`. Detects token waste, iteration budget pressure,
 * and supervisor routing stalls — emitting structured warnings
 * through the logger so operators can intervene before a workflow
 * fails.
 *
 * Optionally runs a **diagnostic agent** on workflow completion
 * that analyzes the collected findings against the graph definition
 * and agent configs to explain *why* each issue occurred and what
 * to fix.
 *
 * ```typescript
 * import { createObserverMiddleware } from '@cycgraph/orchestrator';
 *
 * const runner = new GraphRunner(graph, state, {
 *   middleware: [createObserverMiddleware({
 *     diagnosticAgent: {
 *       provider: 'anthropic',
 *       model: 'claude-sonnet-4-6',
 *       onDiagnostic: (report) => console.log(report),
 *     },
 *   })],
 * });
 * ```
 *
 * @module runner/observer-middleware
 */

import type { GraphRunnerMiddleware } from './middleware.js';
import type { Graph } from '../types/graph.js';
import type { WorkflowState, Action } from '../types/state.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('runner.observer');

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'timeout']);

// ─── Configuration ──────────────────────────────────────────────────────

/** Configuration for {@link createObserverMiddleware}. */
export interface ObserverMiddlewareOptions {
  /**
   * Flag an agent that consumes more than this many tokens in a single
   * node execution without producing any memory updates.
   * @default 10_000
   */
  tokenBurnThreshold?: number;

  /**
   * Emit a warning when `iteration_count / max_iterations` exceeds
   * this fraction.
   * @default 0.7
   */
  iterationWarnRatio?: number;

  /**
   * Emit a critical alert when `iteration_count / max_iterations`
   * exceeds this fraction.
   * @default 0.9
   */
  iterationAlertRatio?: number;

  /**
   * Detect a stall when the supervisor delegates to the same node
   * this many times consecutively.
   * @default 3
   */
  stallThreshold?: number;

  /**
   * Optional callback invoked on every finding. Use this to integrate
   * with alerting systems, metrics, or external dashboards.
   */
  onFinding?: (finding: ObserverFinding) => void;

  /**
   * Optional LLM diagnostic agent configuration. When provided and
   * findings exist, the middleware makes a single `generateText` call
   * on workflow completion to analyze what caused each finding and
   * recommend specific fixes (prompts, graph wiring, agent configs).
   */
  diagnosticAgent?: DiagnosticAgentOptions;
}

/** Configuration for the post-run diagnostic LLM agent. */
export interface DiagnosticAgentOptions {
  /** LLM provider name (e.g. `'anthropic'`, `'openai'`). */
  provider: string;
  /** Model ID (e.g. `'claude-sonnet-4-6'`). */
  model: string;
  /** Callback that receives the diagnostic report. */
  onDiagnostic: (report: string, findings: ObserverFinding[]) => void;
  /**
   * When `true`, run the diagnostic agent on every workflow completion —
   * even when no findings were detected. Produces a brief health check
   * confirming the run was clean.
   * @default false
   */
  alwaysRun?: boolean;
}

/** Severity levels for observer findings. */
export type ObserverSeverity = 'info' | 'warning' | 'critical';

/** A single finding emitted by the observer middleware. */
export interface ObserverFinding {
  /** Severity of the finding. */
  severity: ObserverSeverity;
  /** Short category tag. */
  category: 'token_burn' | 'iteration_budget' | 'stall_detected';
  /** Human-readable description. */
  message: string;
  /** Structured context for programmatic consumption. */
  context: Record<string, unknown>;
}

// ─── Factory ────────────────────────────────────────────────────────────

/**
 * Create a middleware that performs deterministic health checks after
 * every state reduction. Zero LLM cost — purely computation-based.
 *
 * Checks:
 * 1. **Token burn** — agent used many tokens without saving to memory
 * 2. **Iteration budget** — approaching max_iterations (warn at 70%, alert at 90%)
 * 3. **Stall detection** — supervisor routing to same node N+ times consecutively
 */
export function createObserverMiddleware(
  options: ObserverMiddlewareOptions = {},
): GraphRunnerMiddleware {
  const {
    tokenBurnThreshold = 10_000,
    iterationWarnRatio = 0.7,
    iterationAlertRatio = 0.9,
    stallThreshold = 3,
    onFinding,
    diagnosticAgent,
  } = options;

  // Track which iteration thresholds have already fired to avoid spamming
  let warnFired = false;
  let alertFired = false;
  let diagnosticFired = false;

  // Accumulate findings for the diagnostic agent
  const findings: ObserverFinding[] = [];

  function emit(finding: ObserverFinding): void {
    const logMethod = finding.severity === 'critical'
      ? 'error'
      : finding.severity === 'warning'
        ? 'warn'
        : 'info';

    logger[logMethod](`observer.${finding.category}`, finding.context);
    findings.push(finding);
    onFinding?.(finding);
  }

  return {
    afterReduce: async (ctx, action, newState) => {
      checkTokenBurn(action, newState, tokenBurnThreshold, emit);
      checkIterationBudget(newState, iterationWarnRatio, iterationAlertRatio, warnFired, alertFired, emit, (w, a) => { warnFired = w; alertFired = a; });
      checkStall(newState, stallThreshold, emit);

      // Run diagnostic agent once on terminal state
      const shouldRunDiagnostic = diagnosticAgent &&
        !diagnosticFired &&
        TERMINAL_STATUSES.has(newState.status) &&
        (findings.length > 0 || diagnosticAgent.alwaysRun);

      if (shouldRunDiagnostic) {
        diagnosticFired = true;
        // Fire and forget — don't block the runner
        runDiagnosticAgent(diagnosticAgent, findings, ctx.graph, newState).catch(err => {
          logger.error('observer.diagnostic_agent_error', { error: (err as Error).message });
        });
      }
    },
  };
}

// ─── Check implementations ──────────────────────────────────────────────

/**
 * Token burn: an agent node consumed significant tokens but produced
 * no memory updates (the `updates` field in `update_memory` payload
 * is empty or absent).
 */
function checkTokenBurn(
  action: Action,
  _newState: Readonly<WorkflowState>,
  threshold: number,
  emit: (f: ObserverFinding) => void,
): void {
  if (action.type !== 'update_memory') return;

  const totalTokens = action.metadata.token_usage?.totalTokens ?? 0;
  if (totalTokens < threshold) return;

  const updates = action.payload.updates as Record<string, unknown> | undefined;
  const updatedKeys = updates ? Object.keys(updates).filter(k => !k.startsWith('_')) : [];

  if (updatedKeys.length === 0) {
    emit({
      severity: 'warning',
      category: 'token_burn',
      message: `Agent "${action.metadata.node_id}" used ${totalTokens} tokens without saving any memory updates`,
      context: {
        node_id: action.metadata.node_id,
        agent_id: action.metadata.agent_id,
        total_tokens: totalTokens,
        model: action.metadata.model,
        duration_ms: action.metadata.duration_ms,
      },
    });
  }
}

/**
 * Iteration budget: warn when approaching max_iterations so operators
 * can investigate before the workflow times out.
 */
function checkIterationBudget(
  newState: Readonly<WorkflowState>,
  warnRatio: number,
  alertRatio: number,
  warnFired: boolean,
  alertFired: boolean,
  emit: (f: ObserverFinding) => void,
  setFlags: (warn: boolean, alert: boolean) => void,
): void {
  const { iteration_count, max_iterations } = newState;
  if (!max_iterations || max_iterations <= 0) return;

  const ratio = iteration_count / max_iterations;

  if (!alertFired && ratio >= alertRatio) {
    emit({
      severity: 'critical',
      category: 'iteration_budget',
      message: `Iteration budget critical: ${iteration_count}/${max_iterations} (${Math.round(ratio * 100)}%)`,
      context: {
        iteration_count,
        max_iterations,
        ratio: Math.round(ratio * 100),
        current_node: newState.current_node,
        status: newState.status,
      },
    });
    setFlags(true, true);
  } else if (!warnFired && ratio >= warnRatio) {
    emit({
      severity: 'warning',
      category: 'iteration_budget',
      message: `Iteration budget warning: ${iteration_count}/${max_iterations} (${Math.round(ratio * 100)}%)`,
      context: {
        iteration_count,
        max_iterations,
        ratio: Math.round(ratio * 100),
        current_node: newState.current_node,
        status: newState.status,
      },
    });
    setFlags(true, alertFired);
  }
}

/**
 * Stall detection: supervisor delegated to the same node N+ times
 * consecutively. This usually means the supervisor is confused about
 * state or the delegated node is failing silently.
 */
function checkStall(
  newState: Readonly<WorkflowState>,
  threshold: number,
  emit: (f: ObserverFinding) => void,
): void {
  const history = newState.supervisor_history;
  if (!history || history.length < threshold) return;

  // Check the last N entries for consecutive delegation to the same node
  const tail = history.slice(-threshold);
  const allSameNode = tail.every(e => e.delegated_to === tail[0].delegated_to);

  if (allSameNode) {
    const targetNode = tail[0].delegated_to;
    const supervisorId = tail[0].supervisor_id;

    emit({
      severity: 'warning',
      category: 'stall_detected',
      message: `Supervisor "${supervisorId}" delegated to "${targetNode}" ${threshold} times consecutively`,
      context: {
        supervisor_id: supervisorId,
        delegated_to: targetNode,
        consecutive_count: threshold,
        recent_reasoning: tail.map(e => e.reasoning),
        iteration_count: newState.iteration_count,
      },
    });
  }
}

// ─── Diagnostic Agent ───────────────────────────────────────────────────

const DIAGNOSTIC_SYSTEM_PROMPT = `You are a workflow diagnostician. You receive:
1. A list of findings (issues detected during workflow execution — may be empty for clean runs)
2. The graph definition (nodes, edges, supervisor config)
3. A state summary (visited nodes, supervisor history, token usage)

If findings exist, for each one explain:
- **Root cause**: What in the graph definition, agent prompt, or workflow design caused this
- **Specific fix**: The exact change to make (which node, which config field, what prompt edit)
- **Prevention**: How to prevent this class of issue in future workflows

If no findings exist, produce a brief health check:
- Confirm the workflow completed cleanly
- Note any metrics worth watching (token efficiency, iteration usage ratio)
- Flag anything that isn't a problem yet but could become one at scale

Be specific — reference node IDs, agent configs, and prompt text. Do not give generic advice.
Format as a concise markdown report.`;

/**
 * Run a single LLM call to diagnose the accumulated findings.
 * Uses dynamic import to avoid loading the AI SDK unless actually needed.
 */
async function runDiagnosticAgent(
  config: DiagnosticAgentOptions,
  findings: ObserverFinding[],
  graph: Readonly<Graph>,
  finalState: Readonly<WorkflowState>,
): Promise<void> {
  const { generateText } = await import('ai');
  const { createProviderRegistry } = await import('../agent/provider-registry.js');

  const providers = createProviderRegistry();
  const model = providers.resolveModel(config.provider, config.model);

  // Build a compact graph summary (strip large fields)
  const graphSummary = {
    name: graph.name,
    nodes: graph.nodes.map(n => ({
      id: n.id,
      type: n.type,
      agent_id: n.agent_id,
      read_keys: n.read_keys,
      write_keys: n.write_keys,
      supervisor_config: n.supervisor_config,
      map_reduce_config: n.map_reduce_config,
    })),
    edges: graph.edges,
    start_node: graph.start_node,
    end_nodes: graph.end_nodes,
  };

  const stateSummary = {
    status: finalState.status,
    visited_nodes: finalState.visited_nodes,
    supervisor_history: finalState.supervisor_history,
    total_tokens_used: finalState.total_tokens_used,
    total_cost_usd: finalState.total_cost_usd,
    iteration_count: finalState.iteration_count,
    max_iterations: finalState.max_iterations,
    last_error: finalState.last_error,
    memory_keys: Object.keys(finalState.memory),
  };

  const userPrompt = [
    '## Findings\n',
    JSON.stringify(findings, null, 2),
    '\n## Graph Definition\n',
    JSON.stringify(graphSummary, null, 2),
    '\n## Final State Summary\n',
    JSON.stringify(stateSummary, null, 2),
  ].join('\n');

  logger.info('observer.diagnostic_agent_running', { finding_count: findings.length });

  const result = await generateText({
    model,
    system: DIAGNOSTIC_SYSTEM_PROMPT,
    prompt: userPrompt,
  });

  logger.info('observer.diagnostic_agent_complete', {
    input_tokens: result.usage?.inputTokens,
    output_tokens: result.usage?.outputTokens,
  });

  config.onDiagnostic(result.text, findings);
}
