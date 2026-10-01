/**
 * The wire format the maintenance loop's pull-request traffic carries: the
 * hidden marker stamped on every comment a workflow posts, and the mention
 * that dispatches pr-revise.
 *
 * Both are read back from live pull requests, so a repository fixes them
 * once. Renaming one keeps the old value readable through the `legacy*`
 * fields, so comments posted before the rename still parse and relayed
 * text still cannot carry the old trigger.
 *
 * @module maintenance/pr-wire
 */

/** The marker namespace and mention a repository's pull-request traffic uses. */
export interface PrWire {
  /** Namespace on the markers the loop writes: `<!-- ${markerNamespace}:pr-${kind} -->`. */
  markerNamespace: string;
  /** Earlier namespaces still recognized when reading, never written. */
  legacyMarkerNamespaces: readonly string[];
  /**
   * The mention that dispatches pr-revise from a PR comment. The same
   * literal gates the `pr-revise.yml` trigger and is posted by
   * `pr-ci-failure.yml`, which run before any code this reaches, so the
   * two must be changed together.
   */
  mention: string;
  /** Earlier mentions still neutralized in relayed text and filtered from framing. */
  legacyMentions: readonly string[];
}

/** The marker namespace this repository's pull requests carry. */
export const DEFAULT_PR_MARKER_NAMESPACE = 'cycgraph';

/** The mention that dispatches this repository's maintenance workflows from PR comments. */
export const WORKFLOW_MENTION = '@cycgraph';

/** This repository's own wire format. */
export const DEFAULT_PR_WIRE: PrWire = {
  markerNamespace: DEFAULT_PR_MARKER_NAMESPACE,
  legacyMarkerNamespaces: [],
  mention: WORKFLOW_MENTION,
  legacyMentions: [],
};

/** A namespace that cannot break out of the HTML comment it sits in. */
const NAMESPACE = /^[a-z0-9][a-z0-9._-]*$/;
/** A GitHub handle, which is all a dispatching mention can be. */
const MENTION = /^@[A-Za-z0-9][A-Za-z0-9-]*$/;

/**
 * Throw when a wire format could corrupt what it writes or match what it
 * should not: a namespace outside `[a-z0-9._-]`, or a mention that is not
 * a single GitHub handle.
 */
export function assertPrWire(wire: PrWire): void {
  for (const namespace of [wire.markerNamespace, ...wire.legacyMarkerNamespaces]) {
    if (!NAMESPACE.test(namespace)) throw new Error(`invalid PR marker namespace: ${JSON.stringify(namespace)}`);
  }
  for (const mention of [wire.mention, ...wire.legacyMentions]) {
    if (!MENTION.test(mention)) throw new Error(`invalid workflow mention: ${JSON.stringify(mention)}`);
  }
}

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The namespaces a reader accepts, as one regex alternation. */
export function markerNamespacePattern(wire: PrWire): string {
  return [wire.markerNamespace, ...wire.legacyMarkerNamespaces].map(escaped).join('|');
}

/** Every mention a reader treats as a dispatch trigger, current first. */
export function allMentions(wire: PrWire): string[] {
  return [wire.mention, ...wire.legacyMentions];
}

/**
 * Neutralize workflow-dispatching mentions inside relayed text by dropping
 * their `@`. Matching is case-insensitive and unanchored, like the
 * `contains()` check the workflow trigger runs, so a mention inside a
 * longer token such as `@cycgraph/tools` is neutralized too.
 */
export function stripMentions(text: string, wire: PrWire = DEFAULT_PR_WIRE): string {
  return allMentions(wire).reduce(
    (out, mention) => out.replace(new RegExp(escaped(mention), 'gi'), mention.slice(1)),
    text,
  );
}
