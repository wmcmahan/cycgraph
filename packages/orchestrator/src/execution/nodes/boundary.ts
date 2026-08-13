/**
 * Delegation Boundary
 *
 * The seam a node crosses when it hands work to something opaque and takes
 * the result back. Shared by every delegating node type, so these rules
 * hold regardless of what runs on the far side:
 *
 * 1. **Only mapped keys cross.** The delegate sees what `inputMapping`
 *    names and nothing else; the parent receives what `outputMapping`
 *    names and nothing else.
 * 2. **Taint survives the crossing, both ways.** An untrusted parent value
 *    stays untrusted inside the delegate, or the delegate's sensitive
 *    steps run ungated. A value the delegate marked untrusted stays
 *    untrusted on the way back.
 * 3. **Declared interfaces are enforced at the seam.** A required input
 *    must be present and every present value must satisfy its schema.
 *
 * Resolving and executing the delegate is the caller's business; callers
 * also supply their own error type through the `fail` callback.
 *
 * @module execution/nodes/boundary
 */

import type { GraphInputDecl, GraphOutputDecl } from '../../graph/graph.js';
import type { StateView, TaintMetadata, TaintRegistry } from '../../state/state.js';
import { getTaintInfo, markTainted } from '../../security/taint.js';
import { jsonSchemaToZod, type JSONSchema } from '../../mcp/json-schema-converter.js';

/**
 * Raise a boundary violation. Implemented by the caller so each node type
 * throws its own error, and so this module stays free of node-specific
 * error classes.
 */
export type BoundaryFailure = (
  direction: 'input' | 'output',
  key: string,
  detail: string,
) => never;

/** The delegate-side memory and taint produced by an inbound crossing. */
export interface InboundBoundary {
  memory: Record<string, unknown>;
  taint: TaintRegistry;
}

/**
 * Check a value against a declared JSON Schema. Returns a human-readable
 * violation, or `null` when the value conforms.
 */
export function boundaryViolation(schema: Record<string, unknown>, value: unknown): string | null {
  const result = jsonSchemaToZod(schema as unknown as JSONSchema).safeParse(value);
  if (result.success) return null;
  const first = result.error.issues[0];
  return first ? `${first.message}${first.path.length > 0 ? ` at ${first.path.join('.')}` : ''}` : 'schema violation';
}

/**
 * Build the delegate's input from the parent's readable state.
 *
 * A parent key absent from the view is skipped rather than seeded as
 * `undefined`, which is what lets {@link validateInbound} distinguish "not
 * provided" from "provided as undefined".
 *
 * @param stateView - The parent state, already sliced to this node's grants.
 * @param inputMapping - Parent key → delegate key.
 */
export function mapInbound(
  stateView: StateView,
  inputMapping: Record<string, string>,
): InboundBoundary {
  const memory: Record<string, unknown> = {};
  let taint: TaintRegistry = {};

  for (const [parentKey, delegateKey] of Object.entries(inputMapping)) {
    if (parentKey in stateView.memory) {
      memory[delegateKey] = stateView.memory[parentKey];
      const info = getTaintInfo(stateView.taint ?? {}, parentKey);
      if (info) taint = markTainted(taint, delegateKey, info);
    }
  }

  return { memory, taint };
}

/**
 * Enforce a declared input interface against what actually crossed. A
 * delegate declaring no interface validates nothing.
 *
 * @param declared - The delegate's declared inputs, if it has any.
 * @param memory - The mapped input from {@link mapInbound}.
 * @param fail - Raises the caller's error type.
 */
export function validateInbound(
  declared: Record<string, GraphInputDecl> | undefined,
  memory: Record<string, unknown>,
  fail: BoundaryFailure,
): void {
  if (!declared) return;

  for (const [key, decl] of Object.entries(declared)) {
    if (!(key in memory)) {
      if (decl.required) fail('input', key, 'required input was not provided');
      continue;
    }
    const violation = boundaryViolation(decl.schema, memory[key]);
    if (violation) fail('input', key, violation);
  }
}

/**
 * Map the delegate's results back to parent memory, validating each against
 * the declared output interface and carrying taint outward.
 *
 * The returned record is a memory-update payload: it carries the
 * `_taint_registry` wire key when anything crossed tainted, which the
 * reducer's routing choke point appends to `state.taint_registry`. A key
 * the delegate never produced is skipped rather than written as
 * `undefined`.
 *
 * @param delegateMemory - What the delegate produced.
 * @param delegateTaint - The delegate's taint registry.
 * @param outputMapping - Delegate key → parent key.
 * @param declared - The delegate's declared outputs, if it has any.
 * @param fail - Raises the caller's error type.
 */
export function mapOutbound(
  delegateMemory: Record<string, unknown>,
  delegateTaint: TaintRegistry,
  outputMapping: Record<string, string>,
  declared: Record<string, GraphOutputDecl> | undefined,
  fail: BoundaryFailure,
): Record<string, unknown> {
  const updates: Record<string, unknown> = {};
  const taint: Record<string, TaintMetadata> = {};

  for (const [delegateKey, parentKey] of Object.entries(outputMapping)) {
    if (!(delegateKey in delegateMemory)) continue;

    const value = delegateMemory[delegateKey];
    const decl = declared?.[delegateKey];
    if (decl) {
      const violation = boundaryViolation(decl.schema, value);
      if (violation) fail('output', delegateKey, violation);
    }

    updates[parentKey] = value;
    const info = getTaintInfo(delegateTaint, delegateKey);
    if (info) taint[parentKey] = info;
  }

  if (Object.keys(taint).length > 0) {
    updates['_taint_registry'] = taint;
  }

  return updates;
}
