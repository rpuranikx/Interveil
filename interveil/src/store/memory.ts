import { v4 as uuidv4 } from 'uuid';

export interface Session {
  session_id: string;
  name?: string;
  agent_id?: string;
  metadata?: Record<string, unknown>;
  status: 'running' | 'completed' | 'failed';
  started_at: string;
  ended_at?: string;
}

export interface TokenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface TraceEvent {
  event_id: string;
  session_id: string;
  step_index: number;
  step_type: string;
  input: unknown;
  output: unknown;
  timestamp: string;
  duration_ms?: number;
  token_usage?: TokenUsage;
  model?: string;
  error?: unknown;
  metadata?: Record<string, unknown>;
}

export interface TraceStore {
  createSession(session: Session): Promise<void>;
  updateSession(id: string, update: Partial<Session>): Promise<void>;
  addEvent(event: TraceEvent): Promise<string>;
  getSession(id: string): Promise<Session | null>;
  getAllSessions(): Promise<Session[]>;
  getEvents(sessionId: string): Promise<TraceEvent[]>;
}

export class MemoryStore implements TraceStore {
  private sessions: Map<string, Session> = new Map();
  private events: Map<string, TraceEvent[]> = new Map();

  async createSession(session: Session): Promise<void> {
    this.sessions.set(session.session_id, { ...session });
    this.events.set(session.session_id, []);
  }

  async updateSession(id: string, update: Partial<Session>): Promise<void> {
    const existing = this.sessions.get(id);
    if (existing) {
      this.sessions.set(id, { ...existing, ...update });
    }
  }

  async addEvent(event: TraceEvent): Promise<string> {
    const eventId = event.event_id || uuidv4();
    const stored: TraceEvent = { ...event, event_id: eventId };

    if (!this.events.has(event.session_id)) {
      this.events.set(event.session_id, []);
    }
    this.events.get(event.session_id)!.push(stored);
    return eventId;
  }

  async getSession(id: string): Promise<Session | null> {
    return this.sessions.get(id) ?? null;
  }

  async getAllSessions(): Promise<Session[]> {
    return Array.from(this.sessions.values()).sort(
      (a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime()
    );
  }

  async getEvents(sessionId: string): Promise<TraceEvent[]> {
    return (this.events.get(sessionId) ?? []).sort((a, b) => a.step_index - b.step_index);
  }
}

export const store: TraceStore = new MemoryStore();
