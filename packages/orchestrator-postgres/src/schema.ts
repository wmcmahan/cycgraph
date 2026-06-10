/**
 * Database Schema — Engine Tables
 *
 * Drizzle ORM table definitions for the orchestration engine.
 * Platform-specific tables (e.g. api_keys) live in the consuming application.
 *
 * @module @cycgraph/orchestrator-postgres/schema
 */

import { sql } from 'drizzle-orm';
import type { ToolSource, MCPTransportConfig } from '@cycgraph/orchestrator';
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  vector,
  real,
  integer,
  numeric,
  index,
  uniqueIndex,
  primaryKey,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

// ─── Shared Constants ───────────────────────────────────────────────────

/**
 * Default embedding vector dimensions.
 * Matches OpenAI text-embedding-ada-002 and text-embedding-3-small (both 1536).
 * Override by forking the schema if using a different embedding model.
 */
export const EMBEDDING_DIMENSIONS = 1536;

const WORKFLOW_STATUSES = [
  'pending',
  'scheduled',
  'running',
  'waiting',
  'retrying',
  'completed',
  'failed',
  'cancelled',
  'timeout',
] as const;

// ─── JSONB Column Types ─────────────────────────────────────────────────

export interface GraphDefinitionJson {
  id: string;
  name: string;
  nodes: unknown[];
  edges: unknown[];
  start_node: string;
  end_nodes: string[];
  [key: string]: unknown;
}

