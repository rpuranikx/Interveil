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
  .action(async (opts) => {
    const port = parseInt(opts.port, 10);
    const verbose = opts.verbose as boolean;
    const mcpServer = opts.mcpServer as string | undefined;
    const allowedOrigins = opts.allowedOrigins
      ? (opts.allowedOrigins as string).split(',').map((s: string) => s.trim())
      : undefined;

    try {
      await startServer({ port, verbose, mcpServer, allowedOrigins });
      console.log(`\n  ▶  Interveil running at http://localhost:${port}`);
      console.log(`  ▶  WebSocket at ws://localhost:${port}/ws`);
      if (mcpServer) console.log(`  ▶  MCP proxy → ${mcpServer}`);
      if (allowedOrigins) console.log(`  ▶  CORS origins: ${allowedOrigins.join(', ')}`);
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
