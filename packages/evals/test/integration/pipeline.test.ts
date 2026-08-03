/**
 * Integration Test — Full Eval Pipeline
 *
 * Tests the complete eval pipeline end-to-end without requiring
 * an actual LLM. Uses a mock provider and verifies that:
 * - Suite loader resolves the orchestrator suite
 * - Golden trajectories are loaded and mapped to test cases
 * - Assertions are built correctly
 * - Drift calculator produces valid reports
 * - Reporter formats output for both local and CI modes
 */

import { describe, it, expect } from 'vitest';
import { loadGoldenTrajectories } from '../../src/dataset/loader.js';
import { assertToolCallStructure, assertTrajectoryStructure } from '../../src/assertions/zod-structural.js';
import { parseJudgeResponse, evaluateMetric, ANSWER_RELEVANCY } from '../../src/assertions/semantic-judge.js';
import { computeDrift } from '../../src/assertions/drift-calculator.js';
import { formatReport } from '../../src/runner/reporter.js';
import { createOllamaProvider } from '../../src/providers/ollama.js';
import { createOpenAIProvider } from '../../src/providers/openai.js';
import type { TestCaseResults } from '../../src/assertions/drift-calculator.js';
import type { ToolCall } from '../../src/dataset/types.js';
import type { SemanticJudgeContext } from '../../src/assertions/semantic-judge.js';

describe('Full Pipeline Integration', () => {
  describe('golden dataset → assertions → drift → report', () => {
    it('loads orchestrator trajectories and produces a valid drift report', () => {
      const trajectories = loadGoldenTrajectories('orchestrator');
      expect(trajectories.length).toBeGreaterThan(0);

      const testResults: TestCaseResults[] = trajectories.map(trajectory => {
        const zodResults = trajectory.expectedToolCalls
          ? assertTrajectoryStructure(
              trajectory.expectedToolCalls,
              trajectory.expectedToolCalls,
            )
          : [];

        return {
          suite: 'orchestrator',
          zodResults,
          semanticResults: [{
            passed: true,
            score: 0.95,
            reasoning: 'Mock judge: self-comparison always passes',
            metric: 'answer_relevancy',
          }],
        };
      });

      const drift = computeDrift(testResults);

      expect(drift.aggregatePercent).toBe(0);
      expect(drift.passed).toBe(true);
      expect(drift.perSuite['orchestrator']).toBeDefined();
      expect(drift.perSuite['orchestrator'].totalTests).toBe(trajectories.length);

      const localReport = formatReport(drift, 'local');
      expect(localReport.text).toContain('PASS');
      expect(localReport.text).toContain('orchestrator');
      expect(localReport.annotations).toEqual([]);

      const ciReport = formatReport(drift, 'ci');
      expect(ciReport.annotations).toEqual([]);
    });

    it('detects drift when tool calls mismatch', () => {
      const trajectories = loadGoldenTrajectories('orchestrator');
      const withToolCalls = trajectories.filter(
        t => t.expectedToolCalls && t.expectedToolCalls.length > 0,
      );
      expect(withToolCalls.length).toBeGreaterThan(0);

      const testResults: TestCaseResults[] = withToolCalls.map(trajectory => {
        const wrongToolCalls: ToolCall[] = trajectory.expectedToolCalls!.map(tc => ({
          ...tc,
          toolName: 'wrong_tool',
        }));

        const zodResults = assertTrajectoryStructure(
          wrongToolCalls,
          trajectory.expectedToolCalls!,
        );

        return {
          suite: 'orchestrator',
          zodResults,
          semanticResults: [{
            passed: false,
            score: 0.3,
            reasoning: 'Wrong tool called',
            metric: 'answer_relevancy',
          }],
        };
      });

      const drift = computeDrift(testResults);

      expect(drift.aggregatePercent).toBeGreaterThan(0);
      expect(drift.passed).toBe(false);

      const report = formatReport(drift, 'ci');
      expect(report.text).toContain('FAIL');
      expect(report.annotations.some(a => a.startsWith('::error'))).toBe(true);
    });
  });

  describe('structural assertions — forgiving values', () => {
    it('passes when values differ but types match', () => {
      const actual: ToolCall = {
        toolName: 'web_search',
        args: { query: 'OpenAI CEO name' },
      };
      const expected: ToolCall = {
        toolName: 'web_search',
        args: { query: 'current CEO of OpenAI' },
      };

      const result = assertToolCallStructure(actual, expected);

      expect(result.passed).toBe(true);
    });

    it('fails when required params are missing', () => {
      const actual: ToolCall = {
        toolName: 'save_to_memory',
        args: { key: 'research' },
      };
      const expected: ToolCall = {
        toolName: 'save_to_memory',
        args: { key: 'research', value: 'some data' },
      };

      const result = assertToolCallStructure(actual, expected);

      expect(result.passed).toBe(false);
      expect(result.missingParams).toContain('value');
    });
  });

  describe('semantic judge — response parsing', () => {
    it('handles well-formed judge responses', () => {
      const parsed = parseJudgeResponse('{"score": 0.85, "reasoning": "Good semantic match"}');
      expect(parsed.score).toBe(0.85);
      expect(parsed.reasoning).toBe('Good semantic match');
    });

    it('handles malformed responses gracefully', () => {
      const parsed = parseJudgeResponse('I think this is a good answer overall.');
      expect(parsed.score).toBe(0);
      expect(parsed.reasoning).toContain('Failed to parse');
    });

    it('runs evaluateMetric with mock judge', async () => {
      const context: SemanticJudgeContext = {
        input: 'Who is the CEO of Anthropic?',
        actualOutput: 'Dario Amodei',
        expectedOutput: 'Dario Amodei is the CEO of Anthropic.',
      };

      const mockJudge = async () => '{"score": 0.92, "reasoning": "Correct answer, slightly less detailed"}';
      const result = await evaluateMetric(context, ANSWER_RELEVANCY, mockJudge);

      expect(result.passed).toBe(true);
      expect(result.score).toBe(0.92);
      expect(result.metric).toBe('answer_relevancy');
    });
  });

  describe('providers', () => {
    it('creates ollama provider with defaults', () => {
      const provider = createOllamaProvider();

      expect(provider.name).toContain('ollama');
      expect(provider.mode).toBe('local');
      expect(provider.maxConcurrency).toBe(2);
      expect(provider.estimateCost(100).estimatedUsd).toBe(0);
      expect(typeof provider.callJudge).toBe('function');
    });

    it('creates openai provider with explicit key', () => {
      const provider = createOpenAIProvider({ apiKey: 'test-key' });

      expect(provider.name).toContain('openai');
      expect(provider.mode).toBe('ci');
      expect(provider.maxConcurrency).toBe(8);

      const cost = provider.estimateCost(100);
      expect(cost.estimatedUsd).toBeGreaterThan(0);
    });

    it('openai provider warns on high cost', () => {
      const provider = createOpenAIProvider({
        apiKey: 'test-key',
        costWarningThreshold: 0.01,
      });

      const cost = provider.estimateCost(100);
      expect(cost.warning).toBeDefined();
    });

    it('openai provider throws without API key', () => {
      const original = process.env['OPENAI_API_KEY'];
      delete process.env['OPENAI_API_KEY'];

      expect(() => createOpenAIProvider()).toThrow('OPENAI_API_KEY');

      if (original) process.env['OPENAI_API_KEY'] = original;
    });
  });
});
