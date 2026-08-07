/**
 * Tests for run-scoped agent factories (the Phase-2 multi-tenant fix). A
 * GraphRunner built with `options.registry` resolves agents from THAT
 * registry, so two runners with different registries — even using the same
 * agent id — never contaminate each other, and neither touches the
 * process-global factory.
 *
 * The scoping wire lives in the executor context's `loadAgent` dep, which is
 * asserted directly here (no LLM execution needed).
 */

import { describe, it, expect } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { buildExecutorContext } from '../src/runner/executor-context-builder.js';
import type { ExecutorContextRunner } from '../src/runner/executor-context-builder.js';
import { AgentFactory } from '../src/agent/agent-factory/index.js';
import { InMemoryAgentRegistry } from '../src/persistence/in-memory.js';
import { createTestState, createSimpleGraph } from './helpers/factories.js';

function scopedFactory(systemPrompt: string): AgentFactory {
  const registry = new InMemoryAgentRegistry();
  registry.register({
    id: 'shared',
    name: 'shared',
    model: 'claude-sonnet-4-6',
    provider: 'anthropic',
    systemPrompt,
    tools: [],
    permissions: { readKeys: [], writeKeys: [] },
  });
  const factory = new AgentFactory();
  factory.setRegistry(registry);
  return factory;
}

function contextWith(factory: AgentFactory) {
  const runner = {
    graph: createSimpleGraph(),
    state: createTestState({ run_id: uuidv4() }),
    isStreaming: false,
    tokenChannel: [],
    abortSignal: new AbortController().signal,
    agentFactory: factory,
    emit: () => true,
    listenerCount: () => 0,
  } as unknown as ExecutorContextRunner;
  return buildExecutorContext(runner);
}

describe('run-scoped agent factory', () => {
  it('resolves agents from the run’s own registry', async () => {
    const ctx = contextWith(scopedFactory('tenant-A prompt'));

    const config = await ctx.deps.loadAgent('shared');

    expect(config.system).toBe('tenant-A prompt');
  });

  it('isolates two concurrent runs that share an agent id', async () => {
    const ctxA = contextWith(scopedFactory('tenant-A prompt'));
    const ctxB = contextWith(scopedFactory('tenant-B prompt'));

    const [a, b] = await Promise.all([
      ctxA.deps.loadAgent('shared'),
      ctxB.deps.loadAgent('shared'),
    ]);

    expect(a.system).toBe('tenant-A prompt');
    expect(b.system).toBe('tenant-B prompt');
  });
});
