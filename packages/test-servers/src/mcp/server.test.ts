import { afterEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { boundedSleepMs, createMCPScenarioServer } from './server.js';

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

let httpServer: Server | undefined;
let client: Client | undefined;

async function connect(): Promise<Client> {
  const listening = createMCPScenarioServer().listen(0, '127.0.0.1');
  await once(listening, 'listening');
  httpServer = listening;

  const { port } = listening.address() as AddressInfo;
  const connected = new Client({ name: 'test-client', version: '0.0.0' });
  await connected.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  client = connected;
  return connected;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const connected = client ?? (await connect());
  return (await connected.callTool({ name, arguments: args })) as unknown as ToolResult;
}

afterEach(async () => {
  await client?.close();
  client = undefined;
  httpServer?.close();
  httpServer = undefined;
});

describe('flaky tool', () => {
  it('fails exactly the first fail_first calls and succeeds after them', async () => {
    await connect();

    const first = await callTool('flaky', { fail_first: 2, key: 'boundary' });
    const second = await callTool('flaky', { fail_first: 2, key: 'boundary' });
    const third = await callTool('flaky', { fail_first: 2, key: 'boundary' });

    expect(first.isError).toBe(true);
    expect(second.isError).toBe(true);
    expect(third.isError ?? false).toBe(false);
    expect(JSON.parse(third.content[0]!.text)).toEqual({ call: 3, recovered: true });
  });

  it('succeeds on the first call when no calls are set to fail', async () => {
    await connect();

    const result = await callTool('flaky', { fail_first: 0, key: 'no-failures' });

    expect(result.isError ?? false).toBe(false);
    expect(JSON.parse(result.content[0]!.text)).toEqual({ call: 1, recovered: true });
  });

  it('counts each key independently', async () => {
    await connect();

    await callTool('flaky', { fail_first: 1, key: 'left' });
    const leftSecond = await callTool('flaky', { fail_first: 1, key: 'left' });
    const rightFirst = await callTool('flaky', { fail_first: 1, key: 'right' });

    expect(leftSecond.isError ?? false).toBe(false);
    expect(rightFirst.isError).toBe(true);
  });
});

describe('slow tool', () => {
  it('clamps a negative duration to no sleep at all', () => {
    expect(boundedSleepMs(-1)).toBe(0);
  });

  it('honors a duration inside the supported range', () => {
    expect(boundedSleepMs(250)).toBe(250);
  });

  it('clamps a duration beyond the ceiling to thirty seconds', () => {
    expect(boundedSleepMs(60_000)).toBe(30_000);
  });

  it('reports the clamped duration rather than the requested one', async () => {
    await connect();

    const result = await callTool('slow', { ms: -50 });

    expect(result.content[0]!.text).toBe('slept 0ms');
  });
});
