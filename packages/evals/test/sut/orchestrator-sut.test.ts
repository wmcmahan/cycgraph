/**
 * Unit tests for orchestrator-sut helpers.
 *
 * Validates the pure pieces of the SUT — output extraction and mock tool
 * resolution — without spinning up a GraphRunner. Full end-to-end
 * verification happens in the recording script's smoke run, which calls a
 * real LLM and is exercised manually.
 */

import { describe, it, expect } from 'vitest';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { ProviderRegistry } from '@cycgraph/orchestrator';
import { extractOutput, runOrchestratorSut } from '../../src/sut/orchestrator-sut.js';
import { createMockToolResolver } from '../../src/sut/mock-tool-resolver.js';
import { buildSingleAgentGraph } from '../../src/sut/graphs/single-agent.js';

const SUT_MODEL = 'claude-sonnet-4-6';

function textStreamChunks(text: string) {
  return [
    { type: 'stream-start' as const, warnings: [] },
    { type: 'text-start' as const, id: '0' },
    { type: 'text-delta' as const, id: '0', delta: text },
    { type: 'text-end' as const, id: '0' },
    {
      type: 'finish' as const,
      finishReason: 'stop' as const,
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    },
  ];
}

/** A provider registry whose `anthropic` model streams a fixed doStream. */
function registryFor(doStream: () => Promise<{ stream: ReadableStream }>): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register('anthropic', () => new MockLanguageModelV3({ doStream }), {
    models: [SUT_MODEL],
  });
  return registry;
}

/** Streams a single fixed text response and finishes. */
function textRegistry(text: string): ProviderRegistry {
  return registryFor(async () => ({
    stream: simulateReadableStream({ chunks: textStreamChunks(text) }),
  }));
}

describe('extractOutput', () => {
  it('returns a string value verbatim', () => {
    const memory = { response: 'Hello, world.' };
    expect(extractOutput(memory, 'response')).toBe('Hello, world.');
  });

  it('JSON-serializes object values for predictable comparison', () => {
    const memory = { result: { branch: 'clean', reason: 'data has nulls' } };
    expect(extractOutput(memory, 'result')).toBe(
      '{"branch":"clean","reason":"data has nulls"}',
    );
  });

  it('joins multiple keys with a blank line', () => {
    const memory = { notes: 'A', draft: 'B' };
    expect(extractOutput(memory, ['notes', 'draft'])).toBe('A\n\nB');
  });

  it('silently skips missing keys', () => {
    const memory = { notes: 'A' };
    expect(extractOutput(memory, ['notes', 'missing'])).toBe('A');
  });

  it('returns empty string when no requested keys are present', () => {
    expect(extractOutput({}, 'response')).toBe('');
  });

  it('ignores undefined values but keeps empty strings', () => {
    const memory = { a: undefined, b: '' };
    expect(extractOutput(memory, ['a', 'b'])).toBe('');
  });
});

describe('createMockToolResolver', () => {
  it('returns canned tools for MCP-typed sources', async () => {
    const resolver = createMockToolResolver({
      web_search: (args) => ({ results: [`mocked: ${args.query}`] }),
    });

    const tools = await resolver.resolveTools([
      { type: 'mcp', server_id: 'mock', tool_names: ['web_search'] },
    ]);

    expect(tools).toHaveProperty('web_search');
    const webSearch = tools.web_search as {
      description: string;
      execute: (args: Record<string, unknown>) => Promise<unknown>;
    };
    expect(webSearch.description).toContain('web_search');
    const result = await webSearch.execute({ query: 'test' });
    expect(result).toEqual({ results: ['mocked: test'] });
  });

  it('uses caller-supplied descriptions when present', async () => {
    const resolver = createMockToolResolver(
      { web_search: () => ({}) },
      { web_search: 'Search the web for information' },
    );

    const tools = await resolver.resolveTools([
      { type: 'mcp', server_id: 'mock', tool_names: ['web_search'] },
    ]);

    expect((tools.web_search as { description: string }).description).toBe(
      'Search the web for information',
    );
  });

  it('returns all canned tools when tool_names is omitted', async () => {
    const resolver = createMockToolResolver({
      web_search: () => ({}),
      delegate_to_agent: () => ({}),
    });

    const tools = await resolver.resolveTools([
      { type: 'mcp', server_id: 'mock' },
    ]);

    expect(Object.keys(tools).sort()).toEqual([
      'delegate_to_agent',
      'web_search',
    ]);
  });

  it('skips builtin-typed sources (orchestrator resolves them)', async () => {
    const resolver = createMockToolResolver({ web_search: () => ({}) });

    const tools = await resolver.resolveTools([
      { type: 'builtin', name: 'save_to_memory' },
    ]);

    expect(tools).toEqual({});
  });

  it('skips unknown tool names without throwing', async () => {
    const resolver = createMockToolResolver({ web_search: () => ({}) });

    const tools = await resolver.resolveTools([
      { type: 'mcp', server_id: 'mock', tool_names: ['unknown_tool'] },
    ]);

    expect(tools).toEqual({});
  });

  it('closeAll is a no-op that does not throw', async () => {
    const resolver = createMockToolResolver({});
    await expect(resolver.closeAll()).resolves.toBeUndefined();
  });
});

