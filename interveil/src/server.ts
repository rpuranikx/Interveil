import express from 'express';
import { createServer } from 'http';
import path from 'path';
import cors from 'cors';
import { initWebSocket } from './ws/broadcaster.js';
import eventsRouter from './api/events.js';
import sessionsRouter from './api/sessions.js';
import healthRouter from './api/health.js';

export interface ServerOptions {
  port?: number;
  verbose?: boolean;
  mcpServer?: string;
}

export function createApp(options: ServerOptions = {}) {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '10mb' }));

  app.use((req, res, next) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.path.startsWith('/api/') || req.path.startsWith('/v1/')) {
      return next();
    }
    res.removeHeader('Content-Type');
    return next();
  });

  if (options.verbose) {
    app.use((req, _res, next) => {
      console.log(`[Interveil] ${req.method} ${req.path}`);
      next();
    });
  }

  app.use('/api/v1/events', eventsRouter);
  app.use('/api/v1/sessions', sessionsRouter);
  app.use('/api/v1/health', healthRouter);

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
