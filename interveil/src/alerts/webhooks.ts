import { createHmac } from 'crypto';
import { activeWebhooks, WebhookConfig } from '../policy/engine.js';
import { TraceEvent } from '../store/memory.js';
import { log } from '../log.js';

/**
 * Sends policy events to the webhooks configured under `alerts.webhooks` in the
 * server's policy file. Delivery is fire-and-forget so alerting never slows an
 * agent down: 5 s timeout, one retry on a network error or 5xx.
 *
 * Signed requests carry `x-interveil-timestamp` and
 * `x-interveil-signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<body>">`.
 */

export const WEBHOOK_TIMEOUT_MS = 5000;
const RETRY_DELAY_MS = Number(process.env.INTERVEIL_WEBHOOK_RETRY_MS ?? 1000);

export interface PolicyAlert {
  type: 'policy.violation' | 'policy.audit';
  session_id: string;
  agent_id?: unknown;
  tool?: unknown;
  rule_id?: unknown;
  source?: unknown;
  message?: unknown;
  halt?: unknown;
  enforced_at?: unknown;
  timestamp: string;
}

export function signature(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

async function deliver(hook: WebhookConfig, body: string): Promise<boolean> {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'interveil-webhook' };
  const secret = hook.secretEnv ? process.env[hook.secretEnv] : undefined;
  if (hook.secretEnv && !secret) {
    log.warn(`Webhook ${hook.url}: ${hook.secretEnv} is not set; sending unsigned.`);
  }
  if (secret) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    headers['x-interveil-timestamp'] = timestamp;
    headers['x-interveil-signature'] = signature(secret, timestamp, body);
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(hook.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS) });
      if (res.status < 500) {
        if (!res.ok) log.warn(`Webhook ${hook.url} rejected the alert with ${res.status}.`);
        return res.ok;
      }
    } catch {
      // network error or timeout — retry once
    }
    if (attempt === 1) await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
  }
  log.warn(`Webhook ${hook.url} failed after 2 attempts; alert dropped.`);
  return false;
}

/** Sends the event to every matching webhook. Callers do not need to await it. */
export async function notifyPolicyEvent(event: Pick<TraceEvent, 'session_id' | 'step_type' | 'input' | 'metadata' | 'timestamp'>): Promise<void> {
  if (event.step_type !== 'POLICY_VIOLATION' && event.step_type !== 'POLICY_AUDIT') return;
  const hooks = activeWebhooks().filter(h => h.events.includes(event.step_type as 'POLICY_VIOLATION' | 'POLICY_AUDIT'));
  if (hooks.length === 0) return;

  const meta = event.metadata ?? {};
  const input = (event.input ?? {}) as Record<string, unknown>;
  const alert: PolicyAlert = {
    type: event.step_type === 'POLICY_VIOLATION' ? 'policy.violation' : 'policy.audit',
    session_id: event.session_id,
    agent_id: meta.agent_id,
    tool: input.tool_name ?? input.method,
    rule_id: meta.rule_id,
    source: meta.source,
    message: meta.message,
    halt: meta.halt ?? meta.policy_action === 'halt_agent',
    enforced_at: meta.enforced_at ?? 'sdk',
    timestamp: event.timestamp,
  };
  const body = JSON.stringify(alert);
  await Promise.all(hooks.map(h => deliver(h, body)));
}
