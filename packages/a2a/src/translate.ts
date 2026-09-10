/**
 * Wire-to-engine translation
 *
 * Turns what the SDK hands back — a parsed protocol `Task`, or a bare
 * `Message` for an agent that answers without creating one — into the
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

/** The slice of a protocol `Message` this adapter reads. */
export interface WireMessage {
  taskId?: string;
  role?: unknown;
  parts?: WirePart[];
}

/**
 * The artifact name a bare `Message` reply lands under, since the protocol
 * gives such a reply no name of its own. `output_mapping` matches on it.
 */
const MESSAGE_ARTIFACT_NAME = 'response';

/**
 * Whether the object `message/send` returned is a bare `Message` rather
 * than a `Task`.
 *
 * The SDK's own `SendMessageResult` is `Message | Task`: an agent that
 * holds no state answers with the reply itself and never creates a task.
 * Only a `Task` carries `id`/`status`, and only a `Message` carries `role`
 * beside its own `parts`, so the two shapes are distinguishable without a
 * discriminator field.
 */
export function isWireMessage(value: unknown): value is WireMessage {
  if (typeof value !== 'object' || value === null) return false;
  const wire = value as WireTask & WireMessage;
  return wire.id === undefined
    && wire.status === undefined
    && wire.role !== undefined
    && Array.isArray(wire.parts);
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

/**
 * The human-readable detail a non-completed task carries.
 *
 * Every part contributes, joined by newline in wire order: the protocol lets
 * an agent split one question across several parts, and an `input-required`
 * pause has nothing else to show the human, so dropping any part can drop
 * the question itself.
 */
function statusMessage(task: WireTask): string | undefined {
  const parts = task.status?.message?.parts;
  if (!parts) return undefined;
  const text = parts.map(partToText).filter((piece) => piece.length > 0).join('\n');
  return text.length > 0 ? text : undefined;
}

/** Render one status part as display text, structured parts as their JSON. */
function partToText(part: WirePart): string {
  const value = partToValue(part);
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * A bare `Message` reply IS the answer: the agent created no task, so there
 * is no state to normalize and nothing left to wait for. Sending it down the
 * task path would read the absent `status` as `failed` and drop the reply's
 * parts, which are the whole content of the exchange.
 */
function messageResult(message: WireMessage): A2ATaskResult {
  return {
    taskId: message.taskId ?? '',
    state: 'completed',
    artifacts: [{ name: MESSAGE_ARTIFACT_NAME, value: partsToValue(message.parts ?? []) }],
  };
}

/** Translate what the SDK returned — a task or a bare message — into the engine's shape. */
export function toResult(wire: unknown): A2ATaskResult {
  if (isWireMessage(wire)) return messageResult(wire);

  const task = wire as WireTask;
  const state = normalizeState(task.status?.state);
  const message = statusMessage(task);

  return {
    taskId: task.id ?? '',
    state,
    artifacts: state === 'completed' ? toArtifacts(task.artifacts ?? []) : [],
    ...(message ? { message } : {}),
  };
}
