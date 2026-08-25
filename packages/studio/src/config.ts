/**
 * cycgraph.config — the studio's standing catalog and defaults
 *
 * A user project declares its workflows and environment once, next to its
 * code: which graph modules the picker serves, which model and database the
 * stack resolves, and which repository the apply rung writes to. The studio
 * bin loads it from the working directory at startup; every CLI flag still
 * wins over it, so a config is a set of defaults, never a cage.
 *
 * Supported files, first match wins: `cycgraph.config.ts`, `.mts`, `.mjs`,
 * `.js` (default-exporting the config object), or `.json`. Graph paths
 * resolve relative to the config file, so the config works from any cwd
 * inside the project.
 *
 * @module config
 */

import { access, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { catalogOf, type Catalog } from './scenarios/catalog.js';
import { importModule, loadScenarioFile } from './scenarios/loader.js';
import type { StackConfig } from './stack/index.js';

/** What a cycgraph.config file may declare. */
export const StudioConfigSchema = z.object({
  /** Graph modules or bundle files the catalog serves, config-relative. */
  graphs: z.array(z.string()).default([]),
  /** Model id every agent resolves through. */
  model: z.string().optional(),
  /** Postgres connection string. Applied as DATABASE_URL unless already set. */
  database: z.string().optional(),
  /** Tenant Postgres-backed runs open against. */
  tenant: z.string().optional(),
  /** Root for run artifact directories, config-relative. */
  artifactRoot: z.string().optional(),
  postgres: z.boolean().optional(),
  jaeger: z.boolean().optional(),
  servers: z.boolean().optional(),
  memory: z.boolean().optional(),
  /** Repository the apply rung clones and commits to, config-relative. */
  repo: z.string().optional(),
});

export type StudioConfig = z.infer<typeof StudioConfigSchema>;

/** A parsed config plus where it came from, for resolving relative paths. */
export interface LoadedStudioConfig {
  config: StudioConfig;
  /** Directory the config file sits in. */
  dir: string;
  path: string;
}

/** A config file that exists but cannot be used. */
export class StudioConfigError extends Error {
  constructor(path: string, reason: string) {
    super(`Cannot use '${path}': ${reason}`);
    this.name = 'StudioConfigError';
  }
}

const CONFIG_NAMES = [
  'cycgraph.config.ts',
  'cycgraph.config.mts',
  'cycgraph.config.mjs',
  'cycgraph.config.js',
  'cycgraph.config.json',
];

/**
 * Find and parse the config in `cwd`. Absent config is not an error — the
 * studio runs bare — but a config that exists and fails to parse is.
 */
export async function loadStudioConfig(cwd: string): Promise<LoadedStudioConfig | undefined> {
  for (const name of CONFIG_NAMES) {
    const path = join(cwd, name);
    try {
      await access(path);
    } catch {
      continue;
    }

    let raw: unknown;
    try {
      raw = name.endsWith('.json')
        ? JSON.parse(await readFile(path, 'utf8'))
        : (await importModule(path)).default;
    } catch (err) {
      throw new StudioConfigError(path, err instanceof Error ? err.message : String(err));
    }

    const parsed = StudioConfigSchema.safeParse(raw);
    if (!parsed.success) {
      throw new StudioConfigError(path, parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; '));
    }
    return { config: parsed.data, dir: dirname(path), path };
  }
  return undefined;
}

/** Load every declared graph into a catalog, config-relative. */
export async function catalogFromConfig(loaded: LoadedStudioConfig): Promise<Catalog> {
  const scenarios = [];
  for (const entry of loaded.config.graphs) {
    const path = isAbsolute(entry) ? entry : resolve(loaded.dir, entry);
    scenarios.push(await loadScenarioFile(path));
  }
  return catalogOf(scenarios);
}

/** The stack defaults a config implies. CLI flags still override these. */
export function stackDefaultsFrom(loaded: LoadedStudioConfig): Partial<StackConfig> {
  const { config, dir } = loaded;
  return {
    ...(config.model !== undefined ? { model: config.model } : {}),
    ...(config.tenant !== undefined ? { tenant: config.tenant } : {}),
    ...(config.artifactRoot !== undefined
      ? { artifactRoot: isAbsolute(config.artifactRoot) ? config.artifactRoot : resolve(dir, config.artifactRoot) }
      : {}),
    ...(config.postgres !== undefined ? { postgres: config.postgres } : {}),
    ...(config.jaeger !== undefined ? { jaeger: config.jaeger } : {}),
    ...(config.servers !== undefined ? { servers: config.servers } : {}),
    ...(config.memory !== undefined ? { memory: config.memory } : {}),
    ...(config.repo !== undefined
      ? { applyRepo: isAbsolute(config.repo) ? config.repo : resolve(dir, config.repo) }
      : {}),
  };
}
