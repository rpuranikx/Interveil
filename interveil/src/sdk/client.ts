import { v4 as uuidv4 } from 'uuid';

export interface ClientOptions {
  port?: number;
  host?: string;
}

export interface StartSessionOptions {
  name?: string;
  agent_id?: string;
  metadata?: Record<string, unknown>;
}

export interface EmitOptions {
  session_id: string;
  step_index: number;
  step_type: string;
  input: unknown;
  output: unknown;
  timestamp: string;
  duration_ms?: number;
  token_usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  model?: string;
  error?: unknown;
  metadata?: Record<string, unknown>;
}

export class InterveillClient {
  private baseUrl: string;

  constructor(options: ClientOptions = {}) {
    const host = options.host ?? 'localhost';
    const port = options.port ?? 3000;
    this.baseUrl = `http://${host}:${port}`;
  }

  async startSession(options: StartSessionOptions = {}): Promise<{ session_id: string }> {
    const session_id = uuidv4();
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id, ...options }),
      });
      if (!res.ok) {
        const body = await res.json() as { error?: string };
        console.warn(`[Interveil] Failed to start session: ${body.error ?? res.statusText}`);
      }
    } catch (err) {
      console.warn(`[Interveil] Server unreachable — session not registered. ${(err as Error).message}`);
    }
    return { session_id };
  }

  async emit(event: EmitOptions): Promise<string | null> {
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
      });
      if (res.ok) {
        const body = await res.json() as { event_id: string };
        return body.event_id;
      }
      const body = await res.json() as { error?: string };
      console.warn(`[Interveil] Failed to emit event: ${body.error ?? res.statusText}`);
      return null;
    } catch (err) {
      console.warn(`[Interveil] Server unreachable — event not sent. ${(err as Error).message}`);
      return null;
    }
  }

  async endSession(session_id: string, status: 'completed' | 'failed'): Promise<void> {
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/sessions/${session_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, ended_at: new Date().toISOString() }),
      });
      if (!res.ok) {
        const body = await res.json() as { error?: string };
        console.warn(`[Interveil] Failed to end session: ${body.error ?? res.statusText}`);
      }
    } catch (err) {
      console.warn(`[Interveil] Server unreachable — session not closed. ${(err as Error).message}`);
    }
  }
}
