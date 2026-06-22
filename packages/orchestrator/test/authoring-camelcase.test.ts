/**
 * camelCase authoring across the public constructors (agents, workflow state,
 * MCP servers). Authoring is camelCase; the stored/returned wire format stays
 * snake_case. Freeform records (memory, providerOptions, transport env) keep
 * their keys verbatim.
 */
import { describe, it, expect } from 'vitest';
import {
  createWorkflowState,
  InMemoryAgentRegistry,
  InMemoryMCPServerRegistry,
} from '../src/index.js';

describe('createWorkflowState camelCase authoring', () => {
  it('maps camelCase fields to the snake_case runtime state', () => {
    const state = createWorkflowState({
      workflowId: '00000000-0000-0000-0000-000000000000',
      goal: 'do the thing',
      maxIterations: 20,
      maxExecutionTimeMs: 90_000,
      maxTokenBudget: 5_000,
    });

    expect(state.workflow_id).toBe('00000000-0000-0000-0000-000000000000');
    expect(state.max_iterations).toBe(20);
    expect(state.max_execution_time_ms).toBe(90_000);
    expect(state.max_token_budget).toBe(5_000);
    expect(state).not.toHaveProperty('workflowId');
  });

  it('preserves freeform memory keys verbatim', () => {
    const state = createWorkflowState({
      workflowId: '00000000-0000-0000-0000-000000000000',
      goal: 'g',
      memory: { camelKey: 1, nested_snake: { innerCamel: 2 } },
    });
    expect(state.memory).toEqual({ camelKey: 1, nested_snake: { innerCamel: 2 } });
  });
});

describe('InMemoryAgentRegistry camelCase authoring', () => {
  it('maps camelCase agent config to the snake_case stored entry', async () => {
    const registry = new InMemoryAgentRegistry();
    const id = registry.register({
      name: 'Camel Agent',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      systemPrompt: 'You are helpful.',
      maxSteps: 7,
      modelPreference: 'high',
      tools: [{ type: 'mcp', serverId: 'web', toolNames: ['search'] }],
      providerOptions: { anthropic: { thinking: { budgetTokens: 1024 } } },
      permissions: { readKeys: ['goal'], writeKeys: ['draft'] },
    });

    const entry = await registry.loadAgent(id);
    expect(entry?.system_prompt).toBe('You are helpful.');
    expect(entry?.max_steps).toBe(7);
    expect(entry?.model_preference).toBe('high');
    expect(entry?.permissions).toMatchObject({ read_keys: ['goal'], write_keys: ['draft'] });
    // tools remap to snake wire form
    expect(entry?.tools).toEqual([{ type: 'mcp', server_id: 'web', tool_names: ['search'] }]);
    // providerOptions is freeform — inner keys preserved verbatim
    expect(entry?.provider_options).toEqual({ anthropic: { thinking: { budgetTokens: 1024 } } });
  });

  it('updateAgent accepts camelCase partial updates', async () => {
    const registry = new InMemoryAgentRegistry();
    const id = registry.register({
      name: 'A',
      model: 'm',
      provider: 'anthropic',
      systemPrompt: 'x',
      permissions: { readKeys: [], writeKeys: [] },
    });
    await registry.updateAgent(id, { systemPrompt: 'updated', maxSteps: 3 });
    const entry = await registry.loadAgent(id);
    expect(entry?.system_prompt).toBe('updated');
    expect(entry?.max_steps).toBe(3);
  });
});

describe('InMemoryMCPServerRegistry camelCase authoring', () => {
  it('maps camelCase server config to the snake_case stored entry', async () => {
    const registry = new InMemoryMCPServerRegistry();
    await registry.saveServer({
      id: 'web',
      name: 'Web',
      transport: { type: 'stdio', command: 'node', args: ['server.js'], env: { API_KEY: 'x' } },
      allowedAgents: ['agent-1'],
      timeoutMs: 5_000,
      toolTimeoutMs: 2_000,
    });

    const entry = await registry.loadServer('web');
    expect(entry?.allowed_agents).toEqual(['agent-1']);
    expect(entry?.timeout_ms).toBe(5_000);
    expect(entry?.tool_timeout_ms).toBe(2_000);
    // transport env keys are user-controlled — preserved verbatim
    if (entry?.transport.type === 'stdio') {
      expect(entry.transport.env).toEqual({ API_KEY: 'x' });
    }
  });
});
