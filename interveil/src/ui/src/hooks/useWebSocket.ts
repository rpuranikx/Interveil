import { useEffect, useRef, useCallback, useState } from 'react';
import { TraceEvent } from '../types';

export type WsStatus = 'connected' | 'disconnected' | 'connecting' | 'auth_required';

interface UseWebSocketReturn {
  status: WsStatus;
  lastEvent: TraceEvent | null;
  authRequired: boolean;
  connect: (token?: string) => void;
}

export function useWebSocket(onEvent: (event: TraceEvent) => void): UseWebSocketReturn {
  const [status, setStatus] = useState<WsStatus>('connecting');
  const [lastEvent, setLastEvent] = useState<TraceEvent | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const tokenRef = useRef<string | undefined>(undefined);

  const connect = useCallback((token?: string) => {
    if (token !== undefined) tokenRef.current = token;

    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
    wsRef.current?.close();

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host || 'localhost:3000';
    const qs = tokenRef.current ? `?token=${encodeURIComponent(tokenRef.current)}` : '';
    const ws = new WebSocket(`${protocol}//${host}/ws${qs}`);
    wsRef.current = ws;
    setStatus('connecting');
    setAuthRequired(false);

    ws.onopen = () => setStatus('connected');

    ws.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data as string) as TraceEvent;
        setLastEvent(event);
        onEventRef.current(event);
      } catch {
        // ignore malformed frames
      }
    };

    ws.onclose = (evt) => {
      // Server closes with code 4401 when auth is required and token is missing/invalid
      if (evt.code === 4401) {
        setStatus('auth_required');
        setAuthRequired(true);
        return; // don't auto-reconnect — wait for user to supply token
      }
      setStatus('disconnected');
      reconnectTimer.current = setTimeout(() => connect(), 2000);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return { status, lastEvent, authRequired, connect };
}
