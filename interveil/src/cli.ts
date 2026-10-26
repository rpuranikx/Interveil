#!/usr/bin/env node
import { Command } from 'commander';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';

// The server is imported lazily so `interveil hook` starts fast: it runs before every tool call.
const startServer: typeof import('./server.js').startServer = async (opts) => (await import('./server.js')).startServer(opts);

// Load ./.env when present so API keys and settings don't need to be exported by hand.
if (fs.existsSync('.env')) process.loadEnvFile('.env');

const PRESET_DIR = path.join(__dirname, '..', 'examples', 'policies');

function presetNames(): string[] {
  try {
    return fs.readdirSync(PRESET_DIR).filter(f => f.endsWith('.yaml')).map(f => f.slice(0, -'.yaml'.length));
  } catch {
    return [];
  }
}

const program = new Command();

program
  .name('interveil')
  .description('Policy enforcement and live traces for AI agents')
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
  .option('--preset <name>', `Load a bundled policy instead of --policy-file: ${presetNames().join(', ')}`)
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

    if (opts.preset && opts.policyFile) {
      console.error('[Interveil] Use either --preset or --policy-file, not both.');
      process.exit(1);
    }
    if (opts.preset && !presetNames().includes(opts.preset as string)) {
      console.error(`[Interveil] Unknown preset "${opts.preset}". Available: ${presetNames().join(', ')}`);
      process.exit(1);
    }
    const policyFile = opts.preset ? path.join(PRESET_DIR, `${opts.preset}.yaml`) : opts.policyFile as string | undefined;

    // `interveil init` writes a key file; use it when no key is set in the environment.
    const { readKeyFile, keyFilePath } = await import('./claude-code.js');
    const fileKey = process.env.INTERVEIL_API_KEY ? undefined : readKeyFile();
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
      const { storage } = await startServer({ port, host, verbose, mcpServer, allowedOrigins, dbPath, apiKey: fileKey });
      console.log(`\n  ▶  Interveil running at http://localhost:${port}`);
      console.log(`  ▶  WebSocket at ws://localhost:${port}/ws`);
      if (mcpServer)     console.log(`  ▶  MCP proxy → ${mcpServer}`);
      if (allowedOrigins) console.log(`  ▶  CORS origins: ${allowedOrigins.join(', ')}`);
      console.log(process.env.INTERVEIL_API_KEY ? '  ▶  API key: required'
        : fileKey ? `  ▶  API key: required (from ${keyFilePath()})`
        : '  ▶  API key: not set (local use only)');
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

program
  .command('hook <agent>')
  .description('PreToolUse hook: reads a tool call on stdin and prints the decision (agent: claude-code)')
  .option('--url <url>', 'Interveil server', process.env.INTERVEIL_URL)
  .option('--agent-id <id>', 'Agent id for policy rules', process.env.INTERVEIL_AGENT_ID)
  .action(async (agent: string, opts) => {
    const { runHook, DEFAULT_URL, DEFAULT_AGENT_ID } = await import('./claude-code.js');
    if (agent !== 'claude-code') {
      console.error(`[Interveil] Unknown hook "${agent}". Available: claude-code`);
      process.exit(1);
    }
    await runHook({ url: opts.url ?? DEFAULT_URL, agentId: opts.agentId ?? DEFAULT_AGENT_ID });
  });

program
  .command('init <agent>')
  .description('Register the Interveil hook with an agent (agent: claude-code) and create an API key')
  .option('--user', 'Write ~/.claude/settings.json instead of ./.claude/settings.json', false)
  .option('--url <url>', 'Interveil server the hook calls')
  .option('--agent-id <id>', 'Agent id for policy rules')
  .option('--no-key', 'Do not create ~/.interveil/api-key (the server then accepts unauthenticated local requests)')
  .action(async (agent: string, opts) => {
    const { initClaudeCode, installHookScript, onFailureSupport, MIN_CLAUDE_CODE, DEFAULT_URL, DEFAULT_AGENT_ID } = await import('./claude-code.js');
    if (agent !== 'claude-code') {
      console.error(`[Interveil] Unknown agent "${agent}". Available: claude-code`);
      process.exit(1);
    }
    const settingsFile = opts.user
      ? path.join(os.homedir(), '.claude', 'settings.json')
      : path.join(process.cwd(), '.claude', 'settings.json');
    try {
      const result = initClaudeCode({
        settingsFile,
        hookScript: installHookScript(),
        url: opts.url ?? DEFAULT_URL,
        agentId: opts.agentId ?? DEFAULT_AGENT_ID,
        key: opts.key as boolean,
      });
      console.log(`\n  ▶  ${result.replaced ? 'Updated' : 'Added'} the PreToolUse hook in ${result.settingsFile}`);
      console.log(`  ▶  Hook script: ${result.entry.args?.[0]}`);
      // onFailure "block" is what makes a broken or missing hook deny instead of allow.
      const { spawnSync } = await import('child_process');
      // On Windows `claude` is a .cmd shim, which needs a shell; pass one string so nothing is concatenated.
      const probe = process.platform === 'win32'
        ? spawnSync('claude --version', { encoding: 'utf-8', timeout: 10_000, shell: true })
        : spawnSync('claude', ['--version'], { encoding: 'utf-8', timeout: 10_000 });
      const support = onFailureSupport(probe.stdout);
      const min = MIN_CLAUDE_CODE.join('.');
      if (support.status === 'ok') {
        console.log(`  ▶  Claude Code ${support.version}: a hook that fails to run blocks the tool call`);
      } else if (support.status === 'old') {
        console.log(`  ⚠  Claude Code ${support.version} is older than ${min}. Until you update it, a hook that fails to`);
        console.log('     start, crashes or times out lets the tool call through instead of blocking it.');
      } else {
        console.log(`  ⚠  Could not run \`claude --version\`. A hook that fails to run only blocks tool calls on Claude Code ${min} or later.`);
      }
      if (result.keyFile) console.log(`  ▶  API key: ${result.keyCreated ? 'created' : 'using existing'} ${result.keyFile}`);
      console.log('\n  Start the server before your next Claude Code session (tool calls are denied while it is down):\n');
      console.log(`    "${process.execPath}" "${__filename}" serve --preset coding-agent\n`);
    } catch (err) {
      console.error(`[Interveil] ${(err as Error).message}`);
      process.exit(1);
    }
  });

program.parse(process.argv);
