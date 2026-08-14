/**
 * Ollama Local — a two-node pipeline against a local model, no API key.
 *
 * Run:  ollama serve && npx tsx examples/ollama-local/ollama-local.ts
 * See:  ./README.md for provider-client options and running any example locally.
 */

import {
  agent,
  node,
  graph,
  state,
  agentsForGraph,
  GraphRunner,
  InMemoryPersistenceProvider,
  InMemoryAgentRegistry,
  createProviderRegistry,
  registerOllamaProvider,
  createLogger,
} from '@cycgraph/orchestrator';

import { createOpenAI } from '@ai-sdk/openai';


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

// ─── 1. Define agents ───────────────────────────────────────────────────
// The provider can't be inferred from a local model name, so name it explicitly.

const researcher = agent({
  name: 'Local Research Agent',
  description: 'Gathers background information using a local model',
  model: OLLAMA_MODEL,
  provider: 'ollama',
  instructions: [
    'You are a research specialist.',
    'Given a goal, produce concise, factual research notes.',
    'Focus on key facts and notable perspectives.',
    'Write your findings as bullet points.',
  ].join(' '),
  temperature: 0.5,
  maxSteps: 3,
});

const writer = agent({
  name: 'Local Writer Agent',
  description: 'Produces a polished draft using a local model',
  model: OLLAMA_MODEL,
  provider: 'ollama',
  instructions: [
    'You are a professional writer.',
    'Using the provided research notes, produce a clear and engaging summary.',
    'Keep it under 300 words. Use plain language.',
  ].join(' '),
  temperature: 0.7,
  maxSteps: 3,
});

// ─── 2. Place them in a graph ───────────────────────────────────────────

const research = node({
  id: 'research',
  agent: researcher,
  reads: ['goal', 'constraints'],
  writes: 'research_notes',
  failurePolicy: { maxRetries: 1, maxBackoffMs: 30_000 },
});

const write = node({
  id: 'write',
  agent: writer,
  reads: ['goal', 'research_notes'],
  writes: 'draft',
  failurePolicy: { maxRetries: 1, maxBackoffMs: 30_000 },
});

const workflow = graph({
  name: 'Ollama Local Research & Write',
  description: 'Two-node linear workflow running on local Ollama models',
  nodes: [research, write],
  edges: [{ from: research, to: write }],
});

// The graph carries its agent() configs; register them into a run-scoped
// registry for the explicit GraphRunner path.
const registry = new InMemoryAgentRegistry();
for (const config of agentsForGraph(workflow)) registry.register(config);

// ─── 3. Configure providers (run-scoped) ────────────────────────────────

const providers = createProviderRegistry();

// @ai-sdk/openai works here because Ollama exposes an OpenAI-compatible /v1.
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

// ─── 4. Create initial state ────────────────────────────────────────────

const initialState = state({
  workflowId: workflow.id,
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
  const runner = new GraphRunner(workflow, initialState, {
    registry,
    providers,
    persistState: async (s) => {
      await persistence.saveWorkflowState(s);
      await persistence.saveWorkflowRun(s);
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
