import { randomUUID } from 'crypto';

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
  /** The step index the next event in this session should use. */
  nextStepIndex(sessionId: string): Promise<number>;
  /** Agents stopped by a halt_agent rule, kept until explicitly lifted. */
  saveHalt(halt: Halt): Promise<void>;
  deleteHalt(agentId: string): Promise<boolean>;
  getHalts(): Promise<Halt[]>;
}

export interface Halt {
  agent_id: string;
  rule_id: string;
  halted_at: string;
}

export class MemoryStore implements TraceStore {
  private sessions: Map<string, Session> = new Map();
  private events: Map<string, TraceEvent[]> = new Map();
  private eventCount = 0;
  private halts: Map<string, Halt> = new Map();

  /**
   * @param maxEvents When the store holds more events than this, whole sessions
   *   are dropped, oldest first, so a long-running server cannot grow without bound.
   */
  constructor(private readonly maxEvents = Number(process.env.INTERVEIL_MEMORY_MAX_EVENTS ?? 100_000)) {}

  async createSession(session: Session): Promise<void> {
    this.sessions.set(session.session_id, { ...session });
    this.eventCount -= this.events.get(session.session_id)?.length ?? 0;
    this.events.set(session.session_id, []);
  }

  private evictOldest(keep: string): void {
    // Maps iterate in insertion order, so the first entries are the oldest sessions.
    for (const id of this.events.keys()) {
      if (this.eventCount <= this.maxEvents) return;
      if (id === keep) continue;
      this.eventCount -= this.events.get(id)!.length;
      this.events.delete(id);
      this.sessions.delete(id);
    }
  }

  async updateSession(id: string, update: Partial<Session>): Promise<void> {
    const existing = this.sessions.get(id);
    if (existing) this.sessions.set(id, { ...existing, ...update });
  }

  async addEvent(event: TraceEvent): Promise<string> {
    const eventId = event.event_id || randomUUID();
    const stored: TraceEvent = { ...event, event_id: eventId };
    if (!this.events.has(event.session_id)) this.events.set(event.session_id, []);
    this.events.get(event.session_id)!.push(stored);
    this.eventCount++;
    if (this.eventCount > this.maxEvents) this.evictOldest(event.session_id);
    return eventId;
  }

  async getSession(id: string): Promise<Session | null> {
    return this.sessions.get(id) ?? null;
  }

  async getAllSessions(): Promise<Session[]> {
    return Array.from(this.sessions.values()).sort(
      (a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime(),
    );
  }

  async nextStepIndex(sessionId: string): Promise<number> {
    return this.events.get(sessionId)?.length ?? 0;
  }

  async saveHalt(halt: Halt): Promise<void> {
    this.halts.set(halt.agent_id, halt);
  }

  async deleteHalt(agentId: string): Promise<boolean> {
    return this.halts.delete(agentId);
  }

  async getHalts(): Promise<Halt[]> {
    return [...this.halts.values()];
  }

  async getEvents(sessionId: string): Promise<TraceEvent[]> {
    // A sorted copy: callers must not be able to reorder or mutate the stored list.
    return [...(this.events.get(sessionId) ?? [])].sort((a, b) => a.step_index - b.step_index);
  }
}

// ── Swappable singleton ───────────────────────────────────────────────────────
// All route modules import `store` directly. This proxy delegates every call to
// an inner backend so `setStore()` can swap in SqliteStore at startup without
// requiring any changes to the route files.

class StoreProxy implements TraceStore {
  private _inner: TraceStore = new MemoryStore();

  /** Called after a session is created or updated (the server streams it to the dashboard). */
  onSessionChange: ((session: Session) => void) | null = null;

  setBackend(s: TraceStore): void { this._inner = s; }

  private async notify(id: string): Promise<void> {
    if (!this.onSessionChange) return;
    const session = await this._inner.getSession(id);
    if (session) this.onSessionChange(session);
  }

  async createSession(s: Session)             { await this._inner.createSession(s); await this.notify(s.session_id); }
  async updateSession(id: string, u: Partial<Session>) { await this._inner.updateSession(id, u); await this.notify(id); }
  addEvent(e: TraceEvent)                     { return this._inner.addEvent(e); }
  getSession(id: string)                      { return this._inner.getSession(id); }
  getAllSessions()                             { return this._inner.getAllSessions(); }
  getEvents(sid: string)                      { return this._inner.getEvents(sid); }
  nextStepIndex(sid: string)                  { return this._inner.nextStepIndex(sid); }
  saveHalt(h: Halt)                           { return this._inner.saveHalt(h); }
  deleteHalt(agentId: string)                 { return this._inner.deleteHalt(agentId); }
  getHalts()                                  { return this._inner.getHalts(); }
}

export const store = new StoreProxy();

/** Swap the active store backend. Call before startServer() or at startup. */
export function setStore(backend: TraceStore): void {
  (store as StoreProxy).setBackend(backend);
}
