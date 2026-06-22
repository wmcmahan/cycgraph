/**
 * Prompt Builder with Self-Annealing Loop — Runnable Example
 *
 * A 7-node workflow where a Prompt Builder agent transforms vague user
 * goals into structured instructions, then a Prompt Critic scores the
 * quality. If the score is below threshold, the builder refines using
 * the critic's feedback — iterating until the instructions are strong
 * enough to hand off to the supervisor.
 *
 * Graph:
 *   prompt_builder → prompt_critic ──[score >= 0.8]──→ supervisor ⇄ [research, write, edit]
 *                         │
 *                         └──[score < 0.8]──→ prompt_builder (refine)
 *
 * Demonstrates: self-annealing prompt enrichment, conditional edges,
 * iterative refinement with critic feedback, goal decomposition, and
 * structured constraint injection before supervisor routing.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/prompt-builder/prompt-builder.ts
 */

import {
  GraphRunner,
  InMemoryPersistenceProvider,
  InMemoryAgentRegistry,
  configureAgentFactory,
  createProviderRegistry,
  configureProviderRegistry,
  createLogger,
  createGraph,
  createWorkflowState,
} from '@cycgraph/orchestrator';

// ─── 0. Fail fast if no API key ──────────────────────────────────────────

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Error: ANTHROPIC_API_KEY environment variable is required');
  console.error('Usage: ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/prompt-builder/prompt-builder.ts');
  process.exit(1);
}

const logger = createLogger('example');

// ─── 1. Register agents ──────────────────────────────────────────────────

const registry = new InMemoryAgentRegistry();

// ── Prompt Builder: drafts (or refines) structured instructions ──────────
const PROMPT_BUILDER_ID = registry.register({
  name: 'Prompt Builder Agent',
  description: 'Transforms vague user goals into structured, actionable instructions',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  systemPrompt: [
    'You are a prompt engineering specialist. Your job is to take a raw user goal and transform it into structured, actionable instructions that a team of AI agents can execute effectively.',
    '',
    'If "prompt_feedback" exists in the workflow state, you are REFINING a previous attempt.',
    'Read the feedback carefully and address every issue raised. Do NOT start from scratch — improve what you already have.',
    '',
    'Given the user\'s goal (and optional constraints), you MUST produce three outputs by calling save_to_memory for each:',
    '',
    '1. "refined_goal" — A clear, specific, and unambiguous restatement of what needs to be accomplished. Remove vagueness. Add specificity. If the goal is broad, narrow the scope to something achievable.',
    '',
    '2. "task_plan" — A step-by-step plan as a numbered list. Each step should be a single, concrete action. The plan should follow this structure:',
    '   - Step 1: Research phase (what specific information to gather)',
    '   - Step 2: Writing phase (what structure, tone, and format to use)',
    '   - Step 3: Editing phase (what quality criteria to check)',
    '',
    '3. "quality_criteria" — A bullet list of specific, measurable criteria the final output must meet. These become the editor\'s checklist.',
    '',
    'Think about what would make downstream agents most effective:',
    '- Be specific about scope (what to include AND exclude)',
    '- Define the target audience explicitly',
    '- Specify format, length, and tone requirements',
    '- Anticipate ambiguities and resolve them',
    '',
    'You MUST call save_to_memory three times: once for "refined_goal", once for "task_plan", and once for "quality_criteria".',
  ].join('\n'),
  temperature: 0.4,
  maxSteps: 5,
  tools: [],
  permissions: {
    readKeys: ['goal', 'constraints', 'refined_goal', 'task_plan', 'quality_criteria', 'prompt_feedback', 'prompt_suggestions'],
    writeKeys: ['refined_goal', 'task_plan', 'quality_criteria'],
  },
});