describe('buildSingleAgentGraph', () => {
  it('produces a runnable graph + state + registry from minimal input', () => {
    const artifacts = buildSingleAgentGraph({
      input: 'Summarize the Treaty of Westphalia in 100 words.',
    });

    expect(artifacts.graph.nodes).toHaveLength(1);
    expect(artifacts.graph.nodes[0].type).toBe('agent');
    expect(artifacts.graph.start_node).toBe('agent');
    expect(artifacts.outputKey).toBe('response');
    expect(artifacts.initialState.goal).toBe(
      'Summarize the Treaty of Westphalia in 100 words.',
    );
    expect(artifacts.initialState.workflow_id).toBe(artifacts.graph.id);
  });

  it('threads tool declarations through to the agent config', async () => {
    const artifacts = buildSingleAgentGraph({
      input: 'Find the latest news on TypeScript.',
      tools: [{ type: 'mcp', server_id: 'mock', tool_names: ['web_search'] }],
    });

    const agentNode = artifacts.graph.nodes[0];
    if (agentNode.type !== 'agent') throw new Error('expected agent node');
    const agent = await artifacts.agentRegistry.loadAgent(agentNode.agent_id);
    expect(agent).not.toBeNull();
    expect(agent!.tools).toEqual([
      { type: 'mcp', server_id: 'mock', tool_names: ['web_search'] },
    ]);
  });

  it('uses a custom outputKey when provided', () => {
    const artifacts = buildSingleAgentGraph({
      input: 'Translate "hello" to French.',
      outputKey: 'translation',
    });

    expect(artifacts.outputKey).toBe('translation');
    const agentNode = artifacts.graph.nodes[0];
    expect(agentNode.write_keys).toEqual(['translation']);
  });
});

describe('runOrchestratorSut', () => {
  it('runs a single-agent graph and extracts the agent output', async () => {
    const artifacts = buildSingleAgentGraph({ input: 'Summarize TypeScript.' });

    const result = await runOrchestratorSut({
      graph: artifacts.graph,
      initialState: artifacts.initialState,
      agentRegistry: artifacts.agentRegistry,
      providerRegistry: textRegistry('TypeScript is a typed superset of JavaScript.'),
      outputKey: artifacts.outputKey,
    });

    expect(result.status).toBe('completed');
    expect(result.error).toBeUndefined();
    expect(result.output).toBe('TypeScript is a typed superset of JavaScript.');
    expect(result.toolCalls).toEqual([]);
    expect(result.finalMemory).toHaveProperty(artifacts.outputKey);
  });

  it('captures tool calls in invocation order', async () => {
    let round = 0;
    const registry = registryFor(async () => {
      round++;
      if (round === 1) {
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'tool-call', toolCallId: 'c1', toolName: 'web_search', input: '{"query":"TypeScript"}' },
              { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
            ],
          }),
        };
      }
      return { stream: simulateReadableStream({ chunks: textStreamChunks('Answer complete.') }) };
    });

    const artifacts = buildSingleAgentGraph({
      input: 'Look up TypeScript.',
      tools: [{ type: 'mcp', server_id: 'mock', tool_names: ['web_search'] }],
    });

    const result = await runOrchestratorSut({
      graph: artifacts.graph,
      initialState: artifacts.initialState,
      agentRegistry: artifacts.agentRegistry,
      providerRegistry: registry,
      toolResponses: { web_search: (args) => ({ echo: args.query }) },
      toolDescriptions: { web_search: 'Search the web.' },
      outputKey: artifacts.outputKey,
    });

    expect(result.status).toBe('completed');
    expect(result.output).toBe('Answer complete.');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].toolName).toBe('web_search');
    expect(result.toolCalls[0].order).toBe(0);
    expect(result.toolCalls[0].args).toEqual({ query: 'TypeScript' });
  });

  it('marks a run that exceeds its timeout as timeout', async () => {
    const artifacts = buildSingleAgentGraph({ input: 'Never resolves.' });

    const result = await runOrchestratorSut({
      graph: artifacts.graph,
      initialState: artifacts.initialState,
      agentRegistry: artifacts.agentRegistry,
      providerRegistry: registryFor(() => new Promise(() => {})),
      outputKey: artifacts.outputKey,
      timeoutMs: 20,
    });

    expect(result.status).toBe('timeout');
    expect(result.error).toContain('20ms');
  });

  it('reports failed status when the run rejects', async () => {
    const artifacts = buildSingleAgentGraph({ input: 'Boom.' });
    artifacts.graph.nodes[0].failure_policy = { max_retries: 0 };

    const result = await runOrchestratorSut({
      graph: artifacts.graph,
      initialState: artifacts.initialState,
      agentRegistry: artifacts.agentRegistry,
      providerRegistry: registryFor(async () => {
        throw new Error('provider exploded');
      }),
      outputKey: artifacts.outputKey,
    });

    expect(result.status).toBe('failed');
    expect(result.error).toBeDefined();
  });
});
