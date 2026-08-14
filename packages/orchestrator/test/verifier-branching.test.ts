/**
 * Verifier branching: both outcomes need an explicit edge, and the conditions
 * must use the bare truthy form.
 *
 * filtrex has no boolean literals, so `memory.x == false` compares against an
 * undefined property — false when the value IS false, true when the key is
 * absent. The `verifier-fix-loop` example shipped with that inversion and with
 * no success edge, so it could route neither way.
 */

import { describe, it, expect } from 'vitest';
import { graph, router, verifier, state, GraphRunner } from '../src/index.js';

/** Both outcomes terminate, so a run reveals which branch the verifier took. */
function branchGraph(condition: string) {
  const check = verifier.expression(condition, { id: 'check', reads: ['*'] });
  const fix = router({ id: 'fix', reads: ['*'] });
  const done = router({ id: 'done', reads: ['*'] });

  return graph({
    name: 'branch',
    nodes: [check, fix, done],
    edges: [
      { from: check, to: fix, when: 'not memory.check_verification_passed' },
      { from: check, to: done, when: 'memory.check_verification_passed' },
    ],
    startNode: check,
    endNodes: [done, fix],
  });
}

async function runWith(payload: string, condition = 'length(memory.payload) > 3') {
  const g = branchGraph(condition);
  const runner = new GraphRunner(g, state({ workflowId: g.id, goal: 'verify', memory: { payload } }));
  return runner.run();
}

describe('verifier branching', () => {
  it('routes a passing verification to the success branch', async () => {
    const final = await runWith('long enough');

    expect(final.visited_nodes).toContain('done');
    expect(final.visited_nodes).not.toContain('fix');
  });

  it('routes a failing verification to the fixer', async () => {
    const final = await runWith('ab');

    expect(final.visited_nodes).toContain('fix');
    expect(final.visited_nodes).not.toContain('done');
  });

  it('writes the boolean the edges branch on', async () => {
    const final = await runWith('long enough');

    expect(final.memory['check_verification_passed']).toBe(true);
  });

  it('inverts the failure branch when written as `== false`', async () => {
    const g = graph({
      name: 'inverted',
      nodes: [
        verifier.expression('length(memory.payload) > 3', { id: 'check', reads: ['*'] }),
        router({ id: 'fix', reads: ['*'] }),
      ],
      edges: [{ from: 'check', to: 'fix', when: 'memory.check_verification_passed == false' }],
      startNode: 'check',
      endNodes: ['fix'],
    });
    const runner = new GraphRunner(g, state({ workflowId: g.id, goal: 'v', memory: { payload: 'ab' } }));

    // The verification genuinely failed, so `== false` should have routed to
    // the fixer. It does not: `false` is an unknown property, so the
    // comparison is undefined == false rather than the intended test.
    await expect(runner.run()).rejects.toThrow(/no outgoing edge/);
  });
});
