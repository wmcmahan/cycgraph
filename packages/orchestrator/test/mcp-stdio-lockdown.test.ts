import { describe, it, expect, afterEach } from 'vitest';
import { MCPServerEntrySchema, isStdioMcpDisabled } from '../src/tools/schema.js';

const stdioEntry = {
  id: 'srv-stdio',
  name: 'Stdio Server',
  transport: { type: 'stdio', command: 'npx', args: ['-y', 'some-pkg'] },
};
const httpEntry = {
  id: 'srv-http',
  name: 'HTTP Server',
  transport: { type: 'http', url: 'https://example.com/mcp' },
};

describe('stdio MCP lockdown (MCP_STDIO_DISABLED)', () => {
  afterEach(() => {
    delete process.env.MCP_STDIO_DISABLED;
  });

  it('stdio is allowed by default (single-tenant / OSS)', () => {
    expect(isStdioMcpDisabled()).toBe(false);
    expect(MCPServerEntrySchema.safeParse(stdioEntry).success).toBe(true);
  });

  it('stdio is rejected at the registry boundary when disabled', () => {
    process.env.MCP_STDIO_DISABLED = 'true';
    expect(isStdioMcpDisabled()).toBe(true);
    const result = MCPServerEntrySchema.safeParse(stdioEntry);
    expect(result.success).toBe(false);
  });

  it('http/sse transports still work when stdio is disabled', () => {
    process.env.MCP_STDIO_DISABLED = 'true';
    expect(MCPServerEntrySchema.safeParse(httpEntry).success).toBe(true);
  });
});
