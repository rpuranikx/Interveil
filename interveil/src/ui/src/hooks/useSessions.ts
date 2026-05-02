import { useState, useEffect, useCallback } from 'react';
import { Session, TraceEvent } from '../types';

export function useSessions() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [events, setEvents] = useState<Record<string, TraceEvent[]>>({});
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/sessions');
      const data = await res.json() as { sessions: Session[] };
      setSessions(data.sessions ?? []);
      if (data.sessions?.length > 0 && !activeSessionId) {
        setActiveSessionId(data.sessions[0].session_id);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [activeSessionId]);

  const fetchEvents = useCallback(async (sessionId: string) => {
    try {
      const res = await fetch(`/api/v1/sessions/${sessionId}/events`);
      const data = await res.json() as { events: TraceEvent[] };
      setEvents(prev => ({ ...prev, [sessionId]: data.events ?? [] }));
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void fetchSessions();
  }, []);

  useEffect(() => {
    if (activeSessionId && !events[activeSessionId]) {
      void fetchEvents(activeSessionId);
    }
  }, [activeSessionId]);

  const addLiveEvent = useCallback((event: TraceEvent) => {
    setSessions(prev => {
      const exists = prev.find(s => s.session_id === event.session_id);
      if (!exists) {
        const newSession: Session = {
          session_id: event.session_id,
          status: 'running',
          started_at: event.timestamp,
        };
        return [newSession, ...prev];
      }
      return prev;
    });

    setEvents(prev => {
      const existing = prev[event.session_id] ?? [];
      const alreadyExists = existing.some(e => e.event_id === event.event_id);
      if (alreadyExists) return prev;
      return {
        ...prev,
        [event.session_id]: [...existing, event].sort((a, b) => a.step_index - b.step_index),
      };
    });

    setActiveSessionId(prev => prev ?? event.session_id);
  }, []);

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
    addLiveEvent,
  };
}
