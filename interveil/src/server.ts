import express from 'express';
import { createServer } from 'http';
import path from 'path';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { initWebSocket } from './ws/broadcaster.js';
import eventsRouter from './api/events.js';
import sessionsRouter from './api/sessions.js';
import healthRouter from './api/health.js';
import llmProxyRouter from './gateway/llm-proxy.js';
import mcpProxyRouter from './gateway/mcp-proxy.js';
import orchestrationRouter from './api/orchestration-routes.js';

export interface ServerOptions {
  port?: number;
  verbose?: boolean;
  mcpServer?: string;
  allowedOrigins?: string | string[];
}

export function createApp(options: ServerOptions = {}) {
  const app = express();

  // CORS — restrict to explicit origins in production, open in dev
  const originOption = options.allowedOrigins
    ?? (process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*');

  app.use(cors({ origin: originOption, credentials: true }));
  app.use(express.json({ limit: '10mb' }));

  // Rate limiting — prevents event flooding from runaway agents
  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,       // 1 minute
    max: 1000,                  // max 1 000 requests/min per IP on trace API
    standardHeaders: true,
    legacyHeaders: false,
    message: { ok: false, error: 'Too many requests — rate limit exceeded (1000/min)' },
    skip: (req) => req.path === '/api/v1/health',
  });

  const gatewayLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,                   // max 120 LLM proxy requests/min per IP
    standardHeaders: true,
    legacyHeaders: false,
    message: { ok: false, error: 'Gateway rate limit exceeded (120/min)' },
  });

  app.use('/api/', apiLimiter);
  app.use('/v1/', gatewayLimiter);

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

  // Phase 1.5 — Gateway
  app.use('/v1/proxy', llmProxyRouter);
  app.use('/v1/mcp', mcpProxyRouter);

  // Phase 7–9 — Orchestration, Teams, REST API
  app.use('/api/v1', orchestrationRouter);

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

export function startServer(options: ServerOptions = {}): Promise<{ port: number }> {
  const port = options.port ?? 3000;
  const app = createApp(options);
  const server = createServer(app);

  initWebSocket(server);

  return new Promise((resolve, reject) => {
    server.listen(port, () => {
      resolve({ port });
    });
    server.on('error', reject);
  });
}
