/**
 * text_extract — regex extraction with a real ReDoS guard
 *
 * LLM-authored regexes are a ReDoS vector: a catastrophically backtracking
 * pattern blocks the event loop, and a Promise.race timeout never fires
 * against synchronous execution. The guard here is structural: the regex
 * runs in a worker thread that is TERMINATED when the deadline passes, plus
 * pattern-length, input-length, and match-count caps.
 *
 * Pure with respect to taint (extraction from text the workflow already
 * holds; the input's own taint is tracked where it entered).
 *
 * @module data/text-extract
 */

import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import { defineTool, type DefinedTool } from '@cycgraph/orchestrator';

/** One extracted match. */
export interface ExtractedMatch {
  match: string;
  index: number;
  groups: string[];
  named: Record<string, string>;
}

/** Options for {@link createTextExtractTool}. */
export interface TextExtractToolOptions {
  /** Deadline for regex execution; the worker is terminated when it passes. @default 2000 */
  regexTimeoutMs?: number;
  /** Hard cap on matches returned. @default 100 */
  maxMatches?: number;
}

/**
 * Worker body (CJS, `eval: true`). Runs the regex and posts matches; the
 * parent enforces the deadline by terminating the whole thread.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const { text, pattern, flags, maxMatches } = workerData;
const re = new RegExp(pattern, flags);
const matches = [];
const record = (m) => matches.push({
  match: m[0],
  index: m.index,
  groups: m.slice(1).map((g) => g === undefined ? '' : g),
  named: m.groups ? { ...m.groups } : {},
});
if (flags.includes('g')) {
  let m;
  while ((m = re.exec(text)) !== null && matches.length < maxMatches) {
    record(m);
    if (m.index === re.lastIndex) re.lastIndex++;
  }
} else {
  const m = re.exec(text);
  if (m) record(m);
}
parentPort.postMessage(matches);
`;

/** Run a regex in a terminatable worker. */
function execInWorker(
  text: string,
  pattern: string,
  flags: string,
  maxMatches: number,
  timeoutMs: number,
): Promise<ExtractedMatch[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { text, pattern, flags, maxMatches },
    });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error(`Regex execution exceeded ${timeoutMs}ms and was terminated (possible catastrophic backtracking)`));
    }, timeoutMs);

    worker.once('message', (matches: ExtractedMatch[]) => {
      clearTimeout(timer);
      void worker.terminate();
      resolve(matches);
    });
    worker.once('error', (err) => {
      clearTimeout(timer);
      void worker.terminate();
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

/**
 * Create the `text_extract` tool.
 */
export function createTextExtractTool(options: TextExtractToolOptions = {}): DefinedTool {
  const regexTimeoutMs = options.regexTimeoutMs ?? 2_000;
  const maxMatches = options.maxMatches ?? 100;

  return defineTool({
    name: 'text_extract',
    description:
      'Extract regex matches from text. Returns each match with its index, ' +
      'positional capture groups, and named groups. Add the "g" flag for all ' +
      'matches; omit it for the first only.',
    parameters: z.object({
      text: z.string().min(1).max(100_000).describe('The text to search'),
      pattern: z.string().min(1).max(200).describe('JavaScript regex pattern (no slashes)'),
      flags: z
        .string()
        .regex(/^[gims]*$/, 'flags may only contain g, i, m, s')
        .optional()
        .describe('Regex flags (subset of g, i, m, s)'),
    }),
    // The defineTool timeout is a backstop; the real deadline is the worker
    // termination inside execute.
    timeoutMs: regexTimeoutMs + 3_000,
    execute: async ({ text, pattern, flags }) => {
      try {
        new RegExp(pattern, flags ?? '');
      } catch (err) {
        throw new Error(`Invalid regex: ${(err as Error).message}`, { cause: err });
      }

      const matches = await execInWorker(text, pattern, flags ?? '', maxMatches, regexTimeoutMs);
      return { matches, count: matches.length, truncated: matches.length >= maxMatches };
    },
  });
}
