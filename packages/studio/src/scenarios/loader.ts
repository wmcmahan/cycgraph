/**
 * Ad-hoc scenario loading
 *
 * Lifts a file into the {@link Scenario} contract so every playground verb
 * works on graphs that were never registered. A TS/JS module is the author's
 * code: its default export must be a `scenario({...})` value, and inline
 * agents, tools, and children thread exactly as they do for registry
 * scenarios. Bundle JSON is data: the bundle is embedded as a one-node
 * facade graph via `subgraph(bundle, ...)`, which folds its agents and
 * child-graph closure into the stashes the run path walks and enforces the
 * manifest's capability ceiling.
 *
 * @module scenarios/loader
 */

import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { graph, parseBundle, subgraph } from '@cycgraph/orchestrator';
import type { GraphBundle } from '@cycgraph/orchestrator';
import type { Scenario } from './types.js';


let tsxRegistered = false;

/**
 * Import a user module. The first TypeScript file registers tsx's loader
 * process-wide, then every file imports natively — through one shared
 * module cache, which is load-bearing: the authoring facade keys inline
 * agents and tools on module-instance WeakMaps, and a scoped loader would
 * hand the user's graph a second orchestrator instance whose stashes the
 * studio cannot see. Either way the file resolves its own dependencies
 * from its own location.
 */
export async function importModule(abs: string): Promise<Record<string, unknown>> {
  if (/\.(ts|mts)$/.test(abs) && !tsxRegistered) {
    const { register } = await import('tsx/esm/api');
    register();
    tsxRegistered = true;
  }
  return await import(pathToFileURL(abs).href) as Record<string, unknown>;
}

/** Whether a CLI argument names a scenario file rather than a registry id. */
export function looksLikeScenarioFile(arg: string): boolean {
  return arg.startsWith('.') || arg.includes('/') || /\.(ts|mts|js|mjs|json)$/.test(arg);
}

/** A loaded file did not yield something the playground can run. */
export class ScenarioLoadError extends Error {
  constructor(path: string, reason: string) {
    super(`Cannot load a scenario from '${path}': ${reason}`);
    this.name = 'ScenarioLoadError';
  }
}

function isScenarioShaped(value: unknown): value is Scenario {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<Scenario>;
  return typeof candidate.id === 'string'
    && typeof candidate.build === 'function'
    && typeof (candidate.params as z.ZodTypeAny | undefined)?.parse === 'function';
}

/** Load a scenario from a TS/JS module or a bundle JSON file. */
export async function loadScenarioFile(path: string): Promise<Scenario> {
  const abs = isAbsolute(path) ? path : resolve(process.cwd(), path);

  if (abs.endsWith('.json')) {
    let bundle: GraphBundle;
    try {
      bundle = parseBundle(JSON.parse(await readFile(abs, 'utf8')));
    } catch (err) {
      throw new ScenarioLoadError(path, err instanceof Error ? err.message : String(err));
    }
    return bundleScenario(bundle, path);
  }

  let loaded: Record<string, unknown>;
  try {
    loaded = await importModule(abs);
  } catch (err) {
    throw new ScenarioLoadError(path, err instanceof Error ? err.message : String(err));
  }
  const candidate = loaded.default ?? loaded.scenario;
  if (!isScenarioShaped(candidate)) {
    throw new ScenarioLoadError(path,
      'the default export is not a scenario — export an object with { id, title, covers, requires, params (a zod schema), build }');
  }
  return { ...candidate, sourcePath: abs };
}

/** Filesystem- and CLI-safe id derived from a bundle's manifest name. */
function bundleId(name: string, path: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : basename(path, '.json');
}

/**
 * Lift a parsed bundle into a Scenario.
 *
 * Declared manifest inputs become string params, seeded into parent memory
 * and mapped through to the child under the same key; declared outputs map
 * back out unchanged. The wrapper refuses a bundle whose manifest requires
 * host tools, because a JSON file cannot carry their implementations —
 * a TS module scenario is the vehicle for those.
 */
export function bundleScenario(bundle: GraphBundle, path: string): Scenario {
  const manifest = bundle.manifest;
  if (manifest.requires.tools.length > 0) {
    const names = manifest.requires.tools.map((t) => t.name).join(', ');
    throw new ScenarioLoadError(path,
      `the bundle requires host tools (${names}) — supply them from a TS module scenario instead`);
  }

  const inputKeys = Object.keys(manifest.inputs);
  const paramFields: Record<string, z.ZodTypeAny> = {
    goal: z.string().default(manifest.description ?? manifest.name)
      .describe('Workflow goal for the run'),
  };
  for (const key of inputKeys) {
    const decl = manifest.inputs[key]!;
    const base = z.string().describe(decl.description ?? `Seeded under '${key}'`);
    paramFields[key] = decl.required ? base : base.default('');
  }

  return {
    id: bundleId(manifest.name, path),
    title: manifest.description ?? `${manifest.name}@${manifest.version} (bundle)`,
    covers: ['external', 'bundle'],
    requires: bundle.agents.length > 0 ? ['model'] : [],
    params: z.object(paramFields),
    build: async (p: Record<string, string>) => {
      const seeded = Object.fromEntries(inputKeys
        .filter((key) => p[key] !== undefined && p[key] !== '')
        .map((key) => [key, p[key]]));
      const mapping = Object.fromEntries(Object.keys(seeded).map((key) => [key, key]));
      const outputs = Object.fromEntries(Object.keys(manifest.outputs).map((key) => [key, key]));

      const main = subgraph(bundle, {
        id: 'main',
        reads: Object.keys(seeded),
        ...(Object.keys(mapping).length > 0 ? { inputs: mapping } : {}),
        ...(Object.keys(outputs).length > 0 ? { outputs } : {}),
      });

      return {
        graph: graph({
          name: manifest.name,
          description: manifest.description ?? '',
          nodes: [main],
        }),
        input: {
          goal: p.goal ?? manifest.name,
          ...(Object.keys(seeded).length > 0 ? { memory: seeded } : {}),
        },
        runner: {},
      };
    },
  } as Scenario;
}
