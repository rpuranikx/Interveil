import { randomUUID } from 'crypto';
import { store, Session } from './memory.js';
import { broadcast } from '../ws/broadcaster.js';
import { notifyPolicyEvent } from '../alerts/webhooks.js';

/** Creates the session if it does not exist yet. */
export async function ensureSession(sessionId: string, init: Omit<Session, 'session_id' | 'status' | 'started_at'>): Promise<void> {
  if (await store.getSession(sessionId)) return;
  await store.createSession({ session_id: sessionId, status: 'running', started_at: new Date().toISOString(), ...init });
}

/**
 * Stores a server-generated event at the end of its session, streams it to the
 * dashboard, and sends policy alerts. One path for the gateway, MCP proxy and policy API.
 */
export async function recordEvent(
  sessionId: string,
  stepType: string,
  input: unknown,
  output: unknown,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const event = {
    event_id: randomUUID(),
    session_id: sessionId,
    step_index: await store.nextStepIndex(sessionId),
    step_type: stepType,
    input,
    output,
    timestamp: new Date().toISOString(),
    ...extra,
  };
  await store.addEvent(event as Parameters<typeof store.addEvent>[0]);
  broadcast(event);
  void notifyPolicyEvent(event as Parameters<typeof notifyPolicyEvent>[0]);
}
