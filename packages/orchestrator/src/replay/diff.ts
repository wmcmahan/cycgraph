/**
 * Run diff
 *
 * What became different between a run and a fork of it. Pure and synchronous:
 * two final states in, one structured comparison out.
 *
 * Field names are camelCase. A `RunDiff` is a result object a caller reads in
 * TypeScript, not something persisted or replayed, so it follows the TS
 * convention rather than the snake_case rule that governs schemas and wire
 * payloads.
 *
 * @module replay/diff
 */

import type { WorkflowState, WorkflowStatus } from '../state/state.js';
import type { SuppressedEffect } from './fork-guard.js';
import { canonicalEquals } from './canonical.js';

/** One node position, aligned between the two runs. */
export interface AlignedStep {
  /** Node in the base run at this position, absent when the variant inserted one. */
  base?: string;
  /** Node in the variant at this position, absent when the variant skipped one. */
  variant?: string;
}

/** How one memory key differs. */
export interface MemoryDelta {
  change: 'added' | 'removed' | 'changed';
  /** Size difference of the serialized value, variant minus base. */
  bytesDelta: number;
  /** Whether the key's taint status differs between the runs. */
  taintChanged: boolean;
}

/** The comparison between a base run and a variant. */
export interface RunDiff {
  /** First position where the executed paths differ, `null` when identical. */
  divergence: { index: number; base?: string; variant?: string } | null;
  path: {
    aligned: AlignedStep[];
    /** Nodes the variant ran that the base did not. */
    inserted: string[];
    /** Nodes the base ran that the variant did not. */
    skipped: string[];
  };
  /** Per-key memory differences, keyed by memory key. */
  memory: Record<string, MemoryDelta>;
  terminal: {
    base: WorkflowStatus;
    variant: WorkflowStatus;
    /** Variant minus base. */
    iterationsDelta: number;
    /** Variant minus base, `null` when either run has no elapsed time. */
    wallClockDeltaMs: number | null;
  };
  cost: {
    tokensDelta: number;
    usdDelta: number;
    /** What the variant's live tail spent, over the prefix it inherited. */
    incurredUsd: number;
    /** Per-node spend difference, variant minus base. */
    perNode: Record<string, number>;
  };
  /** Side effects the fork guard held back. */
  suppressedEffects: SuppressedEffect[];
  /** Caller-supplied scores, when the runs were scored. */
  score?: { base: number; variant: number; delta: number };
}

/** Extra context {@link diffRuns} cannot derive from two states alone. */
export interface DiffOptions {
  /** Prefix the variant inherited, so incurred cost separates from carried cost. */
  prefixState?: WorkflowState;
  /** What the fork guard suppressed. */
  suppressedEffects?: readonly SuppressedEffect[];
  /** Scores from a caller-supplied `RunScorer`. */
  scores?: { base: number; variant: number };
}

/** Longest common subsequence of two node paths, as index pairs. */
function lcsPairs(a: readonly string[], b: readonly string[]): Array<[number, number]> {
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0));

  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

/**
 * Align two executed paths.
 *
 * An alignment rather than a positional zip: inserting one node early in a run
 * shifts everything after it, and a positional comparison would report the
 * whole tail as changed when one step moved.
 */
function alignPaths(base: readonly string[], variant: readonly string[]): RunDiff['path'] {
  const pairs = lcsPairs(base, variant);
  const aligned: AlignedStep[] = [];
  const inserted: string[] = [];
  const skipped: string[] = [];

  let i = 0;
  let j = 0;
  for (const [bi, vi] of pairs) {
    while (i < bi) {
      aligned.push({ base: base[i] });
      skipped.push(base[i]);
      i++;
    }
    while (j < vi) {
      aligned.push({ variant: variant[j] });
      inserted.push(variant[j]);
      j++;
    }
    aligned.push({ base: base[bi], variant: variant[vi] });
    i = bi + 1;
    j = vi + 1;
  }
  for (; i < base.length; i++) {
    aligned.push({ base: base[i] });
    skipped.push(base[i]);
  }
  for (; j < variant.length; j++) {
    aligned.push({ variant: variant[j] });
    inserted.push(variant[j]);
  }

  return { aligned: coalesceSubstitutions(aligned), inserted, skipped };
}

/**
 * Pair a dropped node with the one that replaced it.
 *
 * An LCS has no notion of substitution: swapping one node for another comes
 * back as a delete next to an insert. Read as a path, `-review → +verify` is
 * two events where one happened, so adjacent pairs are merged back into a
 * single `review→verify` step. `inserted` and `skipped` still count both,
 * since a substitution genuinely is one of each.
 */
function coalesceSubstitutions(steps: readonly AlignedStep[]): AlignedStep[] {
  const out: AlignedStep[] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const next = steps[i + 1];
    if (step.variant === undefined && next?.base === undefined && next?.variant !== undefined) {
      out.push({ base: step.base, variant: next.variant });
      i++;
      continue;
    }
    out.push(step);
  }

  return out;
}

/** Serialized byte length of a memory value, 0 when absent. */
function bytesOf(value: unknown): number {
  if (value === undefined) return 0;
  return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value) ?? '', 'utf8');
}

