/**
 * Fact Sanitizer
 *
 * Optional pre-write hook applied to facts emitted by `reflection` nodes
 * before they reach the configured `MemoryWriter`. Lets callers redact
 * PII, drop policy-violating content, or substitute alternative wording
 * without bolting that logic onto the writer adapter itself.
 *
 * Returning the same `MemoryWriterFact` passes the fact through unchanged.
 * Returning a modified fact substitutes it. Returning `null` drops the
 * fact entirely — it never reaches the writer.
 *
 * Fails closed by default: a thrown sanitizer (downed PII service, buggy
 * regex) is logged and the fact is DROPPED rather than persisted unredacted
 * into durable, cross-run memory. Hosts that prioritize reflection
 * availability over redaction can set `factSanitizerFailMode: 'pass'` on
 * `GraphRunnerOptions` to keep the original fact on error instead.
 *
 * @module security/fact-sanitizer
 */

import type { MemoryWriterFact } from '../memory/memory-writer.js';

/**
 * Pre-write hook for facts produced by a reflection node.
 *
 * @param fact - The candidate fact about to be written.
 * @returns
 *   - The fact (possibly modified) to keep it,
 *   - `null` to drop the fact silently,
 *   - or a promise resolving to either.
 */
export type FactSanitizer = (
  fact: MemoryWriterFact,
) => MemoryWriterFact | null | Promise<MemoryWriterFact | null>;
