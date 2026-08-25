/**
 * Stack
 *
 * What infrastructure is reachable, and what a scenario gets handed.
 *
 * The playground starts nothing. `docker-compose` owns Postgres, Jaeger, and
 * the scenario servers, and Ollama is a host service. So this probes rather
 * than provisions: connect, report, and name the command that fixes a gap.
 *
 * A requested feature that is unreachable stays a gap. It never falls back to
 * a substitute, because a durability scenario that quietly ran in memory would
 * report success while proving nothing.
 *
 * @module stack
 */

import { Socket } from 'node:net';
import {
  InMemoryEventLogWriter,
  InMemoryPersistenceProvider,
  createProviderRegistry,
  initTracing,
  shutdownTracing,
  registerOllamaProvider,
  type A2AServerRegistry,
  type EventLogWriter,
  type MCPServerRegistry,
  type PersistenceProvider,
  type ProviderRegistry,
} from '@cycgraph/orchestrator';
import { InMemoryMemoryIndex, InMemoryMemoryStore, InMemoryOutcomeLedger } from '@cycgraph/memory';
import { createOpenAI } from '@ai-sdk/openai';
import { createMemoryStack, type MemoryStack } from './memory.js';
import { registerA2AScenarios, registerMCPScenarios } from './servers.js';

/** A capability a scenario can require. */
export type StackFeature = 'model' | 'postgres' | 'jaeger' | 'a2a' | 'mcp' | 'memory';

/** Every feature, in the order the CLI reports them. */
export const STACK_FEATURES: readonly StackFeature[] = [
  'model', 'postgres', 'jaeger', 'a2a', 'mcp', 'memory',
];

/** Where each dependency lives, and which ones to bother probing. */
export interface StackConfig {
  postgres: boolean;
  jaeger: boolean;
  servers: boolean;
  memory: boolean;
  /** Model id every agent resolves through. An Ollama tag runs free. */
  model: string;
  /** Tenant Postgres-backed runs open their context against. */
  tenant: string;
  /** Root for run artifact directories. */
  artifactRoot: string;
  /** Repository the apply rung writes to, when a config names one. */
  applyRepo?: string;
  endpoints: {
    postgres: string;
    otlp: string;
    a2a: string;
    mcp: string;
    ollama: string;
  };
}

/** Why a feature is unavailable, and what fixes it. */
export interface FeatureGap {
  feature: StackFeature;
  reason: string;
}

/**
 * What a scenario's `build()` receives.
 *
 * The agent registry is deliberately absent: it is per-run, minted in
 * `executeScenario`, so two scenarios in one sweep cannot overwrite each
 * other's agents. Only connection-backed resources live here.
 *
 * Optional fields are present exactly when their feature is available, which
 * is why a scenario declares `requires` — having done so, it can read them
 * without a guard.
 */
export interface Stack {
  config: StackConfig;
  available: ReadonlySet<StackFeature>;
  gaps: readonly FeatureGap[];
  persistence: PersistenceProvider;
  eventLog: EventLogWriter;
  a2aRegistry?: A2AServerRegistry;
  mcpRegistry?: MCPServerRegistry;
  memory?: MemoryStack;
  /**
   * Flush pending spans and release the Postgres pool.
   *
   * Not the process supervision this module deliberately avoids: both are
   * in-process handles, and Node will not exit while the pool is open.
   */
  close(): Promise<void>;
}

/** Default artifact root, relative to wherever the CLI was invoked. */
export const DEFAULT_ARTIFACT_ROOT = '.playground';