/** Per-key memory differences. */
function diffMemory(base: WorkflowState, variant: WorkflowState): Record<string, MemoryDelta> {
  const keys = new Set([...Object.keys(base.memory), ...Object.keys(variant.memory)]);
  const out: Record<string, MemoryDelta> = {};

  for (const key of [...keys].sort()) {
    const inBase = key in base.memory;
    const inVariant = key in variant.memory;
    const before = base.memory[key];
    const after = variant.memory[key];

    // Canonical: a value replayed out of jsonb comes back field-reordered,
    // and reporting that as a change would make every durable fork look like
    // it rewrote memory it never touched.
    if (inBase && inVariant && canonicalEquals(before, after)) continue;

    out[key] = {
      change: !inBase ? 'added' : !inVariant ? 'removed' : 'changed',
      bytesDelta: bytesOf(after) - bytesOf(before),
      taintChanged: (key in base.taint_registry) !== (key in variant.taint_registry),
    };
  }

  return out;
}

/** Per-node spend difference. */
function diffPerNode(base: WorkflowState, variant: WorkflowState): Record<string, number> {
  const nodes = new Set([
    ...Object.keys(base.node_breakdown),
    ...Object.keys(variant.node_breakdown),
  ]);
  const out: Record<string, number> = {};

  for (const node of [...nodes].sort()) {
    const delta = (variant.node_breakdown[node]?.cost_usd ?? 0)
      - (base.node_breakdown[node]?.cost_usd ?? 0);
    if (delta !== 0) out[node] = delta;
  }

  return out;
}

/** Elapsed wall-clock of a run, `null` when it never started or never ended. */
function elapsedMs(state: WorkflowState): number | null {
  if (!state.started_at) return null;
  return state.updated_at.getTime() - state.started_at.getTime();
}

/** Compare a base run against a variant of it. */
export function diffRuns(
  base: WorkflowState,
  variant: WorkflowState,
  options: DiffOptions = {},
): RunDiff {
  const path = alignPaths(base.visited_nodes, variant.visited_nodes);
  const divergenceIndex = path.aligned.findIndex(step => step.base !== step.variant);

  const baseElapsed = elapsedMs(base);
  const variantElapsed = elapsedMs(variant);

  return {
    divergence: divergenceIndex === -1 ? null : {
      index: divergenceIndex,
      ...path.aligned[divergenceIndex],
    },
    path,
    memory: diffMemory(base, variant),
    terminal: {
      base: base.status,
      variant: variant.status,
      iterationsDelta: variant.iteration_count - base.iteration_count,
      wallClockDeltaMs: baseElapsed === null || variantElapsed === null
        ? null
        : variantElapsed - baseElapsed,
    },
    cost: {
      tokensDelta: variant.total_tokens_used - base.total_tokens_used,
      usdDelta: variant.total_cost_usd - base.total_cost_usd,
      incurredUsd: options.prefixState
        ? variant.total_cost_usd - options.prefixState.total_cost_usd
        : variant.total_cost_usd,
      perNode: diffPerNode(base, variant),
    },
    suppressedEffects: [...(options.suppressedEffects ?? [])],
    ...(options.scores ? {
      score: {
        base: options.scores.base,
        variant: options.scores.variant,
        delta: options.scores.variant - options.scores.base,
      },
    } : {}),
  };
}

/** One aligned step rendered as a path token. */
function stepToken(step: AlignedStep): string {
  if (step.base === step.variant) return step.variant ?? '';
  if (step.variant === undefined) return `-${step.base}`;
  if (step.base === undefined) return `+${step.variant}`;
  return `${step.base}→${step.variant}`;
}

/**
 * Render a diff as the block a developer reads.
 *
 * @param diff   The comparison.
 * @param header Optional first line, typically naming the two runs.
 */
export function formatRunDiff(diff: RunDiff, header?: string): string {
  const lines = header ? [header] : [];

  const status = diff.terminal.variant === diff.terminal.base
    ? diff.terminal.variant
    : `${diff.terminal.variant}          was ${diff.terminal.base}`;
  lines.push(`  status    ${status}`);

  lines.push(`  path      ${diff.path.aligned.map(stepToken).join(' → ')}`);
  if (diff.divergence) {
    const pad = diff.path.aligned
      .slice(0, diff.divergence.index)
      .map(stepToken)
      .join(' → ').length;
    lines.push(`            ${' '.repeat(pad ? pad + 3 : 0)}^ diverged here`);
  }

  lines.push(
    `  cost      $${diff.cost.incurredUsd.toFixed(4)} incurred, ` +
    `${diff.cost.tokensDelta >= 0 ? '+' : ''}${diff.cost.tokensDelta} tokens`,
  );

  const memory = Object.entries(diff.memory).map(([key, delta]) => {
    const mark = delta.change === 'added' ? '+' : delta.change === 'removed' ? '-' : '~';
    const bytes = delta.bytesDelta === 0
      ? ''
      : ` (${delta.bytesDelta > 0 ? '+' : ''}${delta.bytesDelta}B)`;
    return `${mark}${key}${bytes}${delta.taintChanged ? ' [taint]' : ''}`;
  });
  if (memory.length > 0) lines.push(`  memory    ${memory.join('  ')}`);

  if (diff.score) {
    const sign = diff.score.delta >= 0 ? '+' : '';
    lines.push(
      `  score     ${diff.score.variant.toFixed(3)} vs ${diff.score.base.toFixed(3)} ` +
      `(${sign}${diff.score.delta.toFixed(3)})`,
    );
  }

  for (const effect of diff.suppressedEffects) {
    lines.push(`  blocked   ${effect.nodeId} (${effect.kind}): ${effect.reason}`);
  }

  return lines.join('\n');
}
