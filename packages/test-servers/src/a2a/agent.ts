/**
 * A2A scenario backed by a real model
 *
 * The other scenarios script a protocol outcome. This one calls a model and
 * returns what it said, so a delegating workflow is talking to something that
 * thinks rather than to a fixture.
 *
 * It answers a different question from its siblings. They ask whether the
 * engine handles a rejection, a pause, or a malformed artifact. This asks
 * whether delegation works at all when the far side takes a couple of seconds
 * and returns prose nobody wrote in advance.
 *
 * Not a cycgraph workflow. This is a third-party agent as far as the caller is
 * concerned, which is the situation A2A exists for, and it keeps this package
 * free of any dependency on the engine it is used to test. Delegating to
 * another cycgraph graph would need a server that runs one, which does not
 * exist yet — `toAgentCard` publishes the advertisement for a graph, and
 * nothing serves it.
 *
 * Reports a failed task rather than throwing when no model is reachable, so
 * the deterministic scenarios keep working on a machine with no Ollama.
 *
 * @module a2a/agent
 */

import type { Scenario, ScenarioResponse } from './scenarios.js';

const OLLAMA_BASE_URL = process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434';
const MODEL = process.env['A2A_AGENT_MODEL'] ?? process.env['CYCGRAPH_MODEL'] ?? 'qwen2.5:7b';

const INSTRUCTIONS =
  'You are a remote research agent reached over the Agent2Agent protocol. ' +
  'Answer the delegated request in at most three sentences. ' +
  'State findings plainly, with no preamble and no offer of further help.';

/** The request, as a sentence to delegate. Callers map arbitrary shapes down. */
function asPrompt(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>;
    for (const key of ['query', 'request', 'subject', 'goal', 'task']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value;
    }
  }
  return JSON.stringify(input);
}

/**
 * Run one turn against the model.
 *
 * Ollama's OpenAI-compatible endpoint, over plain `fetch`. A remote agent's
 * internals are its own business, and reaching for an SDK here would put a
 * dependency in a package whose whole job is to be a third party.
 */
async function ask(prompt: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(`${OLLAMA_BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: INSTRUCTIONS },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
    }),
    signal,
  });

  if (!response.ok) {
    throw new Error(`model returned ${response.status} ${response.statusText}`);
  }

  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = body.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('model returned no content');
  return text;
}

/** Whether a model is reachable, so the scenario can be listed honestly. */
export async function modelAvailable(timeoutMs = 1500): Promise<boolean> {
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Answer `prompt` with the model, as a completed task. */
async function answerWith(prompt: string): Promise<ScenarioResponse> {
  try {
    const answer = await ask(prompt, AbortSignal.timeout(Number(process.env['A2A_AGENT_TIMEOUT_MS'] ?? 60_000)));
    return {
      state: 'TASK_STATE_COMPLETED',
      artifacts: [
        { name: 'report', value: answer },
        { name: 'model', value: MODEL },
      ],
    };
  } catch (error) {
    // A task failure rather than a throw. An agent that cannot answer is a
    // failed task, which the delegating side already knows how to handle, and
    // it is what a caller sees when no model is running here.
    return {
      state: 'TASK_STATE_FAILED',
      message: `remote agent could not answer: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export const agentScenario: Scenario = {
  id: 'agent',
  description: 'Runs a real model and returns what it said. Delegation to an agent rather than a script.',
  respond: (input) => answerWith(asPrompt(input)),
};

export const clarifyingAgentScenario: Scenario = {
  id: 'agent-clarifies',
  description: 'Asks one clarifying question, then answers with a real model using the reply.',

  /**
   * The pause is scripted and the answer is not.
   *
   * Which half is deterministic matters: a model cannot be relied on to ask
   * for clarification on demand, so the `input-required` turn is fixed, while
   * the content that comes back is genuinely generated. That makes one call
   * cover the whole delegation path — remote agent, human pause, resume of
   * the same task, and a real answer.
   */
  respond: (input, resumed, original) => (resumed
    ? answerWith(`${asPrompt(original)}. Focus on: ${asPrompt(input)}.`)
    : {
      state: 'TASK_STATE_INPUT_REQUIRED',
      message: 'Which region or aspect should I focus on?',
    }),
};