export interface WorkflowStateJson {
  workflow_id: string;
  run_id: string;
  status: string;
  current_node?: string;
  memory: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ModelBreakdown {
  [model: string]: {
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
  };
}

// ─── Tables ─────────────────────────────────────────────────────────────

export const graphs = pgTable('graphs', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  description: text('description'),
  definition: jsonb('definition').$type<GraphDefinitionJson>().notNull(),
  version: text('version').default('1.0.0'),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const workflows = pgTable('workflows', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  description: text('description'),
  graph_id: uuid('graph_id').references(() => graphs.id, { onDelete: 'set null' }),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const workflow_runs = pgTable('workflow_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  workflow_id: uuid('workflow_id').references(() => workflows.id, { onDelete: 'set null' }),
  graph_id: uuid('graph_id').references(() => graphs.id, { onDelete: 'restrict' }).notNull(),
  status: text('status', { enum: WORKFLOW_STATUSES }).notNull(),
  /**
   * Fencing token: incremented every time a worker claims a job for this
   * run (DrizzleWorkflowQueue.dequeue). Fenced writers reject writes whose
   * epoch is older — a reclaimed worker cannot clobber the new claimant.
   */
  claim_epoch: integer('claim_epoch').notNull().default(0),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  parent_run_id: uuid('parent_run_id').references((): AnyPgColumn => workflow_runs.id, { onDelete: 'set null' }),
  completed_at: timestamp('completed_at', { withTimezone: true }),
  archived_at: timestamp('archived_at', { withTimezone: true }),
}, (table) => [
  index('idx_workflow_runs_status').on(table.status),
  index('idx_workflow_runs_graph_id').on(table.graph_id),
  index('idx_workflow_runs_created_at_desc').on(table.created_at),
  index('idx_workflow_runs_completed_not_archived').on(table.completed_at).where(sql`archived_at IS NULL`),
  index('idx_workflow_runs_graph_status').on(table.graph_id, table.status),
]);

export const workflow_states = pgTable('workflow_states', {
  id: uuid('id').primaryKey().defaultRandom(),
  run_id: uuid('run_id').references(() => workflow_runs.id, { onDelete: 'cascade' }).notNull(),
  version: integer('version').notNull().default(1),
  state: jsonb('state').$type<WorkflowStateJson>().notNull(),
  current_node: text('current_node'),
  status: text('status', { enum: WORKFLOW_STATUSES }).notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  archived_at: timestamp('archived_at', { withTimezone: true }),
}, (table) => [
  index('idx_workflow_states_run_created').on(table.run_id, table.created_at),
  uniqueIndex('uq_workflow_states_run_version').on(table.run_id, table.version),
  index('idx_workflow_states_status').on(table.status),
  index('idx_workflow_states_archived_at').on(table.archived_at).where(sql`archived_at IS NOT NULL`),
]);

export const workflow_events = pgTable('workflow_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  run_id: uuid('run_id').references(() => workflow_runs.id, { onDelete: 'cascade' }).notNull(),
  sequence_id: integer('sequence_id').notNull(),
  event_type: text('event_type', {
    enum: ['workflow_started', 'node_started', 'action_dispatched', 'internal_dispatched', 'state_persisted'],
  }).notNull(),
  node_id: text('node_id'),
  action: jsonb('action'),
  internal_type: text('internal_type'),
  internal_payload: jsonb('internal_payload'),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex('uq_workflow_events_run_seq').on(table.run_id, table.sequence_id),
  index('idx_workflow_events_run_type').on(table.run_id, table.event_type),
  index('idx_workflow_events_run_created').on(table.run_id, table.created_at),
]);

export const workflow_checkpoints = pgTable('workflow_checkpoints', {
  id: uuid('id').primaryKey().defaultRandom(),
  run_id: uuid('run_id').references(() => workflow_runs.id, { onDelete: 'cascade' }).notNull(),
  sequence_id: integer('sequence_id').notNull(),
  state: jsonb('state').$type<WorkflowStateJson>().notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('idx_workflow_checkpoints_run_seq').on(table.run_id, table.sequence_id),
]);

export const workflow_jobs = pgTable('workflow_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  type: text('type', { enum: ['start', 'resume'] }).notNull(),
  // No FK to workflow_runs — for 'start' jobs the run row is created at
  // claim time (dequeue), after the job already exists.
  run_id: uuid('run_id').notNull(),
  graph_id: uuid('graph_id').notNull(),
  initial_state: jsonb('initial_state'),
  human_response: jsonb('human_response'),
  priority: integer('priority').notNull().default(0),
  max_attempts: integer('max_attempts').notNull().default(3),
  attempt: integer('attempt').notNull().default(0),
  visibility_timeout_ms: integer('visibility_timeout_ms').notNull().default(300_000),
  status: text('status', {
    enum: ['waiting', 'active', 'paused', 'completed', 'failed', 'dead_letter'],
  }).notNull().default('waiting'),
  worker_id: text('worker_id'),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  visible_at: timestamp('visible_at', { withTimezone: true }),
  last_heartbeat_at: timestamp('last_heartbeat_at', { withTimezone: true }),
  last_error: text('last_error'),
}, (table) => [
  // Dequeue path: WHERE status='waiting' ORDER BY priority, created_at
  index('idx_workflow_jobs_dequeue').on(table.status, table.priority, table.created_at),
  index('idx_workflow_jobs_run_id').on(table.run_id),
  // Reclaim path: WHERE status='active' AND visible_at <= now()
  index('idx_workflow_jobs_reclaim').on(table.status, table.visible_at),
]);

