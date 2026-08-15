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
  { name: 'flaky', description: 'Fails its first N calls, then succeeds. Exercises retry and recovery.' },
];

/**
 * Call counts for {@link MCP_TOOLS} entries that behave differently over time.
 *
 * Process-wide and never reset: a client testing retry wants the second call
 * to differ from the first, which is only true if the server remembers.
 */
const callCounts = new Map<string, number>();

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
    'flaky',
    {
      description: 'Fails its first N calls, then succeeds.',
      inputSchema: {
        fail_first: z.number().describe('How many initial calls should fail'),
        key: z.string().optional().describe('Independent counter, so callers do not share a window'),
      },
    },
    async ({ fail_first, key }) => {
      const counterKey = `flaky:${key ?? 'default'}`;
      const seen = (callCounts.get(counterKey) ?? 0) + 1;
      callCounts.set(counterKey, seen);

      if (seen <= fail_first) {
        return {
          content: [{ type: 'text', text: `call ${seen} of ${fail_first} failing on purpose` }],
          isError: true,
        };
      }
      return { content: [{ type: 'text', text: JSON.stringify({ call: seen, recovered: true }) }] };
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

  // Streamable HTTP clients probe GET for a server-initiated SSE stream. This
  // server has none, and 405 is how the transport is told so: a 404 reads as
  // the wrong endpoint and surfaces on the client as an uncaught transport
  // error on an otherwise healthy connection.
  app.get('/mcp', (_req, res) => {
    res.status(405).set('allow', 'POST').json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'This server does not offer an SSE stream; POST only.' },
      id: null,
    });
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