// ── Prompt Critic: scores the builder's output and gives feedback ────────
const PROMPT_CRITIC_ID = registry.register({
  name: 'Prompt Critic Agent',
  description: 'Evaluates the quality of structured prompt instructions and provides feedback',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  systemPrompt: [
    'You are a prompt quality evaluator. Your job is to assess whether structured instructions are clear, specific, and actionable enough for a team of AI agents to execute.',
    '',
    'You will receive three pieces of output from the prompt builder:',
    '- "refined_goal" — the rewritten goal',
    '- "task_plan" — the step-by-step execution plan',
    '- "quality_criteria" — the measurable checklist',
    '',
    'Evaluate against these dimensions:',
    '1. SPECIFICITY: Are the instructions concrete? Or vague/hand-wavy?',
    '2. ACTIONABILITY: Could an agent execute each step without asking clarifying questions?',
    '3. COMPLETENESS: Does the plan cover research, writing, and editing with clear handoffs?',
    '4. MEASURABILITY: Are the quality criteria actually checkable (not just "be good")?',
    '5. SCOPE: Is the scope realistic and well-bounded (not too broad, not too narrow)?',
    '',
    'You MUST call save_to_memory THREE times:',
    '1. key "prompt_score" — a single number between 0 and 1.',
    '   Scoring: 0.0–0.4 = unusable, 0.5–0.6 = needs significant work, 0.7–0.79 = close but gaps remain, 0.8–0.89 = strong, 0.9–1.0 = exceptional.',
    '2. key "prompt_feedback" — a paragraph explaining what works and what falls short.',
    '3. key "prompt_suggestions" — a bullet list of specific, actionable improvements.',
    '',
    'Be constructive but honest. If the instructions are genuinely good, reflect that in the score.',
    'Do not be needlessly harsh — a clear, specific, complete plan should score 0.8+.',
  ].join('\n'),
  temperature: 0.3,
  maxSteps: 5,
  tools: [],
  permissions: {
    readKeys: ['goal', 'constraints', 'refined_goal', 'task_plan', 'quality_criteria'],
    writeKeys: ['prompt_score', 'prompt_feedback', 'prompt_suggestions'],
  },
});

// ── Supervisor: routes work using the refined instructions ───────────────
const SUPERVISOR_ID = registry.register({
  name: 'Supervisor Agent',
  description: 'Routes tasks between specialist agents using the structured plan',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  systemPrompt: [
    'You are a project supervisor coordinating a team of specialists.',
    'You have three team members: "research" (gathers facts), "write" (produces drafts), and "edit" (polishes prose).',
    '',
    'IMPORTANT: Read the "refined_goal", "task_plan", and "quality_criteria" from the workflow state.',
    'These were prepared and validated by the prompt enrichment pipeline.',
    'Use the task_plan to guide your routing decisions.',
    'Use the quality_criteria to judge when the output meets the bar.',
    '',
    'Typical flow: research → write → edit, but loop back if quality is insufficient.',
    'When the final_draft meets the quality_criteria, route to "__done__" to complete.',
  ].join(' '),
  temperature: 0.3,
  maxSteps: 3,
  tools: [],
  permissions: {
    readKeys: ['*'],
    writeKeys: ['*'],
  },
});

// ── Specialist agents ────────────────────────────────────────────────────
const RESEARCHER_ID = registry.register({
  name: 'Research Agent',
  description: 'Gathers background information guided by the structured plan',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  systemPrompt: [
    'You are a research specialist.',
    'Read the "refined_goal" and "task_plan" from the workflow state — these contain your specific research instructions.',
    'Follow the research steps in the task_plan precisely.',
    'Produce concise, factual research notes as bullet points.',
  ].join(' '),
  temperature: 0.5,
  maxSteps: 3,
  tools: [],
  permissions: {
    readKeys: ['refined_goal', 'task_plan', 'constraints'],
    writeKeys: ['research_notes'],
  },
});

const WRITER_ID = registry.register({
  name: 'Writer Agent',
  description: 'Produces a draft article guided by the structured plan',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  systemPrompt: [
    'You are a professional writer.',
    'Read the "refined_goal", "task_plan", and "quality_criteria" from the workflow state.',
    'Follow the writing instructions in the task_plan for structure, tone, and format.',
    'Use the research_notes as your source material.',
    'Keep the quality_criteria in mind as you write — the editor will check against them.',
  ].join(' '),
  temperature: 0.7,
  maxSteps: 3,
  tools: [],
  permissions: {
    readKeys: ['refined_goal', 'task_plan', 'quality_criteria', 'research_notes'],
    writeKeys: ['draft'],
  },
});

