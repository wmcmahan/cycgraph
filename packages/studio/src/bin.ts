#!/usr/bin/env node
/**
 * Studio entry: the CLI over the project's cycgraph.config.
 *
 * The config in the working directory names the catalog (graph modules and
 * bundles), the stack defaults, and the apply-target repository. Without
 * one the studio runs bare — ad-hoc files load by path (`run ./graph.ts`,
 * `serve --load …`) and external runs surface through the DB browser.
 *
 * @module bin
 */

import { catalogFromConfig, loadStudioConfig, stackDefaultsFrom } from './config.js';
import { catalogOf } from './scenarios/catalog.js';
import { runCliMain } from './cli/main.js';

// `npm run studio` executes with the package as cwd; npm records the
// directory the user invoked from in INIT_CWD, which is where their
// config and graphs live. A direct `tsx src/bin.ts` has no INIT_CWD.
const projectDir = process.env['INIT_CWD'] ?? process.cwd();
if (projectDir !== process.cwd()) process.chdir(projectDir);

const loaded = await loadStudioConfig(projectDir).catch((err: unknown) => {
  process.stderr.write(`\n  ${err instanceof Error ? err.message : String(err)}\n\n`);
  process.exit(1);
});

// The connection string must be in the environment before the stack reads
// its defaults; an explicit DATABASE_URL still wins over the config.
if (loaded?.config.database) process.env['DATABASE_URL'] ??= loaded.config.database;

runCliMain({
  catalog: loaded ? await catalogFromConfig(loaded) : catalogOf([]),
  ...(loaded ? { stackDefaults: stackDefaultsFrom(loaded) } : {}),
});
