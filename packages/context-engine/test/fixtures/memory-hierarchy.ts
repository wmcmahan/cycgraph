/**
 * Test Fixtures — Memory Hierarchy & Graph Data
 *
 * Representative xMemory hierarchy payloads and knowledge graph
 * data for testing formatters, serializers, and the full pipeline.
 *
 * @module test/fixtures/memory-hierarchy
 */

import type {
  HierarchyTheme,
  HierarchyFact,
  HierarchyEpisode,
  GraphEntity,
  GraphRelationship,
  MemoryPayload,
  CommunitySummary,
} from '../../src/memory/hierarchy/types.js';

export const THEMES: HierarchyTheme[] = [
  {
    id: 'theme-arch',
    label: 'System Architecture',
    description: 'Design decisions about the platform architecture',
    fact_ids: ['fact-1', 'fact-2', 'fact-3'],
  },
  {
    id: 'theme-team',
    label: 'Team & People',
    description: 'Information about team members and roles',
    fact_ids: ['fact-4', 'fact-5'],
  },
  {
    id: 'theme-cost',
    label: 'Cost Optimization',
    description: 'Strategies for reducing operational costs',
    fact_ids: ['fact-6', 'fact-7', 'fact-8'],
  },
];

export const FACTS: HierarchyFact[] = [
  {
    id: 'fact-1',
    content: 'The platform uses a graph-based workflow engine for orchestration',
    source_episode_ids: ['ep-1'],
    entity_ids: ['ent-platform'],
    theme_id: 'theme-arch',
    valid_from: new Date('2026-01-15'),
  },
  {
    id: 'fact-2',
    content: 'API gateway implements rate limiting at 1000 req/s per tenant',
    source_episode_ids: ['ep-1'],
    entity_ids: ['ent-api'],
    theme_id: 'theme-arch',
    valid_from: new Date('2026-02-01'),
  },
  {
    id: 'fact-3',
    content: 'State persistence uses event sourcing with PostgreSQL',
    source_episode_ids: ['ep-2'],
    entity_ids: ['ent-platform'],
    theme_id: 'theme-arch',
    valid_from: new Date('2026-02-10'),
  },
  {
    id: 'fact-4',
    content: 'Alice is the lead engineer responsible for the orchestrator',
    source_episode_ids: ['ep-3'],
    entity_ids: ['ent-alice'],
    theme_id: 'theme-team',
    valid_from: new Date('2026-01-01'),
  },
  {
    id: 'fact-5',
    content: 'Bob joined as infrastructure engineer in March 2026',
    source_episode_ids: ['ep-3'],
    entity_ids: ['ent-bob'],
    theme_id: 'theme-team',
    valid_from: new Date('2026-03-01'),
  },
  {
    id: 'fact-6',
    content: 'Multi-agent systems cost 5-10x more than single-agent setups',
    source_episode_ids: ['ep-4'],
    entity_ids: [],
    theme_id: 'theme-cost',
    valid_from: new Date('2026-03-15'),
  },
  {
    id: 'fact-7',
    content: 'Context compression reduces token costs by 40-60% on average',
    source_episode_ids: ['ep-4'],
    entity_ids: [],
    theme_id: 'theme-cost',
    valid_from: new Date('2026-03-20'),
  },
  {
    id: 'fact-8',
    content: 'Task decomposition with smaller LLMs yields 70-90% cost reduction',
    source_episode_ids: ['ep-4'],
    entity_ids: [],
    theme_id: 'theme-cost',
    valid_from: new Date('2026-03-25'),
  },
  {
    id: 'fact-9',
    content: 'The CI pipeline runs in under 3 minutes',
    source_episode_ids: ['ep-2'],
    entity_ids: [],
    valid_from: new Date('2026-04-01'),
  },
];