const EDITOR_ID = registry.register({
  name: 'Editor Agent',
  description: 'Polishes a draft using the quality criteria as a checklist',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  systemPrompt: [
    'You are a meticulous editor.',
    'Read the "quality_criteria" from the workflow state — this is your checklist.',
    'Review the draft against each criterion. Fix any issues you find.',
    'Produce a polished final version that passes all quality criteria.',
  ].join(' '),
  temperature: 0.4,
  maxSteps: 3,
  tools: [],
  permissions: {
    readKeys: ['refined_goal', 'quality_criteria', 'draft'],
    writeKeys: ['final_draft'],
  },
});

configureAgentFactory(registry);

const providers = createProviderRegistry();
configureProviderRegistry(providers);

// ─── 2. Define the graph ─────────────────────────────────────────────────
//
// Self-annealing prompt enrichment → supervisor hub-and-spoke:
//
//   ┌──────────────────────────────────────────┐
//   │                                          │
//   │  prompt_builder → prompt_critic ──[≥0.8]──→ supervisor ⇄ research
//   │                       │                              ⇄ write
//   │                       └──[<0.8]──┘                   ⇄ edit
//   │                     (loop back)
//   └──────────────────────────────────────────┘

const graph = createGraph({
  name: 'Prompt Builder with Self-Annealing Loop',
  description: 'Iterative prompt enrichment with critic feedback before supervisor-routed execution',

  nodes: [
    // ── Phase 1: Self-annealing prompt enrichment ──────────────────
    {
      id: 'prompt_builder',
      type: 'agent',
      agentId: PROMPT_BUILDER_ID,
      readKeys: ['goal', 'constraints', 'refined_goal', 'task_plan', 'quality_criteria', 'prompt_feedback', 'prompt_suggestions'],
      writeKeys: ['refined_goal', 'task_plan', 'quality_criteria'],
      failurePolicy: { maxRetries: 2, backoffStrategy: 'exponential', initialBackoffMs: 1000, maxBackoffMs: 60000 },
      requiresCompensation: false,
    },
    {
      id: 'prompt_critic',
      type: 'agent',
      agentId: PROMPT_CRITIC_ID,
      readKeys: ['goal', 'constraints', 'refined_goal', 'task_plan', 'quality_criteria'],
      writeKeys: ['prompt_score', 'prompt_feedback', 'prompt_suggestions'],
      failurePolicy: { maxRetries: 2, backoffStrategy: 'exponential', initialBackoffMs: 1000, maxBackoffMs: 60000 },
      requiresCompensation: false,
    },

    // ── Phase 2: Supervisor-routed execution ───────────────────────
    {
      id: 'supervisor',
      type: 'supervisor',
      agentId: SUPERVISOR_ID,
      readKeys: ['*'],
      writeKeys: ['*'],
      supervisorConfig: {
        managedNodes: ['research', 'write', 'edit'],
        maxIterations: 10,
      },
      failurePolicy: { maxRetries: 2, backoffStrategy: 'exponential', initialBackoffMs: 1000, maxBackoffMs: 60000 },
      requiresCompensation: false,
    },
    {
      id: 'research',
      type: 'agent',
      agentId: RESEARCHER_ID,
      readKeys: ['refined_goal', 'task_plan', 'constraints'],
      writeKeys: ['research_notes'],
      failurePolicy: { maxRetries: 2, backoffStrategy: 'exponential', initialBackoffMs: 1000, maxBackoffMs: 60000 },
      requiresCompensation: false,
    },
    {
      id: 'write',
      type: 'agent',
      agentId: WRITER_ID,
      readKeys: ['refined_goal', 'task_plan', 'quality_criteria', 'research_notes'],
      writeKeys: ['draft'],
      failurePolicy: { maxRetries: 2, backoffStrategy: 'exponential', initialBackoffMs: 1000, maxBackoffMs: 60000 },
      requiresCompensation: false,
    },
    {
      id: 'edit',
      type: 'agent',
      agentId: EDITOR_ID,
      readKeys: ['refined_goal', 'quality_criteria', 'draft'],
      writeKeys: ['final_draft'],
      failurePolicy: { maxRetries: 2, backoffStrategy: 'exponential', initialBackoffMs: 1000, maxBackoffMs: 60000 },
      requiresCompensation: false,
    },
  ],

  edges: [
    // Phase 1: Self-annealing loop
    { source: 'prompt_builder', target: 'prompt_critic' },
    // Loop back if prompt quality is below threshold
    { source: 'prompt_critic', target: 'prompt_builder', condition: { type: 'conditional', condition: 'number(memory.prompt_score) < 0.8' } },
    // Graduate to execution when prompt quality passes
    { source: 'prompt_critic', target: 'supervisor', condition: { type: 'conditional', condition: 'number(memory.prompt_score) >= 0.8' } },

    // Phase 2: Supervisor ⇄ specialists
    { source: 'supervisor', target: 'research' },
    { source: 'supervisor', target: 'write' },
    { source: 'supervisor', target: 'edit' },
    { source: 'research', target: 'supervisor' },
    { source: 'write', target: 'supervisor' },
    { source: 'edit', target: 'supervisor' },
  ],

  startNode: 'prompt_builder',
  endNodes: [],  // Termination via __done__ sentinel
});

