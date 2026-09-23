/**
 * The optimization-apply graph-owned nodes, each in its own file, built in
 * dependency order. This barrel owns that ordering; the delivery nodes
 * (clone/commit/publish) come from `deliveryNodes` in the composer, and
 * {@link graph.ts} wires everything.
 *
 * @module maintenance/optimization-apply/nodes
 */

import type { OptApplyTools } from '../tools/index.js';
import { pickNode } from './pick.js';
import { benchBeforeNode } from './bench-before.js';
import { applyNode } from './apply.js';
import { benchAfterNode } from './bench-after.js';
import { verdictNode } from './verdict.js';
import { checksNode } from './checks.js';
import { gateNode } from './gate.js';
import { giveUpNode } from './give-up.js';
import { reportNode } from './report.js';

/** Build every graph-owned node, wired to the tools. */
export function optApplyNodes(tools: OptApplyTools) {
  const pick = pickNode(tools);
  const benchBefore = benchBeforeNode(tools);
  const apply = applyNode(tools, pick);
  const benchAfter = benchAfterNode(tools);
  const verdict = verdictNode(tools, pick, benchBefore, benchAfter);
  const checks = checksNode(tools);
  const gate = gateNode(verdict, checks);
  const giveUp = giveUpNode(tools, pick, apply);
  const report = reportNode();
  return { pick, benchBefore, apply, benchAfter, verdict, checks, gate, giveUp, report };
}

/** The graph-owned nodes of one optimization-apply run (delivery excluded). */
export type OptApplyNodes = ReturnType<typeof optApplyNodes>;
