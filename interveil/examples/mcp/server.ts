/**
 * A small MCP server (official SDK, Streamable HTTP) with file and shell tools.
 * The tools only pretend to act, so the example is safe to run.
 *
 *   npx ts-node -T examples/mcp/server.ts        # listens on http://localhost:8080/mcp
 */
import express from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

type TextResult = { content: Array<{ type: 'text'; text: string }> };
const text = (t: string): TextResult => ({ content: [{ type: 'text', text: t }] });

function buildServer(): McpServer {
  const server = new McpServer({ name: 'workspace-tools', version: '1.0.0' });
  // Typed narrowly: the SDK's generic zod inference trips TS2589 ("excessively deep").
  const register = server.registerTool.bind(server) as unknown as
    <A>(name: string, config: { description: string; inputSchema: object }, cb: (args: A) => Promise<TextResult>) => void;

  register<{ path: string }>('read_file', { description: 'Read a file', inputSchema: { path: z.string() } },
    async ({ path }) => { console.log(`[mcp-server] read_file ${path}`); return text(`(contents of ${path})`); });
  register<{ path: string }>('delete_path', { description: 'Delete a file or directory', inputSchema: { path: z.string() } },
    async ({ path }) => { console.log(`[mcp-server] delete_path ${path}`); return text(`deleted ${path}`); });
  register<{ command: string }>('run_command', { description: 'Run a shell command', inputSchema: { command: z.string() } },
    async ({ command }) => { console.log(`[mcp-server] run_command ${command}`); return text(`ran: ${command}`); });
  return server;
}

const app = express();
app.use(express.json());
app.post('/mcp', async (req, res) => {
  // Stateless mode: a fresh server and transport per request.
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const port = Number(process.env.PORT ?? 8080);
app.listen(port, '127.0.0.1', () => console.log(`[mcp-server] listening on http://localhost:${port}/mcp`));
