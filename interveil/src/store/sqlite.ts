import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { Halt, Session, TraceEvent, TraceStore } from './memory.js';
import { log } from '../log.js';

export class SqliteStore implements TraceStore {
  private db: Database.Database;
  // Prepared once: compiling SQL on every call was the largest cost per gateway request.
  private stmts: {
    insertSession: Database.Statement;
    insertEvent: Database.Statement;
    getSession: Database.Statement;
    allSessions: Database.Statement;
    sessionEvents: Database.Statement;
    nextStep: Database.Statement;
    saveHalt: Database.Statement;
    deleteHalt: Database.Statement;
    allHalts: Database.Statement;
  };

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this._migrate();
    this.stmts = {
      insertSession: this.db.prepare(`
        INSERT OR IGNORE INTO sessions
          (session_id, name, agent_id, metadata, status, started_at, ended_at)
        VALUES
          (@session_id, @name, @agent_id, @metadata, @status, @started_at, @ended_at)
      `),
      insertEvent: this.db.prepare(`
        INSERT OR IGNORE INTO events
          (event_id, session_id, step_index, step_type, input, output,
           timestamp, duration_ms, token_usage, model, error, metadata)
        VALUES
          (@event_id, @session_id, @step_index, @step_type, @input, @output,
           @timestamp, @duration_ms, @token_usage, @model, @error, @metadata)
      `),
      getSession: this.db.prepare('SELECT * FROM sessions WHERE session_id = ?'),
      allSessions: this.db.prepare('SELECT * FROM sessions ORDER BY started_at DESC'),
      sessionEvents: this.db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY step_index ASC'),
      nextStep: this.db.prepare('SELECT COALESCE(MAX(step_index) + 1, 0) AS next FROM events WHERE session_id = ?'),
      saveHalt: this.db.prepare('INSERT OR REPLACE INTO halts (agent_id, rule_id, halted_at) VALUES (@agent_id, @rule_id, @halted_at)'),
      deleteHalt: this.db.prepare('DELETE FROM halts WHERE agent_id = ?'),
      allHalts: this.db.prepare('SELECT agent_id, rule_id, halted_at FROM halts ORDER BY halted_at'),
    };
    log.info(`SQLite store initialised at ${dbPath}`);
  }

  private _migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id   TEXT PRIMARY KEY,
        name         TEXT,
        agent_id     TEXT,
        metadata     TEXT,
        status       TEXT NOT NULL DEFAULT 'running',
        started_at   TEXT NOT NULL,
        ended_at     TEXT
      );

      CREATE TABLE IF NOT EXISTS events (
        event_id     TEXT PRIMARY KEY,
        session_id   TEXT NOT NULL REFERENCES sessions(session_id),
        step_index   INTEGER NOT NULL,
        step_type    TEXT NOT NULL,
        input        TEXT,
        output       TEXT,
        timestamp    TEXT NOT NULL,
        duration_ms  INTEGER,
        token_usage  TEXT,
        model        TEXT,
        error        TEXT,
        metadata     TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, step_index);

      CREATE TABLE IF NOT EXISTS halts (
        agent_id   TEXT PRIMARY KEY,
        rule_id    TEXT NOT NULL,
        halted_at  TEXT NOT NULL
      );
    `);
  }

  async createSession(session: Session): Promise<void> {
    this.stmts.insertSession.run({
      session_id: session.session_id,
      name:       session.name ?? null,
      agent_id:   session.agent_id ?? null,
      metadata:   session.metadata ? JSON.stringify(session.metadata) : null,
      status:     session.status,
      started_at: session.started_at,
      ended_at:   session.ended_at ?? null,
    });
  }

  async updateSession(id: string, update: Partial<Session>): Promise<void> {
    const fields: string[] = [];
    const values: Record<string, unknown> = { session_id: id };

    if (update.status !== undefined)   { fields.push('status = @status');     values.status = update.status; }
    if (update.ended_at !== undefined) { fields.push('ended_at = @ended_at'); values.ended_at = update.ended_at; }
    if (update.name !== undefined)     { fields.push('name = @name');         values.name = update.name; }
    if (update.metadata !== undefined) { fields.push('metadata = @metadata'); values.metadata = JSON.stringify(update.metadata); }

    if (fields.length === 0) return;
    this.db.prepare(`UPDATE sessions SET ${fields.join(', ')} WHERE session_id = @session_id`).run(values);
  }

  async addEvent(event: TraceEvent): Promise<string> {
    const eventId = event.event_id || randomUUID();
    this.stmts.insertEvent.run({
      event_id:    eventId,
      session_id:  event.session_id,
      step_index:  event.step_index,
      step_type:   event.step_type,
      input:       event.input !== undefined ? JSON.stringify(event.input) : null,
      output:      event.output !== undefined ? JSON.stringify(event.output) : null,
      timestamp:   event.timestamp,
      duration_ms: event.duration_ms ?? null,
      token_usage: event.token_usage ? JSON.stringify(event.token_usage) : null,
      model:       event.model ?? null,
      error:       event.error !== undefined ? JSON.stringify(event.error) : null,
      metadata:    event.metadata ? JSON.stringify(event.metadata) : null,
    });
    return eventId;
  }

  async getSession(id: string): Promise<Session | null> {
    const row = this.stmts.getSession.get(id) as Record<string, unknown> | undefined;
    return row ? this._rowToSession(row) : null;
  }

  async getAllSessions(): Promise<Session[]> {
    const rows = this.stmts.allSessions.all() as Record<string, unknown>[];
    return rows.map(r => this._rowToSession(r));
  }

  async saveHalt(halt: Halt): Promise<void> {
    this.stmts.saveHalt.run(halt);
  }

  async deleteHalt(agentId: string): Promise<boolean> {
    return this.stmts.deleteHalt.run(agentId).changes > 0;
  }

  async getHalts(): Promise<Halt[]> {
    return this.stmts.allHalts.all() as Halt[];
  }

  async nextStepIndex(sessionId: string): Promise<number> {
    return (this.stmts.nextStep.get(sessionId) as { next: number }).next;
  }

  async getEvents(sessionId: string): Promise<TraceEvent[]> {
    const rows = this.stmts.sessionEvents.all(sessionId) as Record<string, unknown>[];
    return rows.map(r => this._rowToEvent(r));
  }

  private _rowToSession(row: Record<string, unknown>): Session {
    return {
      session_id: row.session_id as string,
      name:       row.name as string | undefined,
      agent_id:   row.agent_id as string | undefined,
      metadata:   row.metadata ? JSON.parse(row.metadata as string) as Record<string, unknown> : undefined,
      status:     row.status as 'running' | 'completed' | 'failed',
      started_at: row.started_at as string,
      ended_at:   row.ended_at as string | undefined,
    };
  }

  private _rowToEvent(row: Record<string, unknown>): TraceEvent {
    return {
      event_id:    row.event_id as string,
      session_id:  row.session_id as string,
      step_index:  row.step_index as number,
      step_type:   row.step_type as string,
      input:       row.input ? JSON.parse(row.input as string) : null,
      output:      row.output ? JSON.parse(row.output as string) : null,
      timestamp:   row.timestamp as string,
      duration_ms: row.duration_ms as number | undefined,
      token_usage: row.token_usage ? JSON.parse(row.token_usage as string) : undefined,
      model:       row.model as string | undefined,
      error:       row.error ? JSON.parse(row.error as string) : undefined,
      metadata:    row.metadata ? JSON.parse(row.metadata as string) : undefined,
    };
  }
}