// ─── 3. Create initial state ─────────────────────────────────────────────
// Note: the goal is intentionally vague — that's the point.
// The self-annealing loop will refine it until it's actionable.

const initialState = createWorkflowState({
  workflowId: graph.id,
  goal: 'write something about AI agents',
  constraints: ['keep it accessible'],
  maxIterations: 30,    // Allow enough headroom for annealing + execution
  maxExecutionTimeMs: 300_000,
});

// ─── 4. Set up persistence + runner ──────────────────────────────────────

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

// ─── 5. Run ──────────────────────────────────────────────────────────────

async function main() {
  logger.info('Starting prompt-builder workflow with self-annealing loop...');
  logger.info(`Raw goal: "${initialState.goal}"\n`);

  try {
    const finalState = await runner.run();

    if (finalState.status === 'completed') {
      // ── Phase 1 results: prompt enrichment ──────────────────────
      const annealingRounds = finalState.visited_nodes.filter((n: string) => n === 'prompt_critic').length;

      console.log('\n═══ Self-Annealing Prompt Enrichment ═══');
      console.log(`  Rounds: ${annealingRounds} (builder → critic iteration${annealingRounds > 1 ? 's' : ''})`);
      console.log(`  Final prompt score: ${finalState.memory.prompt_score ?? '(unknown)'}`);

      console.log('\n--- Critic Feedback (final round) ---');
      console.log(finalState.memory.prompt_feedback ?? '(none)');

      console.log('\n--- Refined Goal ---');
      console.log(finalState.memory.refined_goal ?? '(none)');
      console.log('\n--- Task Plan ---');
      console.log(finalState.memory.task_plan ?? '(none)');
      console.log('\n--- Quality Criteria ---');
      console.log(finalState.memory.quality_criteria ?? '(none)');

      // ── Phase 2 results: execution ──────────────────────────────
      console.log('\n═══ Supervisor Routing History ═══');
      for (const entry of finalState.supervisor_history) {
        console.log(`  [iter ${entry.iteration}] → ${entry.delegated_to} (${entry.reasoning})`);
      }
      console.log('  → __done__ (workflow completed)');

      console.log('\n═══ Research Notes ═══');
      console.log(finalState.memory.research_notes ?? '(none)');
      console.log('\n═══ Draft ═══');
      console.log(finalState.memory.draft ?? '(none)');
      console.log('\n═══ Final Draft ═══');
      console.log(finalState.memory.final_draft ?? '(none)');

      console.log('\n═══ Stats ═══');
      console.log(`  Nodes visited:  ${finalState.visited_nodes.join(' → ')}`);
      console.log(`  Tokens used:    ${finalState.total_tokens_used}`);
      console.log(`  Cost (USD):     $${finalState.total_cost_usd.toFixed(4)}`);
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