/** Config used when no flags select otherwise. */
export function defaultStackConfig(): StackConfig {
  return {
    postgres: true,
    jaeger: true,
    servers: true,
    memory: true,
    model: process.env['CYCGRAPH_MODEL'] ?? 'qwen2.5:7b',
    tenant: process.env['PLAYGROUND_TENANT'] ?? 'seed',
    artifactRoot: process.env['PLAYGROUND_ARTIFACTS'] ?? DEFAULT_ARTIFACT_ROOT,
    endpoints: {
      postgres: process.env['DATABASE_URL'] ?? 'postgresql://postgres:postgres@localhost:5433/mcai',
      otlp: process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? 'http://localhost:4318',
      // Same variable the gated a2a composition suite reads.
      a2a: process.env['A2A_SCENARIO_SERVER'] ?? 'http://127.0.0.1:4001',
      mcp: process.env['MCP_SCENARIO_SERVER'] ?? 'http://127.0.0.1:4002',
      ollama: process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434',
    },
  };
}

// ─── Model resolution ───────────────────────────────────────────────

/** Whether a model id names a local Ollama tag rather than a hosted model. */
export function isLocalModel(model: string): boolean {
  return !/^(claude|gpt)/i.test(model);
}

/** Provider matching the configured model. */
export function providerFor(model: string): string {
  if (isLocalModel(model)) return 'ollama';
  return /^gpt/i.test(model) ? 'openai' : 'anthropic';
}

/**
 * A run-scoped provider registry with Ollama wired when the model is local.
 *
 * Ollama speaks the OpenAI-compatible API, so a client pointed at the local
 * server is the whole adapter. Hosted models resolve through the built-ins.
 */
export function providersFor(model: string, baseURL: string): ProviderRegistry | undefined {
  if (!isLocalModel(model)) return undefined;

  const providers = createProviderRegistry();
  registerOllamaProvider(providers, () => {
    const provider = createOpenAI({ baseURL: `${baseURL}/v1`, apiKey: 'ollama' });
    return (modelId) => provider.chat(modelId);
  });
  return providers;
}

// ─── Probing ────────────────────────────────────────────────────────

