/**
 * A2A scenario agents
 *
 * Scripted remote agents covering the task outcomes the engine has to
 * handle. Each one exists because some path through `execution/nodes/a2a.ts`
 * cannot be exercised any other way without a third party who happens to
 * behave that way on demand.
 *
 * Deliberately deterministic and LLM-free: an integration test that calls a
 * model tests the model. These test the protocol.
 *
 * @module a2a/scenarios
 */

/** The task states a scenario can drive, in the protocol's spelling. */
export type ScenarioState =
  | 'TASK_STATE_COMPLETED'
  | 'TASK_STATE_FAILED'
  | 'TASK_STATE_REJECTED'
  | 'TASK_STATE_CANCELED'
  | 'TASK_STATE_INPUT_REQUIRED'
  | 'TASK_STATE_AUTH_REQUIRED';

/** One scripted agent. */
export interface Scenario {
  /** Path segment and skill id. */
  id: string;
  /** What this scenario proves. */
  description: string;
  /**
   * Decide the response for an incoming message.
   *
   * `resumed` is true when the message carried a `taskId`, which is how A2A
   * models continuation — that flag is what lets `input-required` complete
   * on the second call instead of asking forever.
   */
  respond(input: unknown, resumed: boolean): {
    state: ScenarioState;
    artifacts?: Array<{ name: string; value: unknown }>;
    message?: string;
  };
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'echo',
    description: 'Completes immediately, echoing the input as a structured artifact.',
    respond: (input) => ({
      state: 'TASK_STATE_COMPLETED',
      artifacts: [{ name: 'report', value: input }],
    }),
  },
  {
    id: 'multi-artifact',
    description: 'Completes with several artifacts, so output mapping can be tested for selectivity.',
    respond: () => ({
      state: 'TASK_STATE_COMPLETED',
      artifacts: [
        { name: 'report', value: 'the findings' },
        { name: 'confidence', value: { score: 0.82 } },
        { name: 'unmapped', value: 'should not reach parent memory' },
      ],
    }),
  },
  {
    id: 'asks-question',
    description: 'Stops in input-required, then completes once answered. Exercises the HITL pause and resume.',
    respond: (input, resumed) => (resumed
      ? {
        state: 'TASK_STATE_COMPLETED',
        artifacts: [{ name: 'report', value: { answered_with: input } }],
      }
      : {
        state: 'TASK_STATE_INPUT_REQUIRED',
        message: 'Which region should I focus on?',
      }),
  },
  {
    id: 'rejects',
    description: 'Refuses the work. Must NOT be retried by the runner.',
    respond: () => ({ state: 'TASK_STATE_REJECTED', message: 'Out of scope for this agent.' }),
  },
  {
    id: 'fails',
    description: 'Fails transiently. May be retried.',
    respond: () => ({ state: 'TASK_STATE_FAILED', message: 'Upstream unavailable.' }),
  },
  {
    id: 'needs-auth',
    description: 'Reports auth-required. Must not pause for a human.',
    respond: () => ({ state: 'TASK_STATE_AUTH_REQUIRED', message: 'Credential rejected.' }),
  },
  {
    id: 'unnamed-artifact',
    description: 'Returns an artifact with no name, to check the id/index fallback.',
    respond: () => ({
      state: 'TASK_STATE_COMPLETED',
      artifacts: [{ name: '', value: 'anonymous result' }],
    }),
  },
];

/** Look up a scenario by id. */
export function findScenario(id: string): Scenario | undefined {
  return SCENARIOS.find((scenario) => scenario.id === id);
}
