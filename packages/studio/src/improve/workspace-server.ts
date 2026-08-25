/**
 * The workspace MCP server: `@cycgraph/tools` workspace tools over HTTP
 *
 * A thin transport. The tools themselves — read, search, edit, the jail, the
 * unique-match refusal — live in `@cycgraph/tools` (`workspace/`), where any
 * runner can also register them directly as custom tools. This wrapper
 * exists for callers that reach tools over MCP, which is how the playground's
 * editor agent gets its hands on a disposable clone.
 *
 * @module improve/workspace-server
 */

import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import {
  editFileParameters,
  editFileTool,
  readFileParameters,
  readFileTool,
  searchParameters,
  searchTool,
} from '@cycgraph/tools/workspace';
import type { DefinedTool } from '@cycgraph/orchestrator';
import type { z } from 'zod';

/** A running workspace server and how to reach and stop it. */
export interface WorkspaceServer {
  url: string;
  close(): Promise<void>;
}

/**
 * Build the MCP surface over one root.
 *
 * Each entry pairs the canonical tool with its Zod schema, because a
 * `DefinedTool` carries JSON-schema parameters while the MCP SDK registers
 * from Zod shapes — the schemas are exported beside the factories precisely
 * so a transport never has to restate them.
 */
function buildServer(root: string): McpServer {
  const server = new McpServer({ name: 'cycgraph-workspace', version: '0.0.0' });

  const surface: Array<{ tool: DefinedTool; schema: z.ZodObject<z.ZodRawShape> }> = [
    { tool: searchTool({ root }), schema: searchParameters },
    { tool: readFileTool({ root }), schema: readFileParameters },
    { tool: editFileTool({ root }), schema: editFileParameters },
  ];

  for (const { tool, schema } of surface) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: schema.shape },
      async (args: Record<string, unknown>) => {
        try {
          const result = await tool.execute(args);
          return { content: [{ type: 'text' as const, text: String(result) }] };
        } catch (err) {
          return { content: [{ type: 'text' as const, text: `error: ${err instanceof Error ? err.message : String(err)}` }] };
        }
      },
    );
  }

  return server;
}

/**
 * Serve the workspace tools over HTTP on an ephemeral port.
 *
 * HTTP rather than stdio because it is the convention every other local
 * server here follows, and because the caller owns the lifecycle either way:
 * one apply, one server, one close.
 */
export async function startWorkspaceServer(root: string): Promise<WorkspaceServer> {
  const app = express();
  app.use(express.json());
  // Streamable HTTP clients probe GET for a server-initiated SSE stream.
  // This server has none, and 405 is how the transport is told so — a 404
  // surfaces as an uncaught transport error on a healthy connection.
  app.get('/mcp', (_req, res) => {
    res.status(405).set('Allow', 'POST').end();
  });
  app.post('/mcp', async (req, res) => {
    const server = buildServer(root);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const httpServer = createServer(app);
  await new Promise<void>((ready) => httpServer.listen(0, '127.0.0.1', ready));
  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => new Promise((done) => httpServer.close(() => done())),
  };
}
