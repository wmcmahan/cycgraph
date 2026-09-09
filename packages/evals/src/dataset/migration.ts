/**
 * Golden Dataset Schema Migration
 *
 * When tool signatures change in sibling packages, this module
 * applies transforms to golden trajectory assertions so they
 * stay in sync with the new schemas.
 *
 * @module dataset/migration
 */

import type { GoldenTrajectory, ToolCall } from './types.js';

// ─── Migration Types ───────────────────────────────────────────────

/** A single parameter rename transform. */
export interface ParamRename {
  type: 'rename';
  toolName: string;
  oldParam: string;
  newParam: string;
}

/** A parameter was removed from the tool schema. */
export interface ParamRemove {
  type: 'remove';
  toolName: string;
  param: string;
}

/** A required parameter was added — requires manual review. */
export interface ParamAddRequired {
  type: 'add_required';
  toolName: string;
  param: string;
  stubValue: unknown;
}

/** Union of all migration transform types. */
export type MigrationTransform = ParamRename | ParamRemove | ParamAddRequired;

/** Result of applying migrations to a set of trajectories. */
export interface MigrationResult {
  /** Updated trajectories. */
  trajectories: GoldenTrajectory[];

  /** Number of trajectories that were modified. */
  modifiedCount: number;

  /** Transforms that require manual review (e.g., required param additions). */
  reviewRequired: Array<{ trajectoryId: string; transform: ParamAddRequired }>;
}

// ─── Migration Logic ───────────────────────────────────────────────

/**
 * Applies a single transform to a tool call's args.
 * Returns the updated tool call (immutable — original is not mutated).
 */
function applyTransformToToolCall(
  toolCall: ToolCall,
  transform: MigrationTransform,
): { toolCall: ToolCall; modified: boolean } {
  if (toolCall.toolName !== transform.toolName) {
    return { toolCall, modified: false };
  }

  const args = { ...toolCall.args };
  let modified = false;

  switch (transform.type) {
    case 'rename': {
      if (transform.oldParam in args) {
        args[transform.newParam] = args[transform.oldParam];
        delete args[transform.oldParam];
        modified = true;
      }
      break;
    }

    case 'remove': {
      if (transform.param in args) {
        delete args[transform.param];
        modified = true;
      }
      break;
    }

    case 'add_required': {
      if (!(transform.param in args)) {
        args[transform.param] = transform.stubValue;
        modified = true;
      }
      break;
    }
  }

  if (!modified) return { toolCall, modified: false };

  // Update expectedArgSchema if present
  let expectedArgSchema = toolCall.expectedArgSchema
    ? { ...toolCall.expectedArgSchema }
    : undefined;

  if (expectedArgSchema) {
    if (transform.type === 'rename') {
      if (transform.oldParam in expectedArgSchema) {
        expectedArgSchema[transform.newParam] = expectedArgSchema[transform.oldParam];
        delete expectedArgSchema[transform.oldParam];
      }
    } else if (transform.type === 'remove') {
      delete expectedArgSchema[transform.param];
    }
  }

  return {
    toolCall: { ...toolCall, args, expectedArgSchema },
    modified: true,
  };
}

/**
 * Applies a list of migration transforms to a set of golden trajectories.
 *
 * Transforms are applied in order. Each trajectory's `expectedToolCalls`
 * are updated according to the matching transforms. Trajectories without
 * `expectedToolCalls` are left unchanged.
 *
 * @param trajectories - The trajectories to migrate.
 * @param transforms - Ordered list of transforms to apply.
 * @returns Migration result with updated trajectories and review flags.
 */
export function applyMigrations(
  trajectories: GoldenTrajectory[],
  transforms: MigrationTransform[],
): MigrationResult {
  let modifiedCount = 0;
  const reviewRequired: MigrationResult['reviewRequired'] = [];

  const updated = trajectories.map(trajectory => {
    if (!trajectory.expectedToolCalls || trajectory.expectedToolCalls.length === 0) {
      return trajectory;
    }

    let trajectoryModified = false;
    let updatedToolCalls = trajectory.expectedToolCalls;

    for (const transform of transforms) {
      updatedToolCalls = updatedToolCalls.map(tc => {
        const result = applyTransformToToolCall(tc, transform);
        if (result.modified) {
          trajectoryModified = true;

          if (transform.type === 'add_required') {
            reviewRequired.push({
              trajectoryId: trajectory.id,
              transform: transform as ParamAddRequired,
            });
          }
        }
        return result.toolCall;
      });
    }

    if (!trajectoryModified) return trajectory;

    modifiedCount++;
    return { ...trajectory, expectedToolCalls: updatedToolCalls };
  });

  return { trajectories: updated, modifiedCount, reviewRequired };
}

/**
 * The schema version a migration should write its output under: the next
 * MAJOR above the suite's current version. The dataset filename encodes
 * the major, so writing under the bumped major retains the current file
 * as the rollback — writing under any older major would overwrite a
 * retained rollback and downgrade the manifest entry.
 *
 * A malformed or missing current version yields `1.0.0` (a first write,
 * nothing on disk to clobber).
 */
export function nextMajorSchemaVersion(current: string | undefined): string {
  const major = /^(\d+)/.exec(current ?? '')?.[1];
  return major === undefined ? '1.0.0' : `${Number(major) + 1}.0.0`;
}
