/**
 * Tests for defineTool (src/tools/define-tool.ts): spec validation,
 * JSON-schema projection, argument parsing, and per-call timeout.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import {
  defineTool,
  ToolDefinitionError,
  DEFAULT_CUSTOM_TOOL_TIMEOUT_MS,
} from '../src/tools/define-tool.js';

function echoTool(overrides: Partial<Parameters<typeof defineTool>[0]> = {}) {
  return defineTool({
    name: 'echo',
    description: 'Echoes its input',
    parameters: z.object({ text: z.string() }),
    execute: async ({ text }) => ({ echoed: text }),
    ...overrides,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('defineTool', () => {
  it('exposes tool() as the same function (terse vocabulary alias)', async () => {
    const { tool, defineTool: verbose } = await import('../src/tools/define-tool.js');

    expect(tool).toBe(verbose);
  });

  it('returns a tool carrying name, description, and defaults', () => {
    const tool = echoTool();

    expect(tool.name).toBe('echo');
    expect(tool.description).toBe('Echoes its input');
    expect(tool.taints).toBe(false);
  });

  it('projects the Zod parameters to a JSON schema for the LLM', () => {
    const tool = echoTool();

    expect(tool.parameters.type).toBe('object');
    expect((tool.parameters.properties as Record<string, unknown>).text).toEqual(
      expect.objectContaining({ type: 'string' }),
    );
  });

  it('executes with parsed arguments', async () => {
    const tool = echoTool();

    await expect(tool.execute({ text: 'hi' })).resolves.toEqual({ echoed: 'hi' });
  });

  it('rejects arguments that fail the Zod schema', async () => {
    const tool = echoTool();

    await expect(tool.execute({ text: 42 })).rejects.toThrow();
  });

  it('preserves taints: true from the spec', () => {
    const tool = echoTool({ taints: true });

    expect(tool.taints).toBe(true);
  });

  it('throws on an invalid tool name', () => {
    expect(() => echoTool({ name: 'bad name!' })).toThrow(ToolDefinitionError);
  });

  it('throws on an empty name', () => {
    expect(() => echoTool({ name: '' })).toThrow(ToolDefinitionError);
  });

  it('throws when the name collides with a builtin', () => {
    expect(() => echoTool({ name: 'save_to_memory' })).toThrow(ToolDefinitionError);
  });

  it('throws on a missing description', () => {
    expect(() => echoTool({ description: '' })).toThrow(ToolDefinitionError);
  });

  it('propagates execute errors to the caller', async () => {
    const tool = echoTool({
      execute: async () => {
        throw new Error('downstream failure');
      },
    });

    await expect(tool.execute({ text: 'hi' })).rejects.toThrow('downstream failure');
  });

  it('times out a hung execute after the configured timeout', async () => {
    vi.useFakeTimers();
    const tool = echoTool({
      timeoutMs: 50,
      execute: () => new Promise(() => undefined),
    });

    const pending = tool.execute({ text: 'hi' });
    const assertion = expect(pending).rejects.toThrow('timed out after 50ms');
    await vi.advanceTimersByTimeAsync(51);

    await assertion;
  });

  it('applies the 30s default timeout when none is configured', async () => {
    vi.useFakeTimers();
    const tool = echoTool({ execute: () => new Promise(() => undefined) });

    const pending = tool.execute({ text: 'hi' });
    const assertion = expect(pending).rejects.toThrow(
      `timed out after ${DEFAULT_CUSTOM_TOOL_TIMEOUT_MS}ms`,
    );
    await vi.advanceTimersByTimeAsync(DEFAULT_CUSTOM_TOOL_TIMEOUT_MS + 1);

    await assertion;
  });

  it('disables the timeout when timeoutMs is 0', async () => {
    vi.useFakeTimers();
    let resolveExecute: (value: unknown) => void = () => undefined;
    const tool = echoTool({
      timeoutMs: 0,
      execute: () => new Promise((resolve) => { resolveExecute = resolve; }),
    });

    const pending = tool.execute({ text: 'hi' });
    await vi.advanceTimersByTimeAsync(DEFAULT_CUSTOM_TOOL_TIMEOUT_MS * 2);
    resolveExecute('done');

    await expect(pending).resolves.toBe('done');
  });
});
