import { Request, Response } from 'express';
import { ensureSession, recordEvent } from '../store/record.js';
import { decideToolCalls, haltedBy, ProposedToolCall, ToolDecision, withheldNote } from './enforcement.js';

/** Shared by every gateway route: sessions, halts, tool-call gating and the dashboard's recent requests. */

const recentRequests: Array<{ model: string; tokens: number; latency: number; time: string }> = [];

export function trackRequest(model: string, tokens: number, latency: number): void {
  recentRequests.unshift({ model, tokens, latency, time: new Date().toISOString() });
  if (recentRequests.length > 10) recentRequests.pop();
}

export function getRecentRequests() {
  return [...recentRequests];
}

/** Records policy outcomes for tool calls the gateway evaluated. */
async function recordDecisions(sessionId: string, agentId: string, decisions: ToolDecision[]): Promise<void> {
  for (const d of decisions) {
    if (d.allowed && !d.audit) continue;
    await recordEvent(sessionId, d.allowed ? 'POLICY_AUDIT' : 'POLICY_VIOLATION', {
      tool_name: d.tool,
      arguments: d.arguments,
    }, null, {
      metadata: {
        rule_id: d.ruleId,
        source: d.source,
        agent_id: agentId,
        message: d.message,
        halt: d.halt,
        enforced_at: 'gateway',
      },
    });
  }
}

/** Evaluates proposed tool calls; returns the note to send instead of them, or null to allow. */
export async function gateToolCalls(sessionId: string, agentId: string, calls: ProposedToolCall[]): Promise<string | null> {
  const decisions = await decideToolCalls(agentId, calls);
  await recordDecisions(sessionId, agentId, decisions);
  return decisions.some(d => !d.allowed) ? withheldNote(decisions) : null;
}

export interface GatewayContext {
  sessionId: string;
  /** Policy rules match on this id, like trace({ agentId }). */
  agentId: string;
}

/**
 * Resolves the session (requests without `x-interveil-session-id` are grouped by
 * day) and agent for a gateway request. A halted agent gets a 403 in `errorBody`'s
 * shape and null is returned.
 */
export async function gatewayContext(
  req: Request, res: Response, model: string, errorBody: (message: string) => object,
): Promise<GatewayContext | null> {
  const sessionHeader = req.headers['x-interveil-session-id'] as string | undefined;
  const sessionId = sessionHeader ?? `ide-proxy-${new Date().toISOString().split('T')[0]}`;
  await ensureSession(sessionId, {
    name: `Gateway — ${model} — ${new Date().toISOString()}`,
    metadata: { source: 'gateway', badge: 'GATEWAY' },
  });

  const agentId = (req.headers['x-interveil-agent-id'] as string | undefined) || 'default';
  const haltRule = haltedBy(agentId);
  if (haltRule) {
    await recordEvent(sessionId, 'POLICY_VIOLATION', { model }, null, {
      metadata: { rule_id: haltRule, agent_id: agentId, halt: true, message: 'request refused: agent is halted', enforced_at: 'gateway' },
    });
    res.status(403).json(errorBody(`Interveil Gateway: agent "${agentId}" was halted by policy rule "${haltRule}".`));
    return null;
  }
  return { sessionId, agentId };
}
