/**
 * Drizzle Persistence Provider
 *
 * Implements PersistenceProvider using Drizzle ORM + PostgreSQL.
 * Moved from libs/orchestrator/src/db/persistence.ts.
 */

import { db } from './connection.js';
import { graphs, workflow_runs, workflow_states, workflow_events } from './schema.js';
import type { GraphDefinitionJson, WorkflowStateJson } from './schema.js';
import { eq, desc, sql, and } from 'drizzle-orm';
import { retryOnTransient } from './retry.js';
import type {
  PersistenceProvider,
  GraphRow,
  WorkflowRunRow,
  WorkflowEventRow as IWorkflowEventRow,
  WorkflowStateJson as IWorkflowStateJson,
} from '@cycgraph/orchestrator';
import type { Graph } from '@cycgraph/orchestrator';
import type { WorkflowState } from '@cycgraph/orchestrator';
import { hydrateWorkflowState, StaleClaimError } from '@cycgraph/orchestrator';

type WorkflowStatus = 'pending' | 'scheduled' | 'running' | 'waiting' | 'retrying' | 'completed' | 'failed' | 'cancelled' | 'timeout';

const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled', 'timeout'];

// ─── Type Conversion Helpers ─────────────────────────────────────────

function toGraphDefinitionJson(graph: Graph): GraphDefinitionJson {
  return {
    id: graph.id,
    name: graph.name,
    nodes: graph.nodes as unknown[],
    edges: graph.edges as unknown[],
    start_node: graph.start_node,
    end_nodes: graph.end_nodes,
    description: graph.description,
  };
}

function fromGraphDefinitionJson(def: GraphDefinitionJson): Graph {
  return def as unknown as Graph;
}

export function toWorkflowStateJson(state: WorkflowState): WorkflowStateJson {
  return {
    workflow_id: state.workflow_id,
    run_id: state.run_id,
    status: state.status,
    current_node: state.current_node,
    memory: state.memory,
    goal: state.goal,
    constraints: state.constraints,
    iteration_count: state.iteration_count,
    visited_nodes: state.visited_nodes,
    supervisor_history: state.supervisor_history,
    total_tokens_used: state.total_tokens_used,
    max_token_budget: state.max_token_budget,
    started_at: state.started_at,
    created_at: state.created_at,
    updated_at: state.updated_at,
    retry_count: state.retry_count,
    max_retries: state.max_retries,
    last_error: state.last_error,
    waiting_for: state.waiting_for,
    waiting_since: state.waiting_since,
    waiting_timeout_at: state.waiting_timeout_at,
    max_execution_time_ms: state.max_execution_time_ms,
    max_iterations: state.max_iterations,
    compensation_stack: state.compensation_stack,
  };
}

// ─── DrizzlePersistenceProvider ──────────────────────────────────────

/** Fencing claim carried by a fenced provider/writer (see DrizzleWorkflowQueue). */
export interface RunClaim {
  run_id: string;
  epoch: number;
}

export interface DrizzlePersistenceProviderOptions {
  /**
   * When set, every state write for `fencing.run_id` verifies (inside the
   * write transaction, under `FOR UPDATE`) that the run's `claim_epoch`
   * still equals `fencing.epoch`, throwing {@link StaleClaimError} when
   * another worker has since claimed the run.
   */
  fencing?: RunClaim;
}

export class DrizzlePersistenceProvider implements PersistenceProvider {
  private readonly fencing?: RunClaim;

  constructor(options?: DrizzlePersistenceProviderOptions) {
    this.fencing = options?.fencing;
  }

  // ── Graph Operations ──

  async saveGraph(graph: Graph): Promise<void> {
    const now = new Date();
    const definition = toGraphDefinitionJson(graph);

    await db.insert(graphs).values({
      id: graph.id,
      name: graph.name,
      description: graph.description,
      definition,
      version: '1.0.0',
      created_at: now,
      updated_at: now,
    }).onConflictDoUpdate({
      target: graphs.id,
      set: {
        name: graph.name,
        description: graph.description,
        definition,
        updated_at: now,
      },
    });
  }

