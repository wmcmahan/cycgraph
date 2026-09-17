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
  /** Line cap for the reported output, header and separator included. @default 40 */
  maxLines?: number;
  /**
   * Character cap per reported line. Structured-log emitters put
   * kilobytes on a single line, so a line cap alone bounds nothing;
   * over-long lines are cut with a marker. @default 400
   */
  maxLineLength?: number;
  /** Per-call timeout forwarded to defineTool. @default 120000 */
  timeoutMs?: number;
  /**
   * Environment for the spawned command. Defaults to the process env;
   * callers holding production credentials (a database URL a test suite
   * would activate on) should pass a scrubbed copy.
   */
  env?: NodeJS.ProcessEnv;
}

/** Parameters, exported so transports serving this tool share one schema. */
export const diagnosticsParameters = z.object({});

/** What a diagnostics run reports back to the caller and the model. */
export interface DiagnosticsResult {
  /** True when the command exited zero. */
  clean: boolean;
  /** What it printed, each line capped at the length limit. Past the line cap: failure-marker lines first, then the tail, under a count header; header and separator count against the cap. */
  output: string;
}

/** Run the configured check and report what it said. */
export function diagnosticsTool(options: DiagnosticsToolOptions): DefinedTool {
  const maxLines = options.maxLines ?? 40;
  const maxLineLength = options.maxLineLength ?? 400;
  const capLine = (line: string): string =>
    line.length <= maxLineLength ? line : `${line.slice(0, maxLineLength)} …[line truncated]`;

  return defineTool({
    name: options.name ?? 'diagnostics',
    description: 'Run the workspace\'s configured check (build, typecheck, or tests) and return its findings. Takes no arguments.',
    parameters: diagnosticsParameters,
    timeoutMs: options.timeoutMs ?? 120_000,
    execute: async (): Promise<DiagnosticsResult> => {
      try {
        await exec(options.command, options.args ?? [], { cwd: options.cwd, ...(options.env !== undefined ? { env: options.env } : {}) });
        return { clean: true, output: 'no diagnostics' };
      } catch (err) {
        const raw = err instanceof Error
          ? `${String((err as { stdout?: unknown }).stdout ?? '')}\n${String((err as { stderr?: unknown }).stderr ?? '')}`
          : String(err);
        // Marker selection runs on uncapped lines: a structured-log line
        // carries its AssertionError: payload well past the length cap,
        // and capping first would stop exactly that failure from being
        // recognized. The cap applies to what is reported, not searched.
        const lines = raw.split('\n').filter(Boolean);
        if (lines.length <= maxLines) {
          return { clean: false, output: lines.map(capLine).join('\n') || 'the check failed with no output' };
        }
        // Past the cap, failure markers come first and the tail fills
        // the rest: a multi-workspace test run buries its FAIL and
        // `npm error` lines under later workspaces' passing output, so
        // a plain tail can read as green while the run failed. `Error:`
        // is deliberately unanchored — TypeError:, AssertionError:, and
        // the other subclasses must match too. Header and separator
        // count against the cap, so the output never exceeds it.
        const markers = lines
          .filter((line) => /npm error|\bFAIL\b|✗|✘|Failed (Suites|Tests)|Error:/.test(line))
          .slice(0, Math.floor((maxLines - 2) / 2));
        if (markers.length === 0) {
          const tail = lines.slice(-(maxLines - 1)).map(capLine);
          return {
            clean: false,
            output: [`[${lines.length - tail.length} earlier line(s) truncated]`, ...tail].join('\n'),
          };
        }
        const tail = lines.slice(-(maxLines - 2 - markers.length)).map(capLine);
        const output = [
          `[${lines.length} line(s) total; ${markers.length} failure line(s) first, then the tail]`,
          ...markers.map(capLine),
          '---',
          ...tail,
        ].join('\n');
        return { clean: false, output };
      }
    },
  });
}
