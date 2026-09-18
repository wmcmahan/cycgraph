/**
 * Golden Dataset Schemas
 *
 * Zod schemas defining the structure of golden trajectories, tool calls,
 * and the dataset manifest. These schemas are the source of truth for
 * all data flowing through the eval harness.
 *
 * @module dataset/schema
 */

import { z } from 'zod';

// ─── Tool Call Schema ──────────────────────────────────────────────

/**
 * Schema for an expected tool call within a golden trajectory.
 *
 * `args` is validated structurally (correct keys and types), NOT by
 * exact string value. `expectedArgSchema` is a JSON Schema object
 * representation (not a Zod runtime object) since it must be
 * serializable to SQLite. Convert to Zod at assertion time.
 */
export const ToolCallSchema = z.object({
  toolName: z.string(),
  args: z.record(z.string(), z.unknown()),
  expectedArgSchema: z.record(z.string(), z.unknown()).optional(),
});

// ─── Golden Trajectory Schema ──────────────────────────────────────

/** Supported eval suite names. */
export const SuiteNameSchema = z.enum(['context-engine', 'memory', 'orchestrator', 'integration']);

/**
 * Provenance of a golden trajectory.
 * - `internal` — hand-authored by the engineering team
 * - `webarena` — sourced from the WebArena benchmark (reserved; not yet implemented)
 * - `recorded` — captured from a real System-Under-Test run at a tagged commit
 */
export const TrajectorySourceSchema = z.enum(['webarena', 'internal', 'recorded']);

/**
 * Schema for a single golden trajectory — the atomic unit of evaluation.
 *
 * Each trajectory captures an input, expected output, and optional tool
 * call expectations for one eval test case.
 *
 * `expectedToolCalls` semantics:
 * - `undefined` — skip tool call assertions entirely
 * - `[]` (empty array) — assert that no tool calls were made
 *
 * `recordedAt`/`recordedModel`/`recordedCommit` are populated when `source === 'recorded'`
 * to make drift attributable: a regression is meaningful only when measured against
 * output captured at a known model+commit. These fields are optional for backward
 * compatibility with v1/v2 hand-authored trajectories.
 */
export const GoldenTrajectorySchema = z.object({
  id: z.string().uuid(),
  suite: SuiteNameSchema,
  description: z.string(),
  input: z.string(),
  expectedOutput: z.union([z.string(), z.record(z.string(), z.unknown())]),
  expectedToolCalls: z.array(ToolCallSchema).optional(),
  tags: z.array(z.string()).optional(),
  source: TrajectorySourceSchema,
  createdAt: z.string().datetime(),
  recordedAt: z.string().datetime().optional(),
  recordedModel: z.string().optional(),
  recordedCommit: z.string().optional(),
});

// ─── Manifest Schemas ──────────────────────────────────────────────

/**
 * Shape a manifest `file` field must match: a `data/`-relative `.sqlite.gz`
 * filename with no path separators after the prefix.
 *
 * The manifest is untrusted input — it can arrive from a pull request, a
 * downloaded artifact, or a remote dataset URL. Without a shape constraint,
 * `file` could be `../../../../etc/passwd` or an absolute path (which
 * `path.resolve` returns unchanged, ignoring the golden directory), turning
 * the loader into an arbitrary file read. The manifest's own sha256 is
 * integrity, not confinement: whoever controls `file` controls `sha256` too.
 */
export const DATASET_FILE_PATTERN = /^data\/[A-Za-z0-9_.-]+\.sqlite\.gz$/;

/**
 * Schema for a single dataset entry in the manifest.
 * Maps a trajectory set to its compressed SQLite file.
 */
export const ManifestEntrySchema = z.object({
  name: z.string(),
  file: z
    .string()
    .regex(
      DATASET_FILE_PATTERN,
      'file must be a data/-relative .sqlite.gz path (e.g. "data/orchestrator-v3.sqlite.gz")',
    ),
  sha256: z.string(),
  trajectoryCount: z.number().int().nonnegative(),
  schemaVersion: z.string(),
  lastUpdated: z.string().datetime(),
});

/**
 * Schema for the golden dataset manifest (`golden/manifest.json`).
 * Registry of all trajectory sets, their versions, and checksums.
 */
export const ManifestSchema = z.object({
  version: z.string(),
  datasets: z.array(ManifestEntrySchema),
});