  async loadGraph(graph_id: string): Promise<Graph | null> {
    const result = await db
      .select()
      .from(graphs)
      .where(eq(graphs.id, graph_id))
      .limit(1);

    const definition = result[0]?.definition ?? null;
    return definition ? fromGraphDefinitionJson(definition) : null;
  }

  async listGraphs(opts: { limit?: number; offset?: number } = {}): Promise<GraphRow[]> {
    const { limit = 100, offset = 0 } = opts;
    return db
      .select()
      .from(graphs)
      .orderBy(desc(graphs.updated_at))
      .limit(limit)
      .offset(offset);
  }

  // ── Workflow Run Operations ──

  async saveWorkflowRun(state: WorkflowState): Promise<void> {
    const isTerminal = TERMINAL_STATUSES.includes(state.status);
    const status = state.status as WorkflowStatus;

    await db.insert(workflow_runs).values({
      id: state.run_id,
      graph_id: state.workflow_id,
      status,
      created_at: state.created_at ?? new Date(),
      completed_at: isTerminal ? new Date() : null,
    }).onConflictDoUpdate({
      target: workflow_runs.id,
      set: {
        status,
        completed_at: isTerminal ? new Date() : null,
      },
    });
  }

  async loadWorkflowRun(run_id: string): Promise<WorkflowRunRow | null> {
    const result = await db
      .select()
      .from(workflow_runs)
      .where(eq(workflow_runs.id, run_id))
      .limit(1);

    return result[0] ?? null;
  }

  async listWorkflowRuns(opts: { limit?: number; offset?: number } = {}): Promise<WorkflowRunRow[]> {
    const { limit = 100, offset = 0 } = opts;
    return db
      .select()
      .from(workflow_runs)
      .orderBy(desc(workflow_runs.created_at))
      .limit(limit)
      .offset(offset);
  }

  async updateRunStatus(runId: string, status: string): Promise<number> {
    const isTerminal = TERMINAL_STATUSES.includes(status);
    const result = await db
      .update(workflow_runs)
      .set({
        status: status as WorkflowStatus,
        completed_at: isTerminal ? new Date() : null,
      })
      .where(eq(workflow_runs.id, runId))
      .returning({ id: workflow_runs.id });

    return result.length;
  }

  // ── Workflow State Operations ──

  async saveWorkflowState(state: WorkflowState): Promise<void> {
    const stateJson = toWorkflowStateJson(state);

    // The MAX(version) + 1 increment races against concurrent writers — all
    // see the same MAX and try to insert the same nextVersion. The unique
    // constraint `uq_workflow_states_run_version` rejects all-but-one. We
    // retry the entire transaction with backoff so the race is invisible to
    // callers. `fn` is idempotent: re-reading MAX inside a fresh transaction
    // produces the next correct version.
    await retryOnTransient(() =>
      db.transaction(async (tx) => {
        await this.assertClaim(tx, state.run_id);

        const maxVersionResult = await tx
          .select({ maxVersion: sql<number>`COALESCE(MAX(${workflow_states.version}), 0)` })
          .from(workflow_states)
          .where(eq(workflow_states.run_id, state.run_id));
        const nextVersion = (maxVersionResult[0]?.maxVersion ?? 0) + 1;

        await tx.insert(workflow_states).values({
          run_id: state.run_id,
          version: nextVersion,
          state: stateJson,
          current_node: state.current_node,
          status: state.status as WorkflowStatus,
          created_at: new Date(),
          updated_at: new Date(),
        });
      }),
    );
  }

  /**
   * Fencing check: verify (under `FOR UPDATE`, so the check is atomic with
   * the enclosing write) that this provider's claim epoch is still the
   * run's current epoch. No-ops when fencing is not configured or the
   * write targets a different run.
   *
   * @throws {StaleClaimError} When another worker has claimed the run.
   */
  private async assertClaim(
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    runId: string,
  ): Promise<void> {
    if (!this.fencing || this.fencing.run_id !== runId) return;
    const rows = await tx
      .select({ claim_epoch: workflow_runs.claim_epoch })
      .from(workflow_runs)
      .where(eq(workflow_runs.id, runId))
      .for('update');
    const current = rows[0]?.claim_epoch;
    if (current !== undefined && current !== this.fencing.epoch) {
      throw new StaleClaimError(runId, this.fencing.epoch, current);
    }
  }

