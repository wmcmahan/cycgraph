/**
 * The CLI's shared substrate: the context every command receives, the
 * harness a host supplies, and the helpers commands lean on. Internal
 * commands and host-registered ones (the playground's `fork-check`,
 * `loop-check`) receive the same {@link CliContext}, so a command is one
 * kind of thing wherever it comes from.
 *
 * @module cli/context
 */

import { createInterface } from 'node:readline/promises';
import type { HumanResponse } from '@cycgraph/orchestrator';
import { loadHistory } from '../run/history.js';
import { improveTuneTargetFor } from '../improve/improve.js';
import type { Catalog } from '../scenarios/catalog.js';
import { loadScenarioFile, looksLikeScenarioFile } from '../scenarios/loader.js';
import type { Scenario } from '../scenarios/types.js';
import { defaultStackConfig, unmetRequirements, type Stack, type StackConfig } from '../stack/index.js';

/** What every command receives, host-registered or built in. */
export interface CliContext {
  args: string[];
  config: StackConfig;
  catalog: Catalog;
  /** Resolve a catalog id, a scenario file path, or the improve corpus. */
  requireScenario(id: string | undefined): Promise<Scenario>;
  /**
   * A workflow id the artifact readers accept: everything requireScenario
   * resolves, plus any workflow the artifact tree has recorded runs for —
   * imported external runs included, which no catalog lists.
   */
  resolveWorkflowId(arg: string): Promise<string>;
  /** Terminal prompt when a scenario scripts no answer. */
  promptForHuman(question: string): Promise<HumanResponse>;
  /** Terminal prompt at a ladder gate: yes walks on, anything else stops. */
  promptForGate(question: string): Promise<HumanResponse>;
}

/** What a host supplies: its workflows, and any commands of its own. */
export interface CliHarness {
  catalog: Catalog;
  commands?: Record<string, (ctx: CliContext) => Promise<void>>;
  /** Stack defaults (e.g. from a config file). Explicit flags still win. */
  stackDefaults?: Partial<StackConfig>;
}

/** Print the message and end the invocation. */
export function fail(message: string): never {
  process.stderr.write(`\n  ${message}\n\n`);
  process.exit(1);
}

/** Stack flags, stripped from argv before scenario flags are parsed. */
export function takeStackFlags(argv: string[], base: Partial<StackConfig> = {}): { config: StackConfig; rest: string[] } {
  const config = { ...defaultStackConfig(), ...base };
  const rest: string[] = [];

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    switch (token) {
      case '--no-postgres': config.postgres = false; continue;
      case '--no-jaeger': config.jaeger = false; continue;
      case '--no-servers': config.servers = false; continue;
      case '--no-memory': config.memory = false; continue;
      case '--model': config.model = argv[++index] ?? config.model; continue;
      case '--tenant': config.tenant = argv[++index] ?? config.tenant; continue;
      default:
        if (token !== undefined) rest.push(token);
    }
  }

  return { config, rest };
}

/** Refuse a scenario the current stack cannot run, naming what is missing. */
export function requireFeatures(stack: Stack, scenario: Scenario): void {
  const missing = unmetRequirements(stack, scenario.requires);
  if (missing.length === 0) return;
  const reasons = stack.gaps
    .filter((gap) => missing.includes(gap.feature))
    .map((gap) => `    ${gap.feature}: ${gap.reason}`)
    .join('\n');
  fail(`${scenario.id} cannot run.\n\n${reasons}`);
}

/**
 * The Jaeger UI origin implied by the OTLP endpoint.
 *
 * They are different ports on the same host in the compose file, and the UI
 * is what a person wants to open.
 */
export function jaegerUiBase(otlp: string): string {
  try {
    const url = new URL(otlp);
    return `${url.protocol}//${url.hostname}:16686`;
  } catch {
    return 'http://localhost:16686';
  }
}

async function promptForGate(question: string): Promise<HumanResponse> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`\n  ⏸ ${question}\n    approve? [y/N] › `);
    return /^y(es)?$/i.test(answer.trim()) ? { decision: 'approved' } : { decision: 'rejected' };
  } finally {
    rl.close();
  }
}

async function promptForHuman(question: string): Promise<HumanResponse> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`  ⏸ ${question}\n    › `);
    return answer.trim().length > 0
      ? { decision: 'edited', data: answer.trim() }
      : { decision: 'approved' };
  } finally {
    rl.close();
  }
}

/** Build the context one invocation's commands run against. */
export function commandContext(catalog: Catalog, config: StackConfig, args: string[]): CliContext {
  const requireScenario = async (id: string | undefined): Promise<Scenario> => {
    if (!id) fail('Name a scenario. The catalog listing names them.');
    // Improve sessions are a tunable corpus but not a catalog entry: the
    // pickers and fork-check must never sweep them, so the address resolves
    // here explicitly rather than by listing.
    if (id === 'improve') return improveTuneTargetFor(catalog);
    if (looksLikeScenarioFile(id)) {
      try {
        return await loadScenarioFile(id);
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
    }
    const scenario = catalog.find(id);
    if (!scenario) fail(`No scenario named "${id}". The catalog listing names them.`);
    return scenario;
  };

  const resolveWorkflowId = async (arg: string): Promise<string> => {
    if (arg === 'improve' || catalog.find(arg) || looksLikeScenarioFile(arg)) {
      return (await requireScenario(arg)).id;
    }
    const recorded = await loadHistory(config.artifactRoot, { scenarioId: arg, limit: 1 });
    if (recorded.length > 0) return arg;
    fail(`No scenario or recorded workflow named "${arg}".`);
  };

  return { args, config, catalog, requireScenario, resolveWorkflowId, promptForHuman, promptForGate };
}
