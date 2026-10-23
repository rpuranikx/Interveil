import { useState, useEffect, useCallback, useRef } from 'react';
import { Session, TraceEvent } from '../types';
import { apiFetch } from '../api';

/** A WebSocket message: a trace event, or a session that was created or updated. */
export type LiveMessage = TraceEvent | { type: 'session'; session: Session };

const byStep = (a: TraceEvent, b: TraceEvent) => a.step_index - b.step_index;

/** Union of two event lists by event_id, sorted by step. */
function merge(a: TraceEvent[], b: TraceEvent[]): TraceEvent[] {
  const seen = new Map<string, TraceEvent>();
  for (const e of [...a, ...b]) seen.set(e.event_id, e);
  return [...seen.values()].sort(byStep);
}

export function useSessions() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [events, setEvents] = useState<Record<string, TraceEvent[]>>({});
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Sessions whose full history has been fetched. Live events alone are not enough:
  // a session selected after its first live event would otherwise show a partial trace.
  const loaded = useRef(new Set<string>());

  const upsertSession = useCallback((session: Session) => {
    setSessions(prev => {
      const i = prev.findIndex(s => s.session_id === session.session_id);
      if (i < 0) return [session, ...prev];
      const next = [...prev];
      next[i] = { ...next[i], ...session };
      return next;
    });
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const res = await apiFetch('/api/v1/sessions');
        const data = await res.json() as { sessions?: Session[] };
        const list = data.sessions ?? [];
        // Keep sessions that arrived live while this request was in flight.
        setSessions(prev => [...prev.filter(p => !list.some(s => s.session_id === p.session_id)), ...list]);
        if (list.length > 0) setActiveSessionId(prev => prev ?? list[0].session_id);
      } catch {
        // offline or unauthorized; the WebSocket status shows why
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!activeSessionId || loaded.current.has(activeSessionId)) return;
    const sessionId = activeSessionId;
    loaded.current.add(sessionId);
    void (async () => {
      try {
        const res = await apiFetch(`/api/v1/sessions/${sessionId}/events`);
        const data = await res.json() as { events?: TraceEvent[] };
        setEvents(prev => ({ ...prev, [sessionId]: merge(prev[sessionId] ?? [], data.events ?? []) }));
      } catch {
        loaded.current.delete(sessionId); // retry next time it is selected
      }
    })();
  }, [activeSessionId]);

  const onLiveMessage = useCallback((msg: LiveMessage) => {
    if ('type' in msg && msg.type === 'session') {
      upsertSession(msg.session);
      return;
    }
    const event = msg as TraceEvent;
    if (!event.session_id || !event.step_type) return;

    setSessions(prev => prev.some(s => s.session_id === event.session_id)
      ? prev
      : [{ session_id: event.session_id, status: 'running', started_at: event.timestamp }, ...prev]);
    setEvents(prev => ({ ...prev, [event.session_id]: merge(prev[event.session_id] ?? [], [event]) }));
    setActiveSessionId(prev => prev ?? event.session_id);
  }, [upsertSession]);

  const activeEvents = activeSessionId ? (events[activeSessionId] ?? []) : [];
  const activeSession = sessions.find(s => s.session_id === activeSessionId) ?? null;

  return {
    sessions,
    events,
    activeSessionId,
    setActiveSessionId,
    activeSession,
    activeEvents,
    loading,
    onLiveMessage,
  };
}
