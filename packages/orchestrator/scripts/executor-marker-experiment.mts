import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import {
  InMemoryAgentRegistry,
  createProviderRegistry,
  AgentFactory,
} from '../dist/index.js';
import { executeAgent } from '../dist/agents/executors/agent/executor.js';

const usage = { inputTokens: { total: 1000, noCache: 1000 }, outputTokens: { total: 50 } };
let call = 0;
const mock = new MockLanguageModelV4({
  doStream: async () => {
    call += 1;
    const chunks = call === 1
      ? [
          { type: 'stream-start', warnings: [] },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'probe_tool', input: '{"id":"a"}' },
          { type: 'finish', finishReason: 'tool-calls', usage },
        ]
      : [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: 'DONE' },
          { type: 'text-end', id: 't1' },
          { type: 'finish', finishReason: 'stop', usage },
        ];
    return { stream: simulateReadableStream({ chunks }) };
  },
});

const providers = createProviderRegistry();
providers.register('anthropic', () => mock as never, { models: ['claude-opus-5'] });

const registry = new InMemoryAgentRegistry();
const agentId = registry.register({
  name: 'Probe agent',
  model: 'claude-opus-5',
  provider: 'anthropic',
  systemPrompt: 'You are a probe.',
  tools: [{ type: 'custom', name: 'probe_tool' }],
  maxSteps: 6,
});

const factory = new AgentFactory();
factory.setRegistry(registry);
factory.setProviderRegistry(providers);

const stateView = {
  goal: 'probe',
  constraints: [],
  memory: {},
} as never;

const tools = {
  probe_tool: {
    name: 'probe_tool',
    description: 'probe',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    execute: async () => 'probed',
  },
};

await executeAgent(agentId, stateView, tools as never, 1, { agentFactory: factory, nodeId: 'probe' } as never);

console.log('doStream calls:', mock.doStreamCalls.length);
mock.doStreamCalls.forEach((options: { prompt: unknown }, index: number) => {
  const json = JSON.stringify(options.prompt);
  const markers = (json.match(/cacheControl/g) ?? []).length;
  console.log(`request ${index + 1}: markers = ${markers}`);
});
