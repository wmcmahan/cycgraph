/**
 * Tenant-scope factory tests.
 *
 * Pure construction (no database) — `createTenantScope` / `createPlatformScope`
 * only `new` up adapters, so these assert the bundle is wired to the right
 * classes and threads the tenant/options through without opening a connection.
 */

import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTenantScope, createPlatformScope } from '../src/tenant-scope.js';
import { DrizzlePersistenceProvider } from '../src/drizzle-persistence.js';
import { DrizzleEventLogWriter } from '../src/drizzle-event-log.js';
import { DrizzleUsageRecorder } from '../src/drizzle-usage.js';
import { DrizzleAgentRegistry } from '../src/drizzle-agent-registry.js';
import { DrizzleMCPServerRegistry } from '../src/drizzle-mcp-registry.js';
import { DrizzleMemoryStore } from '../src/drizzle-memory-store.js';
import { DrizzleMemoryIndex } from '../src/drizzle-memory-index.js';
import { DrizzleOutcomeLedger } from '../src/drizzle-outcome-ledger.js';
import { DrizzleWorkflowQueue } from '../src/drizzle-queue.js';
import { DrizzleRetentionService } from '../src/drizzle-retention.js';

describe('createTenantScope', () => {
  it('exposes the passed tenant context on the bundle', () => {
    const tenant = { tenant_id: randomUUID() };

    const scope = createTenantScope(tenant);

    expect(scope.tenant).toBe(tenant);
  });

  it('wires every tenant-plane adapter to its Drizzle implementation', () => {
    const scope = createTenantScope({ tenant_id: randomUUID() });

    expect(scope.persistence).toBeInstanceOf(DrizzlePersistenceProvider);
    expect(scope.eventLog).toBeInstanceOf(DrizzleEventLogWriter);
    expect(scope.usage).toBeInstanceOf(DrizzleUsageRecorder);
    expect(scope.agents).toBeInstanceOf(DrizzleAgentRegistry);
    expect(scope.mcpServers).toBeInstanceOf(DrizzleMCPServerRegistry);
    expect(scope.memoryStore).toBeInstanceOf(DrizzleMemoryStore);
    expect(scope.memoryIndex).toBeInstanceOf(DrizzleMemoryIndex);
    expect(scope.outcomeLedger).toBeInstanceOf(DrizzleOutcomeLedger);
  });

  it('builds a bundle with no options supplied', () => {
    const scope = createTenantScope({ tenant_id: randomUUID() });

    expect(scope.persistence).toBeInstanceOf(DrizzlePersistenceProvider);
    expect(scope.eventLog).toBeInstanceOf(DrizzleEventLogWriter);
  });

  it('builds a bundle when a fencing claim is supplied', () => {
    const scope = createTenantScope(
      { tenant_id: randomUUID() },
      { fencing: { run_id: randomUUID(), epoch: 3 } },
    );

    expect(scope.persistence).toBeInstanceOf(DrizzlePersistenceProvider);
    expect(scope.eventLog).toBeInstanceOf(DrizzleEventLogWriter);
  });

  it('builds a bundle when a checkpoint retention window is supplied', () => {
    const scope = createTenantScope(
      { tenant_id: randomUUID() },
      { retainCheckpoints: 5 },
    );

    expect(scope.eventLog).toBeInstanceOf(DrizzleEventLogWriter);
  });

  it('builds distinct adapter instances per call', () => {
    const first = createTenantScope({ tenant_id: randomUUID() });
    const second = createTenantScope({ tenant_id: randomUUID() });

    expect(first.persistence).not.toBe(second.persistence);
  });
});

describe('createPlatformScope', () => {
  it('wires the queue to its Drizzle implementation', () => {
    const scope = createPlatformScope();

    expect(scope.queue).toBeInstanceOf(DrizzleWorkflowQueue);
  });

  it('wires the retention service to its Drizzle implementation', () => {
    const scope = createPlatformScope();

    expect(scope.retention).toBeInstanceOf(DrizzleRetentionService);
  });
});
