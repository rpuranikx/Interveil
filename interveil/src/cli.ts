#!/usr/bin/env node
import { Command } from 'commander';
import { startServer } from './server.js';

const program = new Command();

program
  .name('interveil')
  .description('Language-agnostic AI agent observability server')
  .version('0.1.0');

program
  .command('serve')
  .description('Start the Interveil trace server')
  .option('-p, --port <number>', 'Port to listen on', '3000')
  .option('-v, --verbose', 'Log every incoming event to console', false)
  .option('--mcp-server <url>', 'Configure MCP proxy target URL')
  .option(
    '--allowed-origins <origins>',
    'Comma-separated allowed CORS origins (default: *). Example: https://app.com,https://staging.app.com',
  )
  .option(
    '--db <path>',
    'Path to SQLite database file for persistent storage. Omit to use in-memory store. Example: ./interveil.db',
  )
  .option(
    '--policy-file <path>',
    'Path to a YAML policy file loaded at startup. Example: ./config/policy.yaml',
  )
  .action(async (opts) => {
    const port = parseInt(opts.port, 10);
    const verbose = opts.verbose as boolean;
    const mcpServer = opts.mcpServer as string | undefined;
    const dbPath = opts.db as string | undefined;
    const policyFile = opts.policyFile as string | undefined;
    const allowedOrigins = opts.allowedOrigins
      ? (opts.allowedOrigins as string).split(',').map((s: string) => s.trim())
      : undefined;

    // Load policy file before starting server so rules are active from first request
    if (policyFile) {
      const { loadPolicyFile } = await import('./policy/engine.js');
      loadPolicyFile(policyFile);
    }

    try {
      await startServer({ port, verbose, mcpServer, allowedOrigins, dbPath });
      console.log(`\n  ▶  Interveil running at http://localhost:${port}`);
      console.log(`  ▶  WebSocket at ws://localhost:${port}/ws`);
      if (mcpServer)     console.log(`  ▶  MCP proxy → ${mcpServer}`);
      if (allowedOrigins) console.log(`  ▶  CORS origins: ${allowedOrigins.join(', ')}`);
      if (dbPath)        console.log(`  ▶  Persistent storage: ${dbPath}`);
      if (policyFile)    console.log(`  ▶  Policy file: ${policyFile}`);
      console.log('');
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'EADDRINUSE') {
        console.error(`[Interveil] Port ${port} is already in use. Try --port ${port + 1}`);
      } else {
        console.error('[Interveil] Failed to start server:', error.message);
      }
      process.exit(1);
    }
  });

program.parse(process.argv);
