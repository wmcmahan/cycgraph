/**
 * Wire-to-engine translation
 *
 * Turns what the SDK hands back — a parsed protocol `Task` — into the
 * engine's `A2ATaskResult`. The translation is lossy in one deliberate way:
 * an artifact's `Part[]` collapses to a single value, by the rules on
 * {@link partsToValue}.
 *
 * @module translate
 */

import type { A2AArtifact, A2ATaskResult } from '@cycgraph/orchestrator';
import { normalizeState } from './task-state.js';

/** The slice of a protocol `Part` this adapter reads. */
interface WirePart {
  content?: { $case?: string; value?: unknown };
  mediaType?: string;
  filename?: string;
}

/** The slice of a protocol `Artifact` this adapter reads. */
interface WireArtifact {
  name?: string;
  artifactId?: string;
  parts?: WirePart[];
}

/** The slice of a protocol `Task` this adapter reads. */
interface WireTask {
  id?: string;
  status?: {
    state?: unknown;
    message?: { parts?: WirePart[] };
  };
  artifacts?: WireArtifact[];
}

/**
 * Collapse an artifact's parts into a single value.
 *
 * - A lone `data` part survives as the structured value itself, and a lone
 *   `text` part as the string.
 * - A `url` or `raw` part becomes a small descriptor rather than content.
 *   Workflow state is checkpointed on every step; inlining file bytes would
 *   rewrite them into every checkpoint.
 * - Several parts become an array of the above, preserving order.
 */
export function partsToValue(parts: readonly WirePart[]): unknown {
  const values = parts.map(partToValue);
  if (values.length === 0) return null;
  return values.length === 1 ? values[0] : values;
}

function partToValue(part: WirePart): unknown {
  const content = part.content;
  if (!content) return null;

  switch (content.$case) {
    case 'text':
    case 'data':
      return content.value;
    case 'url':
      return { url: content.value, mediaType: part.mediaType };
    case 'raw':
      return { bytes: true, mediaType: part.mediaType, filename: part.filename };
    default:
      return null;
  }
}

/** Map protocol artifacts onto the engine's name/value shape. */
function toArtifacts(artifacts: readonly WireArtifact[]): A2AArtifact[] {
  return artifacts.map((artifact, index) => ({
    name: artifact.name || artifact.artifactId || `artifact_${index}`,
    value: partsToValue(artifact.parts ?? []),
  }));
}

/** The human-readable detail a non-completed task carries. */
function statusMessage(task: WireTask): string | undefined {
  const parts = task.status?.message?.parts;
  if (!parts) return undefined;
  const value = partsToValue(parts);
  return typeof value === 'string' ? value : undefined;
}

/** Translate an SDK task into the engine's shape. */
export function toResult(task: unknown): A2ATaskResult {
  const wire = task as WireTask;
  const state = normalizeState(wire.status?.state);
  const message = statusMessage(wire);

  return {
    taskId: wire.id ?? '',
    state,
    artifacts: state === 'completed' ? toArtifacts(wire.artifacts ?? []) : [],
    ...(message ? { message } : {}),
  };
}
