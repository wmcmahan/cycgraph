/**
 * Graph Serializer
 *
 * Formats entity-relationship subgraphs into compact prompt format.
 * Auto-detects between tabular (uniform entity types) and adjacency
 * list (mixed types) representations.
 *
 * @module memory/graph/serializer
 */

import type { CompressionStage, PromptSegment, StageContext } from '../../pipeline/types.js';
import type { GraphEntity, GraphRelationship } from '../hierarchy/types.js';
import { needsQuoting, quoteValue } from '../../format/strategies/tabular.js';

export interface GraphSerializerOptions {
  /** Force a specific serialization mode. */
  mode?: 'tabular' | 'adjacency';
  /** Include invalidated entities (default: false). */
  includeInvalidated?: boolean;
  /** Include expired relationships (default: false). */
  includeExpired?: boolean;
  /** Maximum entities per type to include (default: 50). */
  maxEntitiesPerType?: number;
  /** Maximum relationships to include (default: 100). */
  maxRelationships?: number;
}

/**
 * Serialize entities and relationships into a compact prompt format.
 */
export function serializeGraph(
  entities: GraphEntity[],
  relationships: GraphRelationship[],
  options?: GraphSerializerOptions,
): string {
  const includeInvalidated = options?.includeInvalidated ?? false;
  const includeExpired = options?.includeExpired ?? false;
  const maxPerType = options?.maxEntitiesPerType ?? 50;
  const maxRels = options?.maxRelationships ?? 100;

  // Filter
  const activeEntities = includeInvalidated
    ? entities
    : entities.filter(e => !e.invalidated_at);

  const now = new Date();
  const activeRels = includeExpired
    ? relationships
    : relationships.filter(r => !r.valid_until || r.valid_until > now);

  // Build ID→name map
  const nameMap = new Map<string, string>();
  for (const e of activeEntities) {
    nameMap.set(e.id, e.name);
  }

  const mode = options?.mode ?? detectMode(activeEntities);

  if (mode === 'tabular') {
    return serializeTabularGraph(activeEntities, activeRels, nameMap, maxPerType, maxRels);
  }
  return serializeAdjacencyGraph(activeEntities, activeRels, nameMap, maxPerType, maxRels);
}

/**
 * Create a pipeline stage that serializes graph data.
 * Detects segments with `metadata.contentType === 'graph'`.
 */
export function createGraphSerializerStage(options?: GraphSerializerOptions): CompressionStage {
  return {
    name: 'graph-serializer',
    // Each segment is transformed independently — safe for per-segment caching.
    scope: 'per-segment' as const,
    execute(segments: PromptSegment[], _context: StageContext) {
      return {
        segments: segments.map(seg => {
          if (seg.metadata?.contentType !== 'graph') return seg;

          try {
            const parsed = JSON.parse(seg.content) as { entities?: GraphEntity[]; relationships?: GraphRelationship[] };
            const formatted = serializeGraph(
              parsed.entities ?? [],
              parsed.relationships ?? [],
              options,
            );
            return { ...seg, content: formatted };
          } catch {
            return seg;
          }
        }),
      };
    },
  };
}

// ─── Mode Detection ───────────────────────────────────────────────

function detectMode(entities: GraphEntity[]): 'tabular' | 'adjacency' {
  // Group by type
  const byType = new Map<string, GraphEntity[]>();
  for (const e of entities) {
    const list = byType.get(e.entity_type) ?? [];
    list.push(e);
    byType.set(e.entity_type, list);
  }

  // Tabular only if EVERY multi-entity type group has uniform attribute keys —
  // the tabular renderer reads each group's columns from its first entity, so
  // a ragged group would silently drop attributes. Adjacency is lossless.
  // Keys are fingerprinted via JSON so a key containing the join delimiter
  // can't collide (same fix as format/detector.ts).
  let anyUniform = false;
  for (const [, group] of byType) {
    if (group.length < 2) continue;
    const firstKeys = Object.keys(group[0].attributes).sort();
    const fingerprint = JSON.stringify(firstKeys);
    const uniform = group.every(
      e => JSON.stringify(Object.keys(e.attributes).sort()) === fingerprint,
    );
    if (!uniform) return 'adjacency';
    // A uniform group with zero attributes is only vacuously uniform — a
    // @name-only table isn't evidence that tabular mode pays off.
    if (firstKeys.length > 0) anyUniform = true;
  }

  return anyUniform ? 'tabular' : 'adjacency';
}

