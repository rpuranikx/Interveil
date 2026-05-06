import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { Session, TraceEvent, TraceStore } from './memory.js';

export class SqliteStore implements TraceStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this._migrate();
    console.log(`[Interveil] SQLite store initialised at ${dbPath}`);
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
    `);
  }

  async createSession(session: Session): Promise<void> {
    this.db.prepare(`
      INSERT OR IGNORE INTO sessions
        (session_id, name, agent_id, metadata, status, started_at, ended_at)
      VALUES
        (@session_id, @name, @agent_id, @metadata, @status, @started_at, @ended_at)
    `).run({
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
    const eventId = event.event_id || uuidv4();
    this.db.prepare(`
      INSERT OR IGNORE INTO events
        (event_id, session_id, step_index, step_type, input, output,
         timestamp, duration_ms, token_usage, model, error, metadata)
      VALUES
        (@event_id, @session_id, @step_index, @step_type, @input, @output,
         @timestamp, @duration_ms, @token_usage, @model, @error, @metadata)
    `).run({
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
    const row = this.db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this._rowToSession(row) : null;
  }

  async getAllSessions(): Promise<Session[]> {
    const rows = this.db.prepare('SELECT * FROM sessions ORDER BY started_at DESC').all() as Record<string, unknown>[];
    return rows.map(r => this._rowToSession(r));
  }

  async getEvents(sessionId: string): Promise<TraceEvent[]> {
    const rows = this.db.prepare(
      'SELECT * FROM events WHERE session_id = ? ORDER BY step_index ASC'
    ).all(sessionId) as Record<string, unknown>[];
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
