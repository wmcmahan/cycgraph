/**
 * Workflow Architect
 *
 * Generates executable {@link Graph} definitions from natural language
 * prompts using an LLM with structured output.
 *
 * Flow:
 * 1. User provides a natural language prompt
 * 2. LLM generates a structured graph JSON via `Output.object`
 * 3. Output is validated with `validateGraph` (referential integrity)
 * 4. If validation fails, errors are fed back for self-correction
 * 5. Valid graph is returned for **human review** before publishing
 *
 * Human-in-the-loop: Generated graphs are NEVER executed automatically.
 * They must be explicitly published by a human.
 *
 * @module architect
 */

import { generateText, Output } from 'ai';
import { z } from 'zod';
import { agentFactory } from '../agent/agent-factory/index.js';
import { validateGraph } from '../validation/graph-validator.js';
import { createLogger } from '../utils/logger.js';
import type { Graph } from '../types/graph.js';
import { ARCHITECT_SYSTEM_PROMPT } from './prompts.js';
import { LLMGraphSchema } from './schemas.js';
import { ArchitectError } from './errors.js';
import { llmGraphToGraph, graphToLLMSnapshot } from './utils.js';

const logger = createLogger('architect');

/** Inferred type of an LLM-generated graph. */
export type LLMGraph = z.infer<typeof LLMGraphSchema>;

/** Options for the {@link generateWorkflow} function. */
export interface GenerateWorkflowOptions {
  /** Natural language description of the desired workflow. */
  prompt: string;
  /** Optional existing graph to modify (for iterative refinement). */
  currentGraph?: Graph;
  /** Agent ID whose model config to use (default: `"architect-agent"`). */
  architectAgentId?: string;
  /** Max self-correction attempts on validation failure (default: `2`). */
  maxRetries?: number;
}

/** Result of a successful workflow generation. */
export interface GenerateWorkflowResult {
  /** The generated, validated Graph object (ready for human review). */
  graph: Graph;
  /** Raw LLM output before conversion. */
  raw: LLMGraph;
  /** Number of generation attempts (1 = first try, 2+ = self-corrected). */
  attempts: number;
  /** Any warnings from graph validation. */
  warnings: string[];
  /** Whether this was a modification of an existing graph. */
  is_modification: boolean;
}

/**
 * Generate an executable workflow graph from a natural language prompt.
 *
 * Supports two modes:
 * - **Create**: Generate a new graph from scratch.
 * - **Modify**: Provide `currentGraph` to refine an existing graph.
 *
 * On validation failure, the errors are fed back to the LLM for
 * self-correction up to `maxRetries` times.
 *
 * @param options - Generation options.
 * @returns The generated graph with metadata.
 * @throws {ArchitectError} If all attempts (including retries) fail.
 */
export async function generateWorkflow(
  options: GenerateWorkflowOptions
): Promise<GenerateWorkflowResult> {
  const {
    prompt,
    currentGraph,
    architectAgentId = 'architect-agent',
    maxRetries = 2,
  } = options;

  const isModification = Boolean(currentGraph);
  logger.info('generation_started', { prompt: prompt.slice(0, 100), is_modification: isModification });

  const config = await agentFactory.loadAgent(architectAgentId);
  const model = agentFactory.getModel(config);

  let lastError: string | null = null;
  let attempts = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    attempts = attempt + 1;

    let userMessage: string;
    if (isModification && currentGraph) {
      const graphSnapshot = graphToLLMSnapshot(currentGraph);
      userMessage = `Here is the EXISTING workflow graph:\n\n${JSON.stringify(graphSnapshot, null, 2)}\n\nThe user wants to modify it:\n${prompt}\n\nOutput the COMPLETE modified graph (not just the changes).`;
    } else {
      userMessage = `Design a workflow graph for:\n\n${prompt}`;
    }

    if (lastError) {
      userMessage += `\n\nYour previous output had validation errors. Fix them:\n${lastError}`;
    }

    try {
      const { output: llmGraph } = await generateText({
        model,
        output: Output.object({ schema: LLMGraphSchema }),
        system: ARCHITECT_SYSTEM_PROMPT,
        prompt: userMessage,
        temperature: 0.3,
      });

      logger.info('llm_output_received', { attempt: attempts, name: llmGraph.name });

      const graph = llmGraphToGraph(llmGraph, currentGraph?.id);
      const validation = validateGraph(graph);

      if (!validation.valid) {
        lastError = validation.errors.join('\n');
        logger.warn('validation_failed', { attempt: attempts, errors: validation.errors });
        continue;
      }

      logger.info('generation_complete', {
        name: graph.name,
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        attempts,
        warnings: validation.warnings.length,
      });

      return {
        graph,
        raw: llmGraph,
        attempts,
        warnings: validation.warnings,
        is_modification: isModification,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      logger.warn('generation_attempt_failed', {
        attempt: attempts,
        error: lastError,
      });
    }
  }

  throw new ArchitectError(
    `Failed to generate a valid workflow after ${attempts} attempts. Last error: ${lastError}`
  );
}
