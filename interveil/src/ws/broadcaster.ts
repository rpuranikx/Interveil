import { WebSocketServer, WebSocket } from 'ws';
import { Server, IncomingMessage } from 'http';
import { SecurityOptions, isAuthorized, isHostAllowed, isOriginAllowed } from '../security.js';

let wss: WebSocketServer | null = null;

export function initWebSocket(server: Server, security: SecurityOptions): WebSocketServer {
  wss = new WebSocketServer({
    server,
    path: '/ws',
    // Browsers do not apply CORS to WebSockets, so cross-site pages are refused at the handshake.
    verifyClient: ({ req }: { req: IncomingMessage }) => isHostAllowed(req, security) && isOriginAllowed(req, security),
  });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    // Browsers cannot set headers on a WebSocket, so the dashboard passes the key as ?token=<key>.
    // Other clients may use Authorization: Bearer <key> or x-interveil-key.
    const url = new URL(req.url ?? '', `http://${req.headers.host}`);
    if (!isAuthorized(req, security, url)) {
      ws.close(4401, 'Unauthorized: provide the Interveil API key as ?token=<key> or Authorization: Bearer <key>');
      return;
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