export const agents = pgTable('agents', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  description: text('description'),
  model: text('model').notNull(),
  provider: text('provider').notNull(),
  system_prompt: text('system_prompt').notNull(),
  temperature: real('temperature').notNull().default(0.7),
  max_steps: integer('max_steps').notNull().default(10),
  tools: jsonb('tools').notNull().$type<ToolSource[]>(),
  permissions: jsonb('permissions').notNull().$type<{
    sandbox: boolean;
    read_keys: string[];
    write_keys: string[];
    budget_usd?: number;
  }>(),
  provider_options: jsonb('provider_options').$type<Record<string, Record<string, import('@cycgraph/orchestrator').JsonValue>>>(),
  model_preference: text('model_preference'),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const mcp_servers = pgTable('mcp_servers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  transport: jsonb('transport').$type<MCPTransportConfig>().notNull(),
  allowed_agents: jsonb('allowed_agents').$type<string[]>(),
  timeout_ms: integer('timeout_ms').notNull().default(30000),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const documents = pgTable('documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  user_id: uuid('user_id').notNull(),
  title: text('title').notNull(),
  url: text('url'),
  file_path: text('file_path'),
  mime_type: text('mime_type'),
  content: text('content').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const embeddings = pgTable('embeddings', {
  id: uuid('id').primaryKey().defaultRandom(),
  document_id: uuid('document_id').references(() => documents.id, { onDelete: 'cascade' }).notNull(),
  chunk_index: integer('chunk_index').notNull(),
  content: text('content').notNull(),
  embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('idx_embeddings_vector').using('hnsw', table.embedding.op('vector_cosine_ops')),
]);

export const usage_records = pgTable('usage_records', {
  id: uuid('id').primaryKey().defaultRandom(),
  run_id: uuid('run_id').references(() => workflow_runs.id, { onDelete: 'cascade' }),
  api_key_id: uuid('api_key_id'),
  graph_id: uuid('graph_id').references(() => graphs.id, { onDelete: 'set null' }),
  input_tokens: integer('input_tokens').notNull().default(0),
  output_tokens: integer('output_tokens').notNull().default(0),
  cost_usd: numeric('cost_usd', { precision: 10, scale: 6 }).notNull().default('0'),
  model_breakdown: jsonb('model_breakdown').$type<ModelBreakdown>(),
  duration_ms: integer('duration_ms'),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('idx_usage_records_run_id').on(table.run_id),
  index('idx_usage_records_api_key_id').on(table.api_key_id),
  index('idx_usage_records_created_at').on(table.created_at),
]);

// ─── Memory Tables ─────────────────────────────────────────────────────

/** JSONB shape for provenance metadata on memory records. */
export interface MemoryProvenanceJson {
  source: string;
  agent_id?: string;
  tool_name?: string;
  run_id?: string;
  node_id?: string;
  confidence?: number;
  created_at: string;
}

export const memory_entities = pgTable('memory_entities', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  entity_type: text('entity_type').notNull(),
  attributes: jsonb('attributes').$type<Record<string, unknown>>().default({}),
  embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }),
  provenance: jsonb('provenance').$type<MemoryProvenanceJson>().notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  invalidated_at: timestamp('invalidated_at', { withTimezone: true }),
  superseded_by: uuid('superseded_by'),
}, (table) => [
  index('idx_memory_entities_type').on(table.entity_type),
  index('idx_memory_entities_embedding').using('hnsw', table.embedding.op('vector_cosine_ops')),
]);

export const memory_relationships = pgTable('memory_relationships', {
  id: uuid('id').primaryKey(),
  source_id: uuid('source_id').notNull().references(() => memory_entities.id, { onDelete: 'cascade' }),
  target_id: uuid('target_id').notNull().references(() => memory_entities.id, { onDelete: 'cascade' }),
  relation_type: text('relation_type').notNull(),
  weight: real('weight').notNull().default(1),
  attributes: jsonb('attributes').$type<Record<string, unknown>>().default({}),
  valid_from: timestamp('valid_from', { withTimezone: true }).notNull(),
  valid_until: timestamp('valid_until', { withTimezone: true }),
  provenance: jsonb('provenance').$type<MemoryProvenanceJson>().notNull(),
  invalidated_by: text('invalidated_by'),
}, (table) => [
  index('idx_memory_rels_source').on(table.source_id),
  index('idx_memory_rels_target').on(table.target_id),
  index('idx_memory_rels_type').on(table.relation_type),
]);

export const memory_episodes = pgTable('memory_episodes', {
  id: uuid('id').primaryKey(),
  topic: text('topic').notNull(),
  messages: jsonb('messages').$type<unknown[]>().notNull(),
  started_at: timestamp('started_at', { withTimezone: true }).notNull(),
  ended_at: timestamp('ended_at', { withTimezone: true }).notNull(),
  embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }),
  fact_ids: jsonb('fact_ids').$type<string[]>().default([]),
  provenance: jsonb('provenance').$type<MemoryProvenanceJson>().notNull(),
}, (table) => [
  index('idx_memory_episodes_started').on(table.started_at),
  index('idx_memory_episodes_embedding').using('hnsw', table.embedding.op('vector_cosine_ops')),
]);

