/**
 * Zero Trust Permission Validation
 *
 * Delegates to the canonical {@link validateAction} in the reducers module
 * to ensure a single, consistent permission boundary. The agent executor
 * calls this before returning an action to the runner.
 *
 * Internal `_`-prefixed keys (e.g. `_taint_registry`) are system-generated
 * by the executor itself and are stripped before validation to avoid
 * false rejections.
 *
 * @module agent-executor/validation
 */

import type { Action } from '../../../state/state.js';
import { validateAction } from '../../../state/reducers.js';
import { PermissionDeniedError } from './errors.js';

/**
 * Validate that an action respects the agent's write permissions.
 *
 * Delegates to the canonical {@link validateAction} in the reducers module,
 * which covers all action types (not just `update_memory`). For
 * `update_memory` actions, system-generated `_`-prefixed keys are
 * stripped before validation since they are added by the executor,
 * not by the agent.
 *
 * @param action - The action produced by the agent executor.
 * @param allowedKeys - The agent's configured `write_keys`. A single `'*'`
 *   entry grants wildcard access.
 * @throws {PermissionDeniedError} If the action is not permitted.
 */
export function validateMemoryUpdatePermissions(action: Action, allowedKeys: string[]): void {
  // For update_memory actions, strip system-generated _-prefixed keys
  // (e.g. _taint_registry) before delegating to validateAction, since
  // they are added by the executor — not by the agent.
  let actionToValidate = action;
  if (action.type === 'update_memory' && action.payload?.updates) {
    const updates = action.payload.updates as Record<string, unknown>;
    const hasInternalKeys = Object.keys(updates).some(k => k.startsWith('_'));
    if (hasInternalKeys) {
      const filteredUpdates = Object.fromEntries(
        Object.entries(updates).filter(([k]) => !k.startsWith('_'))
      );
      actionToValidate = {
        ...action,
        payload: { ...action.payload, updates: filteredUpdates },
      };
    }
  }

  if (!validateAction(actionToValidate, allowedKeys)) {
    throw new PermissionDeniedError(
      `Agent attempted unauthorized action "${action.type}"`
    );
  }
}
