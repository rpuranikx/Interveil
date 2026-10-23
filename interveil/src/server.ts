import express, { Express } from 'express';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import path from 'path';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { initWebSocket } from './ws/broadcaster.js';
import { setStore } from './store/memory.js';
import eventsRouter from './api/events.js';
import sessionsRouter from './api/sessions.js';
import healthRouter from './api/health.js';
import llmProxyRouter from './gateway/llm-proxy.js';
import mcpProxyRouter from './gateway/mcp-proxy.js';
import gatewayStatsRouter from './api/gateway-stats.js';
import policyRouter from './api/policy.js';
import { restoreHalts } from './gateway/enforcement.js';
import { resolveSecurityOptions, originGuard, requireApiKey, isLoopback } from './security.js';

export interface ServerOptions {
  port?: number;
  /** Interface to bind. Defaults to 127.0.0.1 so the server is not reachable from the network. */
  host?: string;
  /** Shared secret for /api, /v1 and /ws. Defaults to the INTERVEIL_API_KEY env var. */
  apiKey?: string;
  verbose?: boolean;
  mcpServer?: string;
  allowedOrigins?: string | string[];
  /**
   * Path to a SQLite database file for persistent storage.
   * When omitted the server uses the in-memory store (data lost on restart).
   * Example: './interveil.db'
   */
  dbPath?: string;
}

export function createApp(options: ServerOptions = {}): Express {
  const app = express();

  const security = resolveSecurityOptions(options);
  app.locals.security = security;

  // Same-origin by default: cross-site pages can neither read traces nor drive
  // the gateway. Extra origins must be listed explicitly.
  app.use(originGuard(security));
  if (security.allowedOrigins.length > 0) app.use(cors({ origin: security.allowedOrigins }));
  app.use(express.json({ limit: '10mb' }));

  // Behind a reverse proxy, INTERVEIL_TRUST_PROXY lets the client IP (for rate
  // limits) come from X-Forwarded-For: a hop count, true, or a list of proxy addresses.
  const trustProxy = process.env.INTERVEIL_TRUST_PROXY;
  if (trustProxy) {
    app.set('trust proxy', trustProxy === 'true' ? true : /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);
  }

  // Rate limiting per client IP — prevents event flooding from runaway agents.
  // INTERVEIL_RATE_LIMIT_API / INTERVEIL_RATE_LIMIT_GATEWAY set requests per minute; 0 disables.
  const apiMax = Number(process.env.INTERVEIL_RATE_LIMIT_API ?? 1000);
  const gatewayMax = Number(process.env.INTERVEIL_RATE_LIMIT_GATEWAY ?? 120);

  if (apiMax > 0) {
    app.use('/api/', rateLimit({
      windowMs: 60 * 1000,
      max: apiMax,
      standardHeaders: true,
      legacyHeaders: false,
      message: { ok: false, error: `Too many requests — rate limit exceeded (${apiMax}/min)` },
      // Mounted at /api/, so the health route's path here is /v1/health.
      skip: (req) => req.path === '/v1/health',
    }) as unknown as express.RequestHandler);
  }

  if (gatewayMax > 0) {
    app.use('/v1/', rateLimit({
      windowMs: 60 * 1000,
      max: gatewayMax,
      standardHeaders: true,
      legacyHeaders: false,
      message: { ok: false, error: `Gateway rate limit exceeded (${gatewayMax}/min)` },
    }) as unknown as express.RequestHandler);
  }

  app.use('/api/', requireApiKey(security, { exempt: (req) => req.path === '/v1/health' }));
  app.use('/v1/', requireApiKey(security));

  if (options.verbose) {
    app.use((req, _res, next) => {
      if (req.path.startsWith('/api/') || req.path.startsWith('/v1/')) {
        console.log(`[Interveil] ${req.method} ${req.path}`);
      }
      next();
    });
  }

  // Store MCP server URL globally for proxy use
  if (options.mcpServer) {
    (global as Record<string, unknown>).__mcpServerUrl = options.mcpServer;
    process.env.MCP_SERVER_URL = options.mcpServer;
  }

  // Core trace API
  app.use('/api/v1/events', eventsRouter);
  app.use('/api/v1/sessions', sessionsRouter);
  app.use('/api/v1/health', healthRouter);

  // Gateway
  app.use('/v1/proxy', llmProxyRouter);
  app.use('/v1/mcp', mcpProxyRouter);

  // Policy API and dashboard stats
  app.use('/api/v1/policy', policyRouter);
  app.use('/api/v1/gateway', gatewayStatsRouter);

  // Serve React UI
  const uiPath = path.join(__dirname, 'ui');
  app.use(express.static(uiPath));
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/v1/') || req.path === '/ws') {
      return res.status(404).json({ ok: false, error: 'Not found' });
    }
    res.sendFile(path.join(uiPath, 'index.html'));
  });

  return app;
}

export interface StartedServer {
  /** The bound port (useful when started with port 0). */
  port: number;
  server: Server;
  /** The store actually in use — 'memory' if SQLite was requested but could not load. */
  storage: 'sqlite' | 'memory';
}

export async function startServer(options: ServerOptions = {}): Promise<StartedServer> {
  const port = options.port ?? 3000;
  const host = options.host ?? '127.0.0.1';
  let storage: StartedServer['storage'] = 'memory';

  // Swap in SQLite backend before any requests are handled
  if (options.dbPath) {
    try {
      const { SqliteStore } = await import('./store/sqlite.js');
      setStore(new SqliteStore(options.dbPath));
      storage = 'sqlite';
    } catch (err: unknown) {
      const msg = (err as Error).message ?? '';
      if (msg.includes('Could not locate the bindings file') || msg.includes('MODULE_NOT_FOUND')) {
        console.warn('[Interveil] ⚠  SQLite native module is not built — using the in-memory store.');
        console.warn('[Interveil]    Traces will NOT persist across restarts.');
        console.warn('[Interveil]    To enable persistence run: pnpm rebuild better-sqlite3');
      } else {
        throw err;
      }
    }
  }

  // Halts from a previous run stay in force until lifted.
  await restoreHalts();

  const app = createApp(options);
  const server = createServer(app);

  const security = resolveSecurityOptions(options);
  initWebSocket(server, security);

  if (!isLoopback(host) && !security.apiKey) {
    console.warn(`[Interveil] ⚠  Listening on ${host} without INTERVEIL_API_KEY — anyone who can reach this port can read traces and use the gateway.`);
  }

  return new Promise<StartedServer>((resolve, reject) => {
    server.listen(port, host, () => resolve({ port: (server.address() as AddressInfo).port, server, storage }));
    server.on('error', reject);
  });
}
