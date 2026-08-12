/**
 * A2A scenario server
 *
 * Serves each scenario in {@link SCENARIOS} as its own A2A agent: an Agent
 * Card at `/<id>/.well-known/agent-card.json` and a JSON-RPC endpoint at
 * `/<id>/a2a/v1`.
 *
 * @module a2a/server
 */

import express, { type Express } from 'express';
import { randomUUID } from 'node:crypto';
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from '@a2a-js/sdk/server';
import { jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { TaskState } from '@a2a-js/sdk';
import { SCENARIOS, type Scenario } from './scenarios.js';

/** Counts card fetches, so a test can see how chatty the client is. */
let cardFetches = 0;

/** Agent Card for one scenario. The SDK serves and validates this. */
function agentCard(scenario: Scenario, baseUrl: string) {
  return {
    name: `scenario-${scenario.id}`,
    description: scenario.description,
    version: '1.0.0',
    protocolVersion: '1.0',
    supportedInterfaces: [{
      url: `${baseUrl}/${scenario.id}/a2a/v1`,
      protocolBinding: 'JSONRPC',
      protocolVersion: '1.0',
      tenant: '',
    }],
    capabilities: { streaming: false, pushNotifications: false, extensions: [] },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ['application/json', 'text/plain'],
    defaultOutputModes: ['application/json', 'text/plain'],
    skills: [{
      id: scenario.id,
      name: scenario.id,
      description: scenario.description,
      tags: ['test'],
      examples: [],
      inputModes: ['application/json'],
      outputModes: ['application/json'],
      securityRequirements: [],
    }],
  };
}

/**
 * Scenario state name → the SDK's numeric enum.
 *
 * `TaskState` is a NUMERIC protobuf enum. Publishing the string name
 * instead serializes as `TASK_STATE_UNSPECIFIED`, so every scenario would
 * report `failed` while the message still arrives — a confusing failure
 * that the `as never` casts below would otherwise hide.
 */
const STATE_VALUE: Record<string, TaskState> = {
  TASK_STATE_COMPLETED: TaskState.TASK_STATE_COMPLETED,
  TASK_STATE_FAILED: TaskState.TASK_STATE_FAILED,
  TASK_STATE_REJECTED: TaskState.TASK_STATE_REJECTED,
  TASK_STATE_CANCELED: TaskState.TASK_STATE_CANCELED,
  TASK_STATE_INPUT_REQUIRED: TaskState.TASK_STATE_INPUT_REQUIRED,
  TASK_STATE_AUTH_REQUIRED: TaskState.TASK_STATE_AUTH_REQUIRED,
};

/** Read the input a message carries, from whichever part shape it used. */
function readInput(message: { parts?: Array<{ content?: { $case?: string; value?: unknown } }> }): unknown {
  return message.parts?.[0]?.content?.value ?? null;
}

/**
 * Drive one scenario as an A2A agent.
 *
 * The executor publishes a `task` event first, as the SDK requires, then
 * artifacts, then a final status carrying the scripted outcome.
 * `requestContext.task` being already set is how a continuation is
 * detected — that is what lets `asks-question` complete on the second call
 * rather than asking forever.
 */
function scenarioExecutor(scenario: Scenario): AgentExecutor {
  return {
    async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
      const resumed = Boolean(requestContext.task);
      const outcome = scenario.respond(readInput(requestContext.userMessage), resumed);

      eventBus.publish(AgentEvent.task({
        id: requestContext.taskId,
        contextId: requestContext.contextId,
        status: { state: TaskState.TASK_STATE_SUBMITTED, message: undefined, timestamp: new Date().toISOString() },
        artifacts: [],
        history: [],
        metadata: undefined,
      } as never));

      for (const artifact of outcome.artifacts ?? []) {
        eventBus.publish(AgentEvent.artifactUpdate({
          taskId: requestContext.taskId,
          contextId: requestContext.contextId,
          artifact: {
            artifactId: randomUUID(),
            name: artifact.name,
            description: '',
            parts: [{ content: { $case: 'data', value: artifact.value } }],
            metadata: undefined,
            extensions: [],
          },
          append: false,
          lastChunk: true,
          metadata: undefined,
        } as never));
      }

      eventBus.publish(AgentEvent.statusUpdate({
        taskId: requestContext.taskId,
        contextId: requestContext.contextId,
        final: true,
        status: {
          state: STATE_VALUE[outcome.state],
          timestamp: new Date().toISOString(),
          message: outcome.message
            ? {
              messageId: randomUUID(),
              contextId: requestContext.contextId,
              taskId: requestContext.taskId,
              role: 'ROLE_AGENT',
              parts: [{ content: { $case: 'text', value: outcome.message } }],
              metadata: undefined,
              extensions: [],
              referenceTaskIds: [],
            }
            : undefined,
        },
        metadata: undefined,
      } as never));

      eventBus.finished();
    },

    async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
      eventBus.publish(AgentEvent.statusUpdate({
        taskId,
        contextId: taskId,
        final: true,
        status: { state: TaskState.TASK_STATE_CANCELED, timestamp: new Date().toISOString(), message: undefined },
        metadata: undefined,
      } as never));
      eventBus.finished();
    },
  };
}

/**
 * Build the scenario server.
 *
 * @param baseUrl - Public base URL, embedded in each Agent Card.
 * @param onRequest - Optional observer, so a test can assert on the headers
 *   (auth, `traceparent`) the engine actually sent.
 */
export function createA2AScenarioServer(
  baseUrl: string,
  onRequest?: (info: { scenarioId: string; headers: Record<string, string | undefined> }) => void,
): Express {
  const app = express();
  app.use(express.json({ limit: '5mb' }));

  app.get('/__card-fetches', (_req, res) => { res.json({ cardFetches }); });

  app.get('/', (_req, res) => {
    res.json({
      protocol: 'a2a',
      agents: SCENARIOS.map((s) => ({
        id: s.id,
        description: s.description,
        agentCardUrl: `${baseUrl}/${s.id}/.well-known/agent-card.json`,
      })),
    });
  });

  for (const scenario of SCENARIOS) {
    const card = agentCard(scenario, baseUrl);

    app.get(`/${scenario.id}/.well-known/agent-card.json`, (_req, res) => {
      cardFetches += 1;
      res.json(card);
    });

    const requestHandler = new DefaultRequestHandler(
      card as never,
      new InMemoryTaskStore(),
      scenarioExecutor(scenario),
    );

    app.use(
      `/${scenario.id}/a2a/v1`,
      (req, _res, next) => {
        onRequest?.({
          scenarioId: scenario.id,
          headers: {
            authorization: req.header('authorization'),
            traceparent: req.header('traceparent'),
            'x-api-key': req.header('x-api-key'),
          },
        });
        next();
      },
      jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }),
    );
  }

  return app;
}
