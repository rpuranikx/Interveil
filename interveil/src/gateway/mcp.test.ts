import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { AddressInfo } from 'net';
import express from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer } from '../server.js';
import { setPolicy } from '../policy/engine.js';
import { store } from '../store/memory.js';

// A real MCP server (official SDK, Streamable HTTP, stateless) that records which tools actually ran.
const ran: string[] = [];
type TextResult = { content: Array<{ type: 'text'; text: string }> };
function buildServer(): McpServer {
  const server = new McpServer({ name: 'files', version: '1.0.0' });
  // Typed narrowly: the SDK's generic zod inference trips TS2589 ("excessively deep").
  const register = server.registerTool.bind(server) as unknown as
    (name: string, config: { inputSchema: object }, cb: (args: { path: string }) => Promise<TextResult>) => void;
  register('read_file', { inputSchema: { path: z.string() } }, async ({ path }) => {
    ran.push(`read_file ${path}`);
    return { content: [{ type: 'text', text: `contents of ${path}` }] };
  });
  register('delete_path', { inputSchema: { path: z.string() } }, async ({ path }) => {
    ran.push(`delete_path ${path}`);
    return { content: [{ type: 'text', text: `deleted ${path}` }] };
  });
  return server;
}

let mcpHttp: http.Server;
let interveil: http.Server;
let proxyUrl = '';
const saved = process.env.MCP_SERVER_URL;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.post('/mcp', async (req, res) => {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  mcpHttp = app.listen(0, '127.0.0.1');
  await new Promise(r => mcpHttp.once('listening', r));
  process.env.MCP_SERVER_URL = `http://127.0.0.1:${(mcpHttp.address() as AddressInfo).port}/mcp`;

  const started = await startServer({ port: 0 });
  interveil = started.server;
  proxyUrl = `http://127.0.0.1:${started.port}/v1/mcp`;

  setPolicy({
    version: '1',
    agents: [{ id: 'files-agent', rules: [{ id: 'no-deletes-outside-tmp', action: 'block', condition: { tool: 'delete_path' } }] }],
  });
});

afterAll(() => {
  process.env.MCP_SERVER_URL = saved;
  mcpHttp.close();
  interveil.close();
});

async function connect(session: string): Promise<Client> {
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(proxyUrl), {
    requestInit: { headers: { 'x-interveil-agent-id': 'files-agent', 'x-interveil-session-id': session } },
  }));
  return client;
}

describe('MCP proxy with the official MCP SDK (Streamable HTTP)', () => {
  it('initializes and lists tools through Interveil', async () => {
    const client = await connect('mcp-list');
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name).sort()).toEqual(['delete_path', 'read_file']);
    await client.close();
  });

  it('forwards an allowed tool call and records call and result', async () => {
    const client = await connect('mcp-allowed');
    const result = await client.callTool({ name: 'read_file', arguments: { path: 'notes.txt' } });
    expect(result.content).toEqual([{ type: 'text', text: 'contents of notes.txt' }]);
    expect(ran).toContain('read_file notes.txt');

    const types = (await store.getEvents('mcp-allowed')).map(e => e.step_type);
    expect(types).toContain('TOOL_CALL');
    expect(types).toContain('TOOL_RESULT');
    await client.close();
  });

  it('blocks a disallowed tool call before the server runs it', async () => {
    const client = await connect('mcp-blocked');
    const result = await client.callTool({ name: 'delete_path', arguments: { path: '/etc' } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('no-deletes-outside-tmp');
    expect(ran.some(r => r.startsWith('delete_path'))).toBe(false);

    const violation = (await store.getEvents('mcp-blocked')).find(e => e.step_type === 'POLICY_VIOLATION');
    expect(violation?.metadata).toMatchObject({ rule_id: 'no-deletes-outside-tmp', enforced_at: 'mcp' });
    await client.close();
  });

  it('applies the command blocklist to MCP arguments', async () => {
    const client = await connect('mcp-blocklist');
    const result = await client.callTool({ name: 'read_file', arguments: { path: '/etc/shadow' } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('system-credentials');
    await client.close();
  });

  // Without an id the halt check was skipped, and some servers still run the call.
  it('refuses a tools/call without an id instead of forwarding it', async () => {
    const res = await fetch(proxyUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-interveil-agent-id': 'files-agent' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'read_file', arguments: { path: 'no-id.txt' } } }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32600);
    expect(ran).not.toContain('read_file no-id.txt');
  });
});
