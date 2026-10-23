# Interveil — MCP example

An MCP client reaches an MCP server through Interveil. The only change from a direct connection is the URL: `http://localhost:3000/v1/mcp` instead of the server's own. Interveil records every call and checks each `tools/call` against the policy and the command blocklist before forwarding it.

Uses the official [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) over Streamable HTTP. Run from the `interveil/` directory after `pnpm install && pnpm build` at the repo root, in three terminals:

```bash
npx ts-node -T examples/mcp/server.ts
```

```bash
node dist/cli.js serve --mcp-server http://localhost:8080/mcp --policy-file examples/policies/workspace-agent.yaml
```

```bash
npx ts-node -T examples/mcp/client.ts
```

Expected output from the client:

```
✓ allowed  read_file({"path":"README.md"})
✗ blocked  delete_path({"path":"./data"})
   [Interveil] Tool call blocked by policy: delete_path (policy rule "deletes-need-approval": Deleting files needs a human).
✗ blocked  run_command({"command":"rm -rf ./data && echo done"})
   [Interveil] Tool call blocked by policy: run_command (blocklist rule "rm-recursive": matches the built-in command blocklist).
```

The MCP server's own log shows that only `read_file` ran. Blocked calls come back as tool results with `isError: true`, so a model sees why its call failed. The session appears in the dashboard at http://localhost:3000.