export const memory_themes = pgTable('memory_themes', {
  id: uuid('id').primaryKey(),
  label: text('label').notNull(),
  description: text('description').default(''),
  fact_ids: jsonb('fact_ids').$type<string[]>().default([]),
  embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }),
  provenance: jsonb('provenance').$type<MemoryProvenanceJson>().notNull(),
}, (table) => [
  index('idx_memory_themes_embedding').using('hnsw', table.embedding.op('vector_cosine_ops')),
]);

export const memory_facts = pgTable('memory_facts', {
  id: uuid('id').primaryKey(),
  content: text('content').notNull(),
  source_episode_ids: jsonb('source_episode_ids').$type<string[]>().default([]),
  entity_ids: jsonb('entity_ids').$type<string[]>().default([]),
  theme_id: uuid('theme_id').references(() => memory_themes.id, { onDelete: 'set null' }),
  embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }),
  provenance: jsonb('provenance').$type<MemoryProvenanceJson>().notNull(),
  valid_from: timestamp('valid_from', { withTimezone: true }).notNull(),
  valid_until: timestamp('valid_until', { withTimezone: true }),
  invalidated_by: text('invalidated_by'),
  access_count: integer('access_count').default(0),
  last_accessed_at: timestamp('last_accessed_at', { withTimezone: true }),
  tags: jsonb('tags').$type<string[]>().default([]).notNull(),
}, (table) => [
  index('idx_memory_facts_theme').on(table.theme_id),
  index('idx_memory_facts_valid').on(table.valid_from, table.valid_until),
  index('idx_memory_facts_embedding').using('hnsw', table.embedding.op('vector_cosine_ops')),
  // GIN index backs the `tags ?| array[...]` tag filter (reflection-loop hot
  // path) so tag-scoped fact retrieval is an index lookup, not a table scan.
  index('idx_memory_facts_tags').using('gin', table.tags),
]);

export const memory_entity_facts = pgTable('memory_entity_facts', {
  fact_id: uuid('fact_id').notNull().references(() => memory_facts.id, { onDelete: 'cascade' }),
  entity_id: uuid('entity_id').notNull().references(() => memory_entities.id, { onDelete: 'cascade' }),
}, (table) => [
  primaryKey({ columns: [table.fact_id, table.entity_id] }),
  index('idx_mef_entity').on(table.entity_id),
]);

// ─── Inferred Types ─────────────────────────────────────────────────────

export type Graph = typeof graphs.$inferSelect;
export type NewGraph = typeof graphs.$inferInsert;
export type Workflow = typeof workflows.$inferSelect;
export type WorkflowRun = typeof workflow_runs.$inferSelect;
export type NewWorkflowRun = typeof workflow_runs.$inferInsert;
export type WorkflowState = typeof workflow_states.$inferSelect;
export type NewWorkflowState = typeof workflow_states.$inferInsert;
export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
export type Document = typeof documents.$inferSelect;
export type Embedding = typeof embeddings.$inferSelect;
export type WorkflowEventRow = typeof workflow_events.$inferSelect;
export type NewWorkflowEventRow = typeof workflow_events.$inferInsert;
export type WorkflowJobRow = typeof workflow_jobs.$inferSelect;
export type NewWorkflowJobRow = typeof workflow_jobs.$inferInsert;
export type WorkflowCheckpointRow = typeof workflow_checkpoints.$inferSelect;
export type NewWorkflowCheckpointRow = typeof workflow_checkpoints.$inferInsert;
export type UsageRecord = typeof usage_records.$inferSelect;
export type NewUsageRecord = typeof usage_records.$inferInsert;
export type MCPServer = typeof mcp_servers.$inferSelect;
export type NewMCPServer = typeof mcp_servers.$inferInsert;
export type MemoryEntityRow = typeof memory_entities.$inferSelect;
export type MemoryRelationshipRow = typeof memory_relationships.$inferSelect;
export type MemoryEpisodeRow = typeof memory_episodes.$inferSelect;
export type MemoryThemeRow = typeof memory_themes.$inferSelect;
export type MemoryFactRow = typeof memory_facts.$inferSelect;
export type MemoryEntityFactRow = typeof memory_entity_facts.$inferSelect;
