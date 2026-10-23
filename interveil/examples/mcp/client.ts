/**
 * An MCP client that reaches the server through Interveil instead of directly.
 * The only change from a direct connection is the URL (plus an optional agent id header).
 *
 *   npx ts-node -T examples/mcp/client.ts
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const INTERVEIL_MCP = process.env.INTERVEIL_MCP_URL ?? 'http://localhost:3000/v1/mcp'; // was http://localhost:8080/mcp

async function main() {
  const client = new Client({ name: 'example-agent', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(INTERVEIL_MCP), {
    requestInit: { headers: { 'x-interveil-agent-id': 'workspace-agent' } },
  }));

  const { tools } = await client.listTools();
  console.log(`tools: ${tools.map(t => t.name).join(', ')}\n`);

  const calls: Array<[string, Record<string, unknown>]> = [
    ['read_file', { path: 'README.md' }],
    ['delete_path', { path: './data' }],
    ['run_command', { command: 'rm -rf ./data && echo done' }],
  ];
  for (const [name, args] of calls) {
    const result = await client.callTool({ name, arguments: args });
    const output = (result.content as Array<{ text?: string }>).map(c => c.text).join(' ');
    console.log(`${result.isError ? '✗ blocked' : '✓ allowed'}  ${name}(${JSON.stringify(args)})\n   ${output}\n`);
  }
  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
