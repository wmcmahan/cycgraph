/**
 * diagnostics — the environment's answer, on demand
 *
 * Runs one caller-configured command in the workspace and returns what it
 * said, so an editing agent can see its own breakage and iterate instead of
 * failing a later verification blind. The feedback loop is the capability:
 * an editor of any power fails on large edits without one.
 *
 * The agent chooses nothing here — no command, no arguments, no directory.
 * It can only ask the question the caller configured, which is what keeps a
 * command-running tool inside the security mandate: execution reaches the
 * model as a fixed probe of a disposable workspace, never as a shell.
 *
 * @module workspace/diagnostics
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { defineTool, type DefinedTool } from '@cycgraph/orchestrator';

const exec = promisify(execFile);

/** Options for {@link diagnosticsTool}. */
export interface DiagnosticsToolOptions {
  /**
   * Tool name, for graphs that carry more than one probe. @default 'diagnostics'
   */
  name?: string;
  /** Directory the command runs in — the workspace, or a package inside it. */
  cwd: string;
  /** The command, fixed by the caller. */
  command: string;
  /** Its arguments, fixed by the caller. */
  args?: string[];
  /** Lines of output returned before truncation. @default 40 */
  maxLines?: number;
  /** Per-call timeout forwarded to defineTool. @default 120000 */
  timeoutMs?: number;
}

/** Parameters, exported so transports serving this tool share one schema. */
export const diagnosticsParameters = z.object({});

/** What a diagnostics run reports back to the caller and the model. */
export interface DiagnosticsResult {
  /** True when the command exited zero. */
  clean: boolean;
  /** What it printed, truncated to the line cap. */
  output: string;
}

/** Run the configured check and report what it said. */
export function diagnosticsTool(options: DiagnosticsToolOptions): DefinedTool {
  const maxLines = options.maxLines ?? 40;

  return defineTool({
    name: options.name ?? 'diagnostics',
    description: 'Run the workspace\'s configured check (build, typecheck, or tests) and return its findings. Takes no arguments.',
    parameters: diagnosticsParameters,
    timeoutMs: options.timeoutMs ?? 120_000,
    execute: async (): Promise<DiagnosticsResult> => {
      try {
        await exec(options.command, options.args ?? [], { cwd: options.cwd });
        return { clean: true, output: 'no diagnostics' };
      } catch (err) {
        const raw = err instanceof Error
          ? `${String((err as { stdout?: unknown }).stdout ?? '')}\n${String((err as { stderr?: unknown }).stderr ?? '')}`
          : String(err);
        const lines = raw.split('\n').filter(Boolean);
        const output = lines.slice(0, maxLines).join('\n')
          + (lines.length > maxLines ? `\n[${lines.length - maxLines} more line(s) truncated]` : '');
        return { clean: false, output: output || 'the check failed with no output' };
      }
    },
  });
}
