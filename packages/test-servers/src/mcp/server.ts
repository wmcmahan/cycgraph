/**
 * MCP scenario server
 *
 * An MCP server exposing deterministic tools, so MCP integration can be
 * exercised without a third-party server or a spawned stdio process.
 * For testing McpClient integration.
 *
 * @module mcp/server
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import express, { type Express } from 'express';

/** Names the scenario tools expose, for the index route and docs. */
export const MCP_TOOLS = [
  { name: 'echo', description: 'Returns its argument as text.' },
  { name: 'lookup_record', description: 'Returns a fixed structured record as JSON text.' },
  { name: 'slow', description: 'Sleeps before returning. Exercises per-tool timeouts.' },
  { name: 'always_fails', description: 'Always returns a tool error. Exercises failure handling.' },
];

/** Build the MCP server with the scenario tools registered. */
export function createMCPServer(): McpServer {
  const server = new McpServer({ name: 'cycgraph-test-mcp', version: '0.0.0' });

  server.registerTool(
    'echo',
    {
      description: 'Returns its argument as text.',
      inputSchema: { value: z.string().describe('Text to echo back') },
    },
    async ({ value }) => ({ content: [{ type: 'text', text: value }] }),
  );

  server.registerTool(
    'lookup_record',
    {
      description: 'Returns a fixed structured record as JSON text.',
      inputSchema: { id: z.string().describe('Record id') },
    },
    async ({ id }) => ({
      content: [{ type: 'text', text: JSON.stringify({ id, status: 'active', score: 0.91 }) }],
    }),
  );

  server.registerTool(
    'slow',
    {
      description: 'Sleeps before returning. Exercises per-tool timeouts.',
      inputSchema: { ms: z.number().describe('Milliseconds to sleep') },
    },
    async ({ ms }) => {
      const bounded = Math.min(Math.max(ms, 0), 30_000);
      await new Promise((resolve) => setTimeout(resolve, bounded));
      return { content: [{ type: 'text', text: `slept ${bounded}ms` }] };
    },
  );

  server.registerTool(
    'always_fails',
    { description: 'Always returns a tool error. Exercises failure handling.', inputSchema: {} },
    async () => ({ content: [{ type: 'text', text: 'this tool always fails' }], isError: true }),
  );

  return server;
}

/**
 * Wrap the MCP server in an Express app at `/mcp`.
 *
 * Stateless mode: a fresh transport per request, so no session state leaks
 * between tests and a test can never fail because a previous one left the
 * server mid-conversation.
 */
export function createMCPScenarioServer(): Express {
  const app = express();
  app.use(express.json({ limit: '5mb' }));

  app.get('/', (_req, res) => {
    res.json({ protocol: 'mcp', endpoint: '/mcp', tools: MCP_TOOLS });
  });

  app.post('/mcp', async (req, res) => {
    const server = createMCPServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  return app;
}
