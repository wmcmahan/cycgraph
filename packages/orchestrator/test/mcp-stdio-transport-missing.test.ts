/**
 * connectToServer stdio guard — isolated module mock.
 *
 * When @ai-sdk/mcp/mcp-stdio is installed but does not export the stdio
 * transport class (a broken/partial install), the manager must fail the
 * connection with a clear error rather than crash. This file mocks the
 * subpath to omit the export so the guard in buildTransport() is exercised.
 */

import { describe, it, expect, vi } from 'vitest';
import { MCPConnectionManager } from '../src/mcp/connection-manager.js';
import { InMemoryMCPServerRegistry } from '../src/persistence/in-memory.js';

vi.mock('@ai-sdk/mcp', () => ({
  createMCPClient: vi.fn(async () => ({
    tools: vi.fn().mockResolvedValue({}),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('@ai-sdk/mcp/mcp-stdio', () => ({ Experimental_StdioMCPTransport: undefined }));

vi.mock('../src/observability/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

describe('MCPConnectionManager stdio transport guard', () => {
  it('throws a helpful error when the stdio transport export is missing', async () => {
    const registry = new InMemoryMCPServerRegistry();
    await registry.saveServer({
      id: 'stdio-broken',
      name: 'Broken Stdio',
      transport: { type: 'stdio', command: 'npx', args: ['-y', 'pkg'] },
      timeout_ms: 30_000,
      max_retries: 0,
    });
    const manager = new MCPConnectionManager(registry);

    await expect(manager.resolveTools([{ type: 'mcp', server_id: 'stdio-broken' }]))
      .rejects.toThrow(/@ai-sdk\/mcp\/mcp-stdio/);
  });
});
