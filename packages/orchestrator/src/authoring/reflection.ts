/**
 * reflection() — distill memory into facts a later run can retrieve
 *
 * The source keys come first: what is being reflected on is the point of the
 * node. Facts are written through the runner's `memoryWriter`, which must be
 * wired or the node throws.
 *
 * Tags scope retrieval. Namespace them (`['lesson', 'graph:research-v1']`) so a
 * consumer of the same store cannot pick up unrelated facts.
 *
 * The result key is implied by the node type, so this spec takes no `writes`.
 *
 * @module authoring/reflection
 */

import type { ReflectionConfig } from '../graph/graph.js';
import type { Camelize } from '../utils/case-mapping.js';
import { withOutputs, reflectionOutputs, type ReflectionOutputs } from './outputs.js';
import { NODE_BRAND, type NodeCommon, type NodeValue } from './node.js';

/** Extraction strategy: deterministic sentence splitting, or an LLM. */
export type ReflectionExtractor = Camelize<ReflectionConfig>['extractor'];

/** Authoring spec for {@link reflection}. */
export interface ReflectionSpec extends NodeCommon {
  /** How facts are pulled out of the source values. */
  extractor: ReflectionExtractor;
  /** Tags applied to every written fact. Namespace them. */
  tags?: string[];
  /** Memory keys naming entities the facts relate to. */
  entityKeys?: string[];
  /** Pin the envelope key. Defaults to `${id}_reflection`. */
  resultKey?: string;
}

/**
 * Author a `reflection` node.
 *
 * @param sources - Memory keys whose values feed the extractor.
 * @param spec - Placement, extraction strategy, and tags.
 */
export function reflection(sources: string[], spec: ReflectionSpec): NodeValue & ReflectionOutputs {
  const { extractor, tags, entityKeys, resultKey, ...placement } = spec;

  return withOutputs({
    ...placement,
    type: 'reflection' as const,
    reflectionConfig: {
      sourceKeys: sources,
      extractor,
      ...(tags !== undefined ? { tags } : {}),
      ...(entityKeys !== undefined ? { entityKeys } : {}),
      ...(resultKey !== undefined ? { resultKey } : {}),
    },
    [NODE_BRAND]: true as const,
  } as NodeValue, reflectionOutputs(spec.id, spec.resultKey));
}