/** Whether a TCP port accepts a connection. The cheapest honest liveness test. */
async function reachable(host: string, port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    const done = (result: boolean): void => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

/** Host and port from a URL or a Postgres connection string. */
function endpointOf(raw: string, fallbackPort: number): { host: string; port: number } {
  try {
    const url = new URL(raw);
    return {
      host: url.hostname,
      port: url.port ? Number(url.port) : fallbackPort,
    };
  } catch {
    return { host: '127.0.0.1', port: fallbackPort };
  }
}

const COMPOSE_UP = 'run `docker-compose up -d`';
const COMPOSE_PLAYGROUND = 'run `docker-compose --profile playground up -d`';

/** Probe one feature. Returns `null` when it is available. */
async function probe(feature: StackFeature, config: StackConfig): Promise<string | null> {
  const { endpoints } = config;

  switch (feature) {
    case 'model': {
      if (!isLocalModel(config.model)) {
        const key = /^gpt/i.test(config.model) ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
        return process.env[key] ? null : `${key} is not set`;
      }
      const { host, port } = endpointOf(endpoints.ollama, 11434);
      return (await reachable(host, port))
        ? null
        : `no Ollama at ${endpoints.ollama} — start \`ollama serve\``;
    }

    case 'postgres': {
      const { host, port } = endpointOf(endpoints.postgres, 5433);
      return (await reachable(host, port))
        ? null
        : `unreachable at ${host}:${port} — ${COMPOSE_UP}`;
    }

    case 'jaeger': {
      const { host, port } = endpointOf(endpoints.otlp, 4318);
      return (await reachable(host, port))
        ? null
        : `no OTLP collector at ${endpoints.otlp} — ${COMPOSE_UP}`;
    }

    case 'a2a': {
      const { host, port } = endpointOf(endpoints.a2a, 4001);
      return (await reachable(host, port))
        ? null
        : `no scenario server at ${endpoints.a2a} — ${COMPOSE_PLAYGROUND}`;
    }

    case 'mcp': {
      const { host, port } = endpointOf(endpoints.mcp, 4002);
      return (await reachable(host, port))
        ? null
        : `no scenario server at ${endpoints.mcp} — ${COMPOSE_PLAYGROUND}`;
    }

    case 'memory':
      // Always satisfiable: Postgres-backed when it is up, in-memory
      // otherwise. Unlike the others, nothing external has to be running.
      return null;
  }
}

/** Which features the config asks for at all. */
function requested(config: StackConfig): StackFeature[] {
  return STACK_FEATURES.filter((feature) => {
    switch (feature) {
      case 'model': return true;
      case 'postgres': return config.postgres;
      case 'jaeger': return config.jaeger;
      case 'a2a':
      case 'mcp': return config.servers;
      case 'memory': return config.memory;
    }
  });
}

/**
 * Probe the infrastructure and report what is there.
 *
 * Probes everything the config asks for, not just what a scenario requires.
 * Persistence and tracing benefit every run, so narrowing to a scenario's
 * `requires` would leave a scenario that declares nothing silently running
 * without durable history while a database sat there unused. The probes are
 * parallel TCP connects, so the difference is not worth a behaviour split.
 *
 * `requires` still gates: it decides whether a scenario may run at all.
 */
export async function resolveStack(config: StackConfig): Promise<Stack> {
  const results = await Promise.all(
    requested(config).map(async (feature) => [feature, await probe(feature, config)] as const),
  );

  const available = new Set<StackFeature>();
  const gaps: FeatureGap[] = [];
  for (const [feature, reason] of results) {
    if (reason === null) available.add(feature);
    else gaps.push({ feature, reason });
  }

  // Tracing must be initialised before any traced code runs, and reads the
  // endpoint from the environment rather than an argument.
  if (available.has('jaeger')) {
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ??= config.endpoints.otlp;
    await initTracing('cycgraph-playground');
  }

  const backing = available.has('postgres')
    ? await postgresBacking(config)
    : memoryBacking();

  return {
    config,
    available,
    gaps,
    ...backing,
    ...(available.has('a2a')
      ? { a2aRegistry: await registerA2AScenarios(config.endpoints.a2a) }
      : {}),
    ...(available.has('mcp')
      ? { mcpRegistry: await registerMCPScenarios(config.endpoints.mcp) }
      : {}),
  };
}

/** Connection-backed resources, and how to release them. */
type Backing = Pick<Stack, 'persistence' | 'eventLog' | 'memory' | 'close'>;

/** Everything in process. No durability, no cross-run history. */
function memoryBacking(): Backing {
  const store = new InMemoryMemoryStore();
  const index = new InMemoryMemoryIndex({ silenceScaleWarning: true });

  return {
    persistence: new InMemoryPersistenceProvider(),
    eventLog: new InMemoryEventLogWriter(),
    memory: createMemoryStack(store, index, new InMemoryOutcomeLedger()),
    close: shutdownTracing,
  };
}

/**
 * Drizzle-backed resources, scoped to one tenant.
 *
 * `createTenantScope` builds every adapter against the same tenant in one
 * call, so persistence, the event log, memory, and the outcome ledger cannot
 * drift onto different tenants.
 *
 * Imported dynamically so the playground runs without a database driver
 * loaded when Postgres is not in play.
 */
async function postgresBacking(config: StackConfig): Promise<Backing> {
  const { createTenantScope, closeDb, SEED_TENANT_ID } = await import('@cycgraph/orchestrator-postgres');

  process.env['DATABASE_URL'] ??= config.endpoints.postgres;
  const tenantId = config.tenant === 'seed' ? SEED_TENANT_ID : config.tenant;
  const scope = createTenantScope({ tenant_id: tenantId });

  return {
    persistence: scope.persistence,
    eventLog: scope.eventLog,
    memory: createMemoryStack(scope.memoryStore, scope.memoryIndex, scope.outcomeLedger),
    close: async () => {
      await shutdownTracing();
      await closeDb();
    },
  };
}


/** Requirements this stack cannot satisfy. */
export function unmetRequirements(
  stack: Stack,
  requires: readonly StackFeature[],
): StackFeature[] {
  return requires.filter((feature) => !stack.available.has(feature));
}
