/**
 * Drizzle Persistence Provider
 *
 * Implements PersistenceProvider using Drizzle ORM + PostgreSQL.
 * Moved from libs/orchestrator/src/db/persistence.ts.
 */

import { db } from './connection.js';
import { graphs, workflow_runs, workflow_states, workflow_events } from './schema.js';
import type { GraphDefinitionJson, WorkflowStateJson } from './schema.js';
import { eq, desc, sql, and, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { retryOnTransient } from './retry.js';
import { withTenant, type Tx, type TenantContext } from './tenancy.js';
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

/** A query handle usable for both standalone (`db`) and tenant-scoped (`tx`) work. */
type Queryer = typeof db | Tx;

export interface DrizzlePersistenceProviderOptions {
  /**
   * When set, every state write for `fencing.run_id` verifies (inside the
   * write transaction, under `FOR UPDATE`) that the run's `claim_epoch`
   * still equals `fencing.epoch`, throwing {@link StaleClaimError} when
   * another worker has since claimed the run.
   */
  fencing?: RunClaim;
  /**
   * Tenant this provider operates on behalf of. When set, every read/write is
   * isolated to the tenant: inserts stamp `tenant_id`, reads/updates carry a
   * `tenant_id` filter, and all work runs inside {@link withTenant} so RLS
   * applies once enforced. When omitted, the provider is single-tenant
   * (backward-compatible): inserts fall to the column default and no tenant
   * filter is applied. The app-level filter — not RLS — is what isolates
   * tenants during the expand→enforce window (RLS is not enabled yet).
   */
  tenant?: TenantContext;
}

export class DrizzlePersistenceProvider implements PersistenceProvider {
  private readonly fencing?: RunClaim;
  private readonly tenant?: TenantContext;

  constructor(options?: DrizzlePersistenceProviderOptions) {
    this.fencing = options?.fencing;
    this.tenant = options?.tenant;
  }

  /** The `{ tenant_id }` fragment to merge into an insert's values (empty when single-tenant). */
  private get tenantValues(): { tenant_id: string } | Record<string, never> {
    return this.tenant ? { tenant_id: this.tenant.tenant_id } : {};
  }

  /** A `tenant_id = <tenant>` condition, or `undefined` (ignored by `and()`) when single-tenant. */
  private tenantEq(col: AnyPgColumn): SQL | undefined {
    return this.tenant ? eq(col, this.tenant.tenant_id) : undefined;
  }

  /** Run a single read with a query handle — tenant-scoped (inside withTenant) or the shared db. */
  private read<T>(fn: (q: Queryer) => Promise<T>): Promise<T> {
    return this.tenant ? withTenant(this.tenant.tenant_id, fn) : fn(db);
  }

  /** Run an atomic multi-statement write in one transaction — tenant-scoped or plain. */
  private tx<T>(fn: (tx: Queryer) => Promise<T>): Promise<T> {
    return this.tenant ? withTenant(this.tenant.tenant_id, fn) : db.transaction(fn);
  }

  // ── Graph Operations ──

  async saveGraph(graph: Graph): Promise<void> {
    const now = new Date();
    const definition = toGraphDefinitionJson(graph);

    await this.read((q) => q.insert(graphs).values({
      id: graph.id,
      ...this.tenantValues,
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
    }));
  }

  async loadGraph(graph_id: string): Promise<Graph | null> {
    const result = await this.read((q) => q
      .select()
      .from(graphs)
      .where(and(eq(graphs.id, graph_id), this.tenantEq(graphs.tenant_id)))
      .limit(1));

    const definition = result[0]?.definition ?? null;
    return definition ? fromGraphDefinitionJson(definition) : null;
  }

  async listGraphs(opts: { limit?: number; offset?: number } = {}): Promise<GraphRow[]> {
    const { limit = 100, offset = 0 } = opts;
    return this.read((q) => q
      .select()
      .from(graphs)
      .where(this.tenantEq(graphs.tenant_id))
      .orderBy(desc(graphs.updated_at))
      .limit(limit)
      .offset(offset));
  }

  // ── Workflow Run Operations ──

  async saveWorkflowRun(state: WorkflowState): Promise<void> {
    const isTerminal = TERMINAL_STATUSES.includes(state.status);
    const status = state.status as WorkflowStatus;

    await this.read((q) => q.insert(workflow_runs).values({
      id: state.run_id,
      ...this.tenantValues,
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
    }));
  }

  async loadWorkflowRun(run_id: string): Promise<WorkflowRunRow | null> {
    const result = await this.read((q) => q
      .select()
      .from(workflow_runs)
      .where(and(eq(workflow_runs.id, run_id), this.tenantEq(workflow_runs.tenant_id)))
      .limit(1));

    return result[0] ?? null;
  }

  async listWorkflowRuns(opts: { limit?: number; offset?: number } = {}): Promise<WorkflowRunRow[]> {
    const { limit = 100, offset = 0 } = opts;
    return this.read((q) => q
      .select()
      .from(workflow_runs)
      .where(this.tenantEq(workflow_runs.tenant_id))
      .orderBy(desc(workflow_runs.created_at))
      .limit(limit)
      .offset(offset));
  }

  async updateRunStatus(runId: string, status: string): Promise<number> {
    const isTerminal = TERMINAL_STATUSES.includes(status);
    const result = await this.read((q) => q
      .update(workflow_runs)
      .set({
        status: status as WorkflowStatus,
        completed_at: isTerminal ? new Date() : null,
      })
      .where(and(eq(workflow_runs.id, runId), this.tenantEq(workflow_runs.tenant_id)))
      .returning({ id: workflow_runs.id }));

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
      this.tx(async (tx) => {
        await this.assertClaim(tx, state.run_id);

        const maxVersionResult = await tx
          .select({ maxVersion: sql<number>`COALESCE(MAX(${workflow_states.version}), 0)` })
          .from(workflow_states)
          .where(and(eq(workflow_states.run_id, state.run_id), this.tenantEq(workflow_states.tenant_id)));
        const nextVersion = (maxVersionResult[0]?.maxVersion ?? 0) + 1;

        await tx.insert(workflow_states).values({
          ...this.tenantValues,
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
    tx: Queryer,
    runId: string,
  ): Promise<void> {
    if (!this.fencing || this.fencing.run_id !== runId) return;
    const rows = await tx
      .select({ claim_epoch: workflow_runs.claim_epoch })
      .from(workflow_runs)
      .where(and(eq(workflow_runs.id, runId), this.tenantEq(workflow_runs.tenant_id)))
      .for('update');
    const current = rows[0]?.claim_epoch;
    if (current !== undefined && current !== this.fencing.epoch) {
      throw new StaleClaimError(runId, this.fencing.epoch, current);
    }
  }

  async loadLatestWorkflowState(run_id: string): Promise<WorkflowState | null> {
    const result = await this.read((q) => q
      .select()
      .from(workflow_states)
      .where(and(eq(workflow_states.run_id, run_id), this.tenantEq(workflow_states.tenant_id)))
      .orderBy(desc(workflow_states.version))
      .limit(1));

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
    return this.read((q) => q
      .select({
        version: workflow_states.version,
        status: workflow_states.status,
        current_node: workflow_states.current_node,
        created_at: workflow_states.created_at,
        total_tokens_used: sql<number | null>`(${workflow_states.state}->>'total_tokens_used')::integer`,
      })
      .from(workflow_states)
      .where(and(eq(workflow_states.run_id, run_id), this.tenantEq(workflow_states.tenant_id)))
      .orderBy(workflow_states.version)
      .limit(limit)
      .offset(offset));
  }

  async loadWorkflowStateAtVersion(
    run_id: string,
    version: number,
  ): Promise<IWorkflowStateJson | null> {
    const result = await this.read((q) => q
      .select()
      .from(workflow_states)
      .where(
        and(
          eq(workflow_states.run_id, run_id),
          eq(workflow_states.version, version),
          this.tenantEq(workflow_states.tenant_id),
        ),
      )
      .limit(1));
    return (result[0]?.state as unknown as IWorkflowStateJson) ?? null;
  }

  // ── Atomic Snapshot ──

  async saveWorkflowSnapshot(state: WorkflowState): Promise<void> {
    // Same version-increment race as `saveWorkflowState` — retry on transient
    // unique-violation conflicts. The run update is idempotent
    // (`onConflictDoUpdate`); the state insert is what races.
    await retryOnTransient(() =>
      this.tx(async (tx) => {
        await this.assertClaim(tx, state.run_id);

        // Save workflow run
        const isTerminal = TERMINAL_STATUSES.includes(state.status);
        const status = state.status as WorkflowStatus;

        await tx.insert(workflow_runs).values({
          id: state.run_id,
          ...this.tenantValues,
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
          .where(and(eq(workflow_states.run_id, state.run_id), this.tenantEq(workflow_states.tenant_id)));
        const nextVersion = (maxVersionResult[0]?.maxVersion ?? 0) + 1;

        await tx.insert(workflow_states).values({
          ...this.tenantValues,
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
    const rows = await this.read((q) => q
      .select()
      .from(workflow_events)
      .where(and(eq(workflow_events.run_id, run_id), this.tenantEq(workflow_events.tenant_id)))
      .orderBy(workflow_events.sequence_id));
    return rows;
  }
}
