import { useEffect, useRef, useCallback, useState } from 'react';
import { TraceEvent } from '../types';

export type WsStatus = 'connected' | 'disconnected' | 'connecting';

interface UseWebSocketReturn {
  status: WsStatus;
  lastEvent: TraceEvent | null;
}

export function useWebSocket(onEvent: (event: TraceEvent) => void): UseWebSocketReturn {
  const [status, setStatus] = useState<WsStatus>('connecting');
  const [lastEvent, setLastEvent] = useState<TraceEvent | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const connect = useCallback(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    wsRef.current = ws;
    setStatus('connecting');

    ws.onopen = () => setStatus('connected');

    ws.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data as string) as TraceEvent;
        setLastEvent(event);
        onEventRef.current(event);
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = () => {
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

  return { status, lastEvent };
}
