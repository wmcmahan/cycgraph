/**
 * Ollama Local — Runnable Example
 *
 * A 2-node linear workflow demonstrating the registerOllamaProvider()
 * integration. Runs against a local Ollama instance with any model.
 *
 * Prerequisites:
 *   1. Install Ollama: https://ollama.com
 *   2. Pull a model: ollama pull gemma2:9b
 *   3. Ensure Ollama is running: ollama serve
 *
 * Usage:
 *   npx tsx examples/ollama-local/ollama-local.ts
 *
 * Environment variables:
 *   OLLAMA_BASE_URL  — Ollama server URL (default: http://localhost:11434)
 *   OLLAMA_MODEL     — Model to use (default: gemma2:9b)
 *
 * Provider options — pick ONE:
 *
 *   Option A: @ai-sdk/openai-compatible (official Vercel package)
 *     npm install @ai-sdk/openai-compatible
 *
 *   Option B: ollama-ai-provider-v2 (Vercel-endorsed community package)
 *     npm install ollama-ai-provider-v2
 *
 * This example uses @ai-sdk/openai pointed at Ollama's /v1 endpoint
 * (Ollama exposes an OpenAI-compatible API). For production use,
 * prefer @ai-sdk/openai-compatible or ollama-ai-provider-v2.
 */

import {
  GraphRunner,
  InMemoryPersistenceProvider,
  InMemoryAgentRegistry,
  configureAgentFactory,
  createProviderRegistry,
  configureProviderRegistry,
  registerOllamaProvider,
  createLogger,
  createGraph,
  createWorkflowState,
} from '@cycgraph/orchestrator';

import { createOpenAI } from '@ai-sdk/openai';

// ─── To use @ai-sdk/openai-compatible instead: ─────────────────────
// import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
// ─── To use ollama-ai-provider-v2 instead: ─────────────────────────
// import { createOllama } from 'ollama-ai-provider-v2';

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'qwen2.5:7b';

const logger = createLogger('example.ollama');

// ─── 0. Check Ollama connectivity ───────────────────────────────────────

