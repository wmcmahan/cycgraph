/**
 * search — substring search across a jailed workspace
 *
 * Returns matching paths with up to three matching lines each, capped so a
 * broad query is told to narrow rather than flooding the context. Skips the
 * directories no source search wants (dependencies, VCS internals, build
 * output). Tainted, like everything read out of the workspace.
 *
 * @module workspace/search
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { z } from 'zod';
import { defineTool, type DefinedTool } from '@cycgraph/orchestrator';

/** Directories a source search never descends into. */
const DEFAULT_SKIPPED = ['node_modules', '.git', 'dist', 'coverage', '.playground'];

/** Options for {@link searchTool}. */
export interface SearchToolOptions {
  /** The workspace root the search walks. */
  root: string;
  /** Cap on files reported per query. @default 40 */
  maxHits?: number;
  /** Directory names never descended into. @default node_modules, .git, dist, coverage, .playground */
  skipDirs?: string[];
  /** Per-call timeout forwarded to defineTool. @default 15000 */
  timeoutMs?: number;
}

/** Parameters, exported so transports serving this tool share one schema. */
export const searchParameters = z.object({
  query: z.string().min(2).describe('Substring to find in file contents.'),
});

/** Find files whose contents contain a substring. */
export function searchTool(options: SearchToolOptions): DefinedTool {
  const maxHits = options.maxHits ?? 40;
  const skipped = new Set(options.skipDirs ?? DEFAULT_SKIPPED);

  async function* walk(dir: string): AsyncGenerator<string> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!skipped.has(entry.name)) yield* walk(join(dir, entry.name));
        continue;
      }
      yield join(dir, entry.name);
    }
  }

  return defineTool({
    name: 'search',
    description: 'Find files whose contents contain a substring. Returns matching paths with the matching lines.',
    parameters: searchParameters,
    taints: true,
    timeoutMs: options.timeoutMs ?? 15_000,
    execute: async ({ query }) => {
      const hits: string[] = [];
      for await (const file of walk(options.root)) {
        if (hits.length >= maxHits) break;
        let contents: string;
        try {
          contents = await readFile(file, 'utf8');
        } catch {
          continue;
        }
        if (!contents.includes(query)) continue;
        const lines = contents.split('\n')
          .map((line, index) => ({ line, index }))
          .filter(({ line }) => line.includes(query))
          .slice(0, 3)
          .map(({ line, index }) => `${index + 1}: ${line.trim()}`);
        hits.push(`${relative(options.root, file)}\n  ${lines.join('\n  ')}`);
      }
      return hits.length === 0 ? `no file contains '${query}'` : hits.join('\n');
    },
  });
}
