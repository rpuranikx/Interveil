import { WebSocketServer, WebSocket } from 'ws';
import { Server, IncomingMessage } from 'http';
import { validateToken, authEnabled } from '../teams/auth.js';

let wss: WebSocketServer | null = null;

export function initWebSocket(server: Server): WebSocketServer {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    // If auth is enabled, require a valid token in the query string or Authorization header.
    // Clients connect as: ws://host/ws?token=<token>
    // or with the header: Authorization: Bearer <token>
    if (authEnabled()) {
      const url = new URL(req.url ?? '', `http://${req.headers.host}`);
      const queryToken = url.searchParams.get('token');
      const headerToken = req.headers['authorization']?.replace('Bearer ', '')
        ?? req.headers['x-interveil-key'] as string | undefined;
      const token = queryToken ?? headerToken;

      const user = token ? validateToken(token) : null;
      if (!user) {
        ws.close(4401, 'Unauthorized: provide a valid token as ?token=<token> or Authorization: Bearer <token>');
        return;
      }
    }

    ws.on('error', () => {
      // Silently handle client errors
    });
  });

  return wss;
}

export function broadcast(data: unknown): void {
  if (!wss) return;
  const message = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(message);
      } catch {
        // Silently ignore send errors on closed connections
      }
    }
  });
}

export function getClientCount(): number {
  return wss ? wss.clients.size : 0;
}