export const EPISODES: HierarchyEpisode[] = [
  {
    id: 'ep-1',
    topic: 'Architecture design review',
    messages: [
      { role: 'user', content: 'What architecture should we use?', timestamp: new Date('2026-01-15T10:00:00Z') },
      { role: 'assistant', content: 'A graph-based workflow engine with event sourcing.', timestamp: new Date('2026-01-15T10:01:00Z') },
      { role: 'user', content: 'What about the API layer?', timestamp: new Date('2026-01-15T10:02:00Z') },
      { role: 'assistant', content: 'Rate-limited API gateway at 1000 req/s per tenant.', timestamp: new Date('2026-01-15T10:03:00Z') },
    ],
    started_at: new Date('2026-01-15T10:00:00Z'),
    ended_at: new Date('2026-01-15T10:03:00Z'),
    fact_ids: ['fact-1', 'fact-2'],
  },
  {
    id: 'ep-2',
    topic: 'Infrastructure setup',
    messages: [
      { role: 'user', content: 'How do we persist state?', timestamp: new Date('2026-02-10T14:00:00Z') },
      { role: 'assistant', content: 'Event sourcing with PostgreSQL for durability.', timestamp: new Date('2026-02-10T14:01:00Z') },
    ],
    started_at: new Date('2026-02-10T14:00:00Z'),
    ended_at: new Date('2026-02-10T14:01:00Z'),
    fact_ids: ['fact-3'],
  },
  {
    id: 'ep-3',
    topic: 'Team introductions',
    messages: [
      { role: 'user', content: 'Who is on the team?', timestamp: new Date('2026-03-01T09:00:00Z') },
      { role: 'assistant', content: 'Alice leads engineering, Bob handles infrastructure.', timestamp: new Date('2026-03-01T09:01:00Z') },
    ],
    started_at: new Date('2026-03-01T09:00:00Z'),
    ended_at: new Date('2026-03-01T09:01:00Z'),
    fact_ids: ['fact-4', 'fact-5'],
  },
  {
    id: 'ep-4',
    topic: 'Cost optimization research',
    messages: [
      { role: 'user', content: 'What are the main cost drivers?', timestamp: new Date('2026-03-25T11:00:00Z') },
      { role: 'assistant', content: 'Multi-agent overhead is the biggest. Compression and decomposition help.', timestamp: new Date('2026-03-25T11:01:00Z') },
    ],
    started_at: new Date('2026-03-25T11:00:00Z'),
    ended_at: new Date('2026-03-25T11:01:00Z'),
    fact_ids: ['fact-6', 'fact-7', 'fact-8'],
  },
];

export const ENTITIES: GraphEntity[] = [
  { id: 'ent-alice', name: 'Alice', entity_type: 'person', attributes: { role: 'lead engineer', department: 'platform' } },
  { id: 'ent-bob', name: 'Bob', entity_type: 'person', attributes: { role: 'infrastructure engineer', department: 'platform' } },
  { id: 'ent-platform', name: 'cycgraph Platform', entity_type: 'project', attributes: { status: 'active', started: '2026-01' } },
  { id: 'ent-api', name: 'API Gateway', entity_type: 'component', attributes: { rate_limit: '1000 req/s', protocol: 'REST' } },
  { id: 'ent-acme', name: 'Acme Corp', entity_type: 'organization', attributes: { industry: 'technology' } },
  { id: 'ent-old', name: 'Legacy Service', entity_type: 'component', attributes: { status: 'deprecated' }, invalidated_at: new Date('2026-03-01') },
];

export const RELATIONSHIPS: GraphRelationship[] = [
  { id: 'rel-1', source_id: 'ent-alice', target_id: 'ent-platform', relation_type: 'leads', weight: 1.0, attributes: {}, valid_from: new Date('2026-01-01') },
  { id: 'rel-2', source_id: 'ent-bob', target_id: 'ent-platform', relation_type: 'works_on', weight: 0.8, attributes: {}, valid_from: new Date('2026-03-01') },
  { id: 'rel-3', source_id: 'ent-alice', target_id: 'ent-acme', relation_type: 'works_at', weight: 1.0, attributes: {}, valid_from: new Date('2026-01-01') },
  { id: 'rel-4', source_id: 'ent-bob', target_id: 'ent-acme', relation_type: 'works_at', weight: 1.0, attributes: {}, valid_from: new Date('2026-03-01') },
  { id: 'rel-5', source_id: 'ent-platform', target_id: 'ent-api', relation_type: 'contains', weight: 1.0, attributes: {}, valid_from: new Date('2026-02-01') },
  { id: 'rel-6', source_id: 'ent-alice', target_id: 'ent-old', relation_type: 'maintained', weight: 0.5, attributes: {}, valid_from: new Date('2025-01-01'), valid_until: new Date('2026-03-01') },
];

export const COMMUNITIES: CommunitySummary[] = [
  {
    id: 'comm-1',
    label: 'Platform Engineering Team',
    summary: 'Alice leads the platform engineering team at Acme Corp. Bob handles infrastructure. They are building the cycgraph orchestration platform with a graph-based workflow engine.',
    entity_ids: ['ent-alice', 'ent-bob', 'ent-platform', 'ent-acme'],
    level: 1,
    weight: 0.95,
  },
  {
    id: 'comm-2',
    label: 'API Architecture',
    summary: 'The API gateway uses rate limiting at 1000 req/s per tenant. It is a REST-based component of the cycgraph platform.',
    entity_ids: ['ent-api', 'ent-platform'],
    level: 2,
    weight: 0.75,
  },
];

export const FULL_MEMORY_PAYLOAD: MemoryPayload = {
  themes: THEMES,
  facts: FACTS,
  episodes: EPISODES,
  entities: ENTITIES,
  relationships: RELATIONSHIPS,
};