async function checkOllama(): Promise<void> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    const models = data.models?.map((m) => m.name) ?? [];
    logger.info('ollama_connected', { url: OLLAMA_BASE_URL, models });

    if (!models.some((m) => m.startsWith(OLLAMA_MODEL.split(':')[0]!))) {
      logger.warn('model_not_found', {
        model: OLLAMA_MODEL,
        hint: `Run: ollama pull ${OLLAMA_MODEL}`,
      });
    }
  } catch (err) {
    console.error(`\nCannot reach Ollama at ${OLLAMA_BASE_URL}`);
    console.error('Make sure Ollama is running: ollama serve');
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

// ─── 1. Register agents ─────────────────────────────────────────────────

const registry = new InMemoryAgentRegistry();

const RESEARCHER_ID = registry.register({
  name: 'Local Research Agent',
  description: 'Gathers background information using a local model',
  model: OLLAMA_MODEL,
  provider: 'ollama',
  systemPrompt: [
    'You are a research specialist.',
    'Given a goal, produce concise, factual research notes.',
    'Focus on key facts and notable perspectives.',
    'Write your findings as bullet points.',
  ].join(' '),
  temperature: 0.5,
  maxSteps: 3,
  tools: [],
  permissions: {
    readKeys: ['goal', 'constraints'],
    writeKeys: ['research_notes'],
  },
});

const WRITER_ID = registry.register({
  name: 'Local Writer Agent',
  description: 'Produces a polished draft using a local model',
  model: OLLAMA_MODEL,
  provider: 'ollama',
  systemPrompt: [
    'You are a professional writer.',
    'Using the provided research notes, produce a clear and engaging summary.',
    'Keep it under 300 words. Use plain language.',
  ].join(' '),
  temperature: 0.7,
  maxSteps: 3,
  tools: [],
  permissions: {
    readKeys: ['goal', 'research_notes'],
    writeKeys: ['draft'],
  },
});

configureAgentFactory(registry);

// ─── 2. Configure providers ─────────────────────────────────────────────

const providers = createProviderRegistry();

// Using @ai-sdk/openai pointed at Ollama's OpenAI-compatible /v1 endpoint.
// This works because Ollama exposes an OpenAI-compatible API.
//
// Alternative factories (swap into registerOllamaProvider):
//
//   @ai-sdk/openai-compatible:
//     ({ baseURL }) => (modelId) =>
//       createOpenAICompatible({ name: 'ollama', baseURL: `${baseURL}/v1`, apiKey: 'ollama' }).chatModel(modelId)
//
//   ollama-ai-provider-v2:
//     ({ baseURL }) => createOllama({ baseURL })
//
// Note: .chat() forces the Chat Completions API (/v1/chat/completions).
// The default createOpenAI() callable uses the Responses API (/v1/responses)
// which Ollama does not support.
registerOllamaProvider(
  providers,
  ({ baseURL }) => {
    const provider = createOpenAI({ baseURL: `${baseURL}/v1`, apiKey: 'ollama' });
    return (modelId) => provider.chat(modelId);
  },
);

configureProviderRegistry(providers);

// ─── 3. Define the graph ────────────────────────────────────────────────

const graph = createGraph({
  name: 'Ollama Local Research & Write',
  description: 'Two-node linear workflow running on local Ollama models',

  nodes: [
    {
      id: 'research',
      type: 'agent',
      agentId: RESEARCHER_ID,
      readKeys: ['goal', 'constraints'],
      writeKeys: ['research_notes'],
      failurePolicy: { maxRetries: 1, backoffStrategy: 'exponential', initialBackoffMs: 1000, maxBackoffMs: 30000 },
      requiresCompensation: false,
    },
    {
      id: 'write',
      type: 'agent',
      agentId: WRITER_ID,
      readKeys: ['goal', 'research_notes'],
      writeKeys: ['draft'],
      failurePolicy: { maxRetries: 1, backoffStrategy: 'exponential', initialBackoffMs: 1000, maxBackoffMs: 30000 },
      requiresCompensation: false,
    },
  ],

  edges: [{ source: 'research', target: 'write' }],
  startNode: 'research',
  endNodes: ['write'],
});

// ─── 4. Create initial state ────────────────────────────────────────────

const initialState = createWorkflowState({
  workflowId: graph.id,
  goal: 'Explain what large language models are and how they work, in simple terms.',
  constraints: ['Keep the final draft under 300 words', 'Use plain language suitable for a general audience'],
  maxExecutionTimeMs: 300_000, // 5 min — local models are slower
});

// ─── 5. Run ─────────────────────────────────────────────────────────────

async function main() {
  await checkOllama();

  logger.info('Starting Ollama local workflow...\n');
  logger.info('model', { model: OLLAMA_MODEL, baseUrl: OLLAMA_BASE_URL });

  const persistence = new InMemoryPersistenceProvider();
  const runner = new GraphRunner(graph, initialState, {
    persistStateFn: async (state) => {
      await persistence.saveWorkflowState(state);
      await persistence.saveWorkflowRun(state);
    },
  });

  runner.on('workflow:start', ({ run_id }) => {
    logger.info(`Workflow started: ${run_id}`);
  });

  runner.on('node:start', ({ node_id, type }) => {
    logger.info(`  Node started: ${node_id} (${type})`);
  });

  runner.on('node:complete', ({ node_id, duration_ms }) => {
    logger.info(`  Node complete: ${node_id} (${duration_ms}ms)`);
  });

  runner.on('workflow:complete', ({ run_id, duration_ms }) => {
    logger.info(`Workflow complete: ${run_id} (${duration_ms}ms)`);
  });

  runner.on('workflow:failed', ({ run_id, error }) => {
    logger.error(`Workflow failed: ${run_id} — ${error}`);
  });

  try {
    const finalState = await runner.run();

    if (finalState.status === 'completed') {
      console.log('\n═══ Research Notes ═══');
      console.log(finalState.memory.research_notes ?? '(none)');
      console.log('\n═══ Final Draft ═══');
      console.log(finalState.memory.draft ?? '(none)');
      console.log('\n═══ Stats ═══');
      console.log(`  Tokens used: ${finalState.total_tokens_used}`);
      console.log(`  Cost (USD):  $${finalState.total_cost_usd.toFixed(4)} (local — free)`);
    } else {
      console.error(`Workflow ended with status: ${finalState.status}`);
      if (finalState.last_error) {
        console.error(`Error: ${finalState.last_error}`);
      }
      process.exit(1);
    }
  } catch (err) {
    console.error('Fatal error:', err);
    process.exit(1);
  }
}

main();