  async loadLatestWorkflowState(run_id: string): Promise<WorkflowState | null> {
    const result = await db
      .select()
      .from(workflow_states)
      .where(eq(workflow_states.run_id, run_id))
      .orderBy(desc(workflow_states.version))
      .limit(1);

    const state = result[0]?.state ?? null;
    if (state === null) return null;
    // jsonb loses Date types — hydrate (migrate + parse + coerce dates)
    // instead of casting, so resumed runs get real Date fields back.
    return hydrateWorkflowState(state);
  }

  async loadWorkflowStateHistory(
    run_id: string,
    opts: { limit?: number; offset?: number } = {},
  ): Promise<{ version: number; status: string; current_node: string | null; created_at: Date; total_tokens_used: number | null }[]> {
    const { limit = 50, offset = 0 } = opts;
    return db
      .select({
        version: workflow_states.version,
        status: workflow_states.status,
        current_node: workflow_states.current_node,
        created_at: workflow_states.created_at,
        total_tokens_used: sql<number | null>`(${workflow_states.state}->>'total_tokens_used')::integer`,
      })
      .from(workflow_states)
      .where(eq(workflow_states.run_id, run_id))
      .orderBy(workflow_states.version)
      .limit(limit)
      .offset(offset);
  }

  async loadWorkflowStateAtVersion(
    run_id: string,
    version: number,
  ): Promise<IWorkflowStateJson | null> {
    const result = await db
      .select()
      .from(workflow_states)
      .where(
        and(
          eq(workflow_states.run_id, run_id),
          eq(workflow_states.version, version),
        ),
      )
      .limit(1);
    return (result[0]?.state as unknown as IWorkflowStateJson) ?? null;
  }

  // ── Atomic Snapshot ──

  async saveWorkflowSnapshot(state: WorkflowState): Promise<void> {
    // Same version-increment race as `saveWorkflowState` — retry on transient
    // unique-violation conflicts. The run update is idempotent
    // (`onConflictDoUpdate`); the state insert is what races.
    await retryOnTransient(() =>
      db.transaction(async (tx) => {
        await this.assertClaim(tx, state.run_id);

        // Save workflow run
        const isTerminal = TERMINAL_STATUSES.includes(state.status);
        const status = state.status as WorkflowStatus;

        await tx.insert(workflow_runs).values({
          id: state.run_id,
          graph_id: state.workflow_id,
          status,
          created_at: state.created_at ?? new Date(),
          completed_at: isTerminal ? new Date() : null,
        }).onConflictDoUpdate({
          target: workflow_runs.id,
          set: {
            status,
            completed_at: isTerminal ? new Date() : null,
          },
        });

        // Save workflow state
        const stateJson = toWorkflowStateJson(state);
        const maxVersionResult = await tx
          .select({ maxVersion: sql<number>`COALESCE(MAX(${workflow_states.version}), 0)` })
          .from(workflow_states)
          .where(eq(workflow_states.run_id, state.run_id));
        const nextVersion = (maxVersionResult[0]?.maxVersion ?? 0) + 1;

        await tx.insert(workflow_states).values({
          run_id: state.run_id,
          version: nextVersion,
          state: stateJson,
          current_node: state.current_node,
          status: state.status as WorkflowStatus,
          created_at: new Date(),
          updated_at: new Date(),
        });
      }),
    );
  }

  // ── Event Queries ──

  async loadEvents(run_id: string): Promise<IWorkflowEventRow[]> {
    const rows = await db
      .select()
      .from(workflow_events)
      .where(eq(workflow_events.run_id, run_id))
      .orderBy(workflow_events.sequence_id);
    return rows;
  }
}