// ─── Tabular Serialization ────────────────────────────────────────

function serializeTabularGraph(
  entities: GraphEntity[],
  relationships: GraphRelationship[],
  nameMap: Map<string, string>,
  maxPerType: number,
  maxRels: number,
): string {
  const lines: string[] = [];

  // Group entities by type
  const byType = new Map<string, GraphEntity[]>();
  for (const e of entities) {
    const list = byType.get(e.entity_type) ?? [];
    list.push(e);
    byType.set(e.entity_type, list);
  }

  for (const [type, group] of byType) {
    const limited = group.slice(0, maxPerType);
    const attrKeys = Object.keys(limited[0].attributes);

    lines.push(`Entities (${type}):`);
    lines.push(`@name ${attrKeys.map(k => `@${k}`).join(' ')}`);

    for (const e of limited) {
      const values = attrKeys.map(k => formatCell(e.attributes[k]));
      lines.push(`${formatCell(e.name)} ${values.join(' ')}`);
    }
    lines.push('');
  }

  // Relationships
  if (relationships.length > 0) {
    const limited = relationships.slice(0, maxRels);
    lines.push('Relationships:');
    lines.push('@source @relation @target @weight');
    for (const r of limited) {
      const source = nameMap.get(r.source_id) ?? r.source_id;
      const target = nameMap.get(r.target_id) ?? r.target_id;
      lines.push(`${formatCell(source)} ${formatCell(r.relation_type)} ${formatCell(target)} ${r.weight}`);
    }
  }

  return lines.join('\n').trim();
}

// ─── Adjacency Serialization ──────────────────────────────────────

function serializeAdjacencyGraph(
  entities: GraphEntity[],
  relationships: GraphRelationship[],
  nameMap: Map<string, string>,
  maxPerType: number,
  maxRels: number,
): string {
  // Build adjacency from relationships
  const outgoing = new Map<string, Array<{ target: string; relation: string; weight: number }>>();
  const limited = relationships.slice(0, maxRels);

  for (const r of limited) {
    const list = outgoing.get(r.source_id) ?? [];
    list.push({
      target: nameMap.get(r.target_id) ?? r.target_id,
      relation: r.relation_type,
      weight: r.weight,
    });
    outgoing.set(r.source_id, list);
  }

  const lines: string[] = [];
  let count = 0;

  for (const e of entities) {
    if (count >= maxPerType * 10) break; // global cap
    count++;

    const edges = outgoing.get(e.id) ?? [];
    const attrs = Object.entries(e.attributes)
      .map(([k, v]) => `${k}=${formatValue(v)}`)
      .join(', ');

    const edgeStr = edges.length > 0
      ? edges.map(ed => `${ed.relation} -> ${ed.target} [${ed.weight}]`).join(', ')
      : '';

    const parts = [`${e.name} (${e.entity_type})`];
    if (edgeStr) parts.push(edgeStr);
    if (attrs) parts.push(attrs);

    lines.push(parts.join(': '));
  }

  return lines.join('\n');
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '_';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

/**
 * Format a value for a space-delimited table cell. Entity names and attribute
 * values routinely contain spaces ("Alice Johnson") — without quoting, every
 * column after them misaligns.
 */
function formatCell(v: unknown): string {
  const raw = formatValue(v);
  return needsQuoting(raw) ? quoteValue(raw) : raw;
}
