/**
 * The give-up wiring on the issue-picking delivery workflows: a
 * tried-and-failed dead end must route to a `giveup` node (so the picked
 * issue is flagged needs-human and the run reports it gave up) rather than
 * to `report` (which reads as success). Builds the real graphs so
 * validateGraph runs over the edges.
 */

import { describe, it, expect } from 'vitest';
import { featImplement } from '../src/implement-ticket/index.js';
import { optApply } from '../src/optimization-apply/index.js';
import { maintenanceEnvFromProcess } from '../src/shared/env.js';

const env = maintenanceEnvFromProcess({});
const repoRoot = process.cwd();

describe('give-up wiring on delivery workflows', () => {
  for (const [name, workflow] of [['implement-ticket', featImplement()], ['optimization-apply', optApply()]] as const) {
    it(`${name} routes a dead end through a giveup node and carries onFatal`, async () => {
      const built = await workflow.build({ ...workflow.params.parse({}), repoRoot }, env);
      const nodeIds = built.graph.nodes.map((node) => node.id);
      const edges = built.graph.edges;

      expect(nodeIds).toContain('giveup');
      expect(edges.some((edge) => edge.target === 'giveup')).toBe(true);
      expect(edges.some((edge) => edge.source === 'giveup' && edge.target === 'report')).toBe(true);
      expect(typeof built.onFatal).toBe('function');
    });
  }
});
