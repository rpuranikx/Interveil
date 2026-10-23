#!/usr/bin/env node
import { Command } from 'commander';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { startServer } from './server.js';

// Load ./.env when present so API keys and settings don't need to be exported by hand.
if (fs.existsSync('.env')) process.loadEnvFile('.env');

const program = new Command();

program
  .name('interveil')
  .description('Language-agnostic AI agent observability server')
  .version('0.1.0');

program
  .command('serve')
  .description('Start the Interveil trace server')
  .option('-p, --port <number>', 'Port to listen on', '3000')
  .option('--host <host>', 'Interface to bind (use 0.0.0.0 to expose on the network; set INTERVEIL_API_KEY first)', process.env.INTERVEIL_HOST ?? '127.0.0.1')
  .option('-v, --verbose', 'Log every incoming event to console', false)
  .option('--mcp-server <url>', 'Configure MCP proxy target URL')
  .option(
    '--allowed-origins <origins>',
    'Comma-separated allowed CORS origins (default: *). Example: https://app.com,https://staging.app.com',
  )
  .option(
    '--db <path>',
    'Path to SQLite database file for persistent storage. Defaults to ~/.interveil/traces.db. Set to "memory" for in-memory store.',
  )
  .option(
    '--policy-file <path>',
    'Path to a YAML policy file loaded at startup. Example: ./config/policy.yaml',
  )
  .action(async (opts) => {
    const port = parseInt(opts.port, 10);
    const verbose = opts.verbose as boolean;
    const mcpServer = opts.mcpServer as string | undefined;
    let dbPath = opts.db as string | undefined;

    if (!dbPath || dbPath !== 'memory') {
      const defaultDir = path.join(os.homedir(), '.interveil');
      if (!fs.existsSync(defaultDir)) {
        fs.mkdirSync(defaultDir, { recursive: true });
      }
      dbPath = dbPath || path.join(defaultDir, 'traces.db');
    } else if (dbPath === 'memory') {
      dbPath = undefined; // Undefined dbPath falls back to in-memory store in server.ts
    }

    const policyFile = opts.policyFile as string | undefined;
    const allowedOrigins = opts.allowedOrigins
      ? (opts.allowedOrigins as string).split(',').map((s: string) => s.trim())
      : undefined;

    // Load policy file before starting server so rules are active from first request
    if (policyFile) {
      const { loadPolicyFile } = await import('./policy/engine.js');
      try {
        loadPolicyFile(policyFile);
      } catch (err) {
        // Refuse to start rather than run with no policy in force.
        console.error(`[Interveil] ${(err as Error).message}`);
        process.exit(1);
      }
    }

    try {
      const host = opts.host as string;
      const { storage } = await startServer({ port, host, verbose, mcpServer, allowedOrigins, dbPath });
      console.log(`\n  ▶  Interveil running at http://localhost:${port}`);
      console.log(`  ▶  WebSocket at ws://localhost:${port}/ws`);
      if (mcpServer)     console.log(`  ▶  MCP proxy → ${mcpServer}`);
      if (allowedOrigins) console.log(`  ▶  CORS origins: ${allowedOrigins.join(', ')}`);
      console.log(process.env.INTERVEIL_API_KEY ? '  ▶  API key: required' : '  ▶  API key: not set (local use only)');
      console.log(storage === 'sqlite'
        ? `  ▶  Storage: SQLite at ${dbPath}`
        : '  ▶  Storage: in-memory (traces are lost on restart)');
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

program
  .command('run [command...]')
  .description('Start the Interveil server and execute your script')
  .option('-p, --port <number>', 'Port to listen on', '3000')
  .option('--db <path>', 'Path to SQLite database file', '')
  .action(async (commandArgs, opts) => {
    if (!commandArgs || commandArgs.length === 0) {
      console.error('[Interveil] You must provide a command to run. Example: interveil run node app.js');
      process.exit(1);
    }
    
    const port = parseInt(opts.port, 10);
    let dbPath = opts.db || undefined;
    
    if (!dbPath || dbPath !== 'memory') {
      const defaultDir = path.join(os.homedir(), '.interveil');
      if (!fs.existsSync(defaultDir)) fs.mkdirSync(defaultDir, { recursive: true });
      dbPath = dbPath || path.join(defaultDir, 'traces.db');
    } else if (dbPath === 'memory') {
      dbPath = undefined;
    }

    try {
      const { storage } = await startServer({ port, dbPath });
      console.log(`\n  ▶  Interveil background server running at http://localhost:${port}`);
      console.log(storage === 'sqlite' ? `  ▶  Storage: SQLite at ${dbPath}` : '  ▶  Storage: in-memory');
      console.log(`  ▶  Executing: ${commandArgs.join(' ')}\n`);

      const child = spawn(commandArgs[0], commandArgs.slice(1), {
        stdio: 'inherit',
        shell: true,
        env: {
          ...process.env,
          INTERVEIL_URL: `http://localhost:${port}`
        }
      });

      child.on('close', (code) => {
        console.log(`\n[Interveil] Script finished with code ${code}.`);
        console.log(`[Interveil] Server still running at http://localhost:${port}`);
        console.log(`[Interveil] Press Ctrl+C to shut down.\n`);
      });

      process.on('SIGINT', () => {
        console.log('\n[Interveil] Shutting down...');
        process.exit(0);
      });
      
    } catch (err: unknown) {
      console.error('[Interveil] Failed to start background server:', (err as NodeJS.ErrnoException).message);
      process.exit(1);
    }
  });

program
  .command('demo')
  .description('Run a scripted agent through the gateway and watch a prompt injection get blocked (no API keys needed)')
  .option('-p, --port <number>', 'Port to listen on', '3000')
  .option('--no-open', 'Do not open the dashboard in a browser')
  .option('--exit', 'Exit when the scenario finishes instead of keeping the dashboard up', false)
  .option('--step-delay <ms>', 'Pause between agent steps, for presenting', '1200')
  .action(async (opts) => {
    const { runDemo } = await import('./demo/scenario.js');
    const port = parseInt(opts.port, 10);
    const stepDelayMs = parseInt(opts.stepDelay, 10);
    if (opts.open) {
      // Open first so the viewer sees the steps arrive live.
      setTimeout(() => { void import('open').then(({ default: open }) => open(`http://localhost:${port}`)).catch(() => {}); }, 300);
    }
    try {
      const demo = await runDemo({ port, stepDelayMs });
      if (opts.exit) {
        demo.close();
        return;
      }
      console.log('Press Ctrl+C to stop.\n');
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      console.error(error.code === 'EADDRINUSE'
        ? `[Interveil] Port ${port} is already in use. Try: interveil demo --port ${port + 1}`
        : `[Interveil] Demo failed: ${error.message}`);
      process.exit(1);
    }
  });

program.parse(process.argv);
