import { evaluatePolicy } from '../policy/engine.js';
import { checkCommand } from '../commands/blocklist.js';

/**
 * Gateway-side enforcement. A tool call proposed by a model (or sent to the MCP
 * proxy) is checked against the command blocklist and the active YAML policy
 * before the agent can act on it. Arguments are evaluated as `{ args: [arguments] }`,
 * the same shape trace() uses, so a policy's `args.0.<field>` paths work in both places.
 */

export interface ProposedToolCall {
  name: string;
  /** Raw JSON string as sent by the model, or an already-parsed object (MCP). */
  arguments: unknown;
}

export interface ToolDecision {
  tool: string;
  allowed: boolean;
  /** allow_and_audit matched: allowed, but recorded. */
  audit: boolean;
  /** halt_agent matched: this agent is refused from now on. */
  halt: boolean;
  source?: 'blocklist' | 'policy';
  ruleId?: string;
  message?: string;
  arguments: unknown;
}

/** Agents stopped by a halt_agent rule, mapped to the rule id. Lives for the server's lifetime. */
const halted = new Map<string, string>();

export function haltedBy(agentId: string): string | undefined {
  return halted.get(agentId);
}

/** Test helper. */
export function resetHalts(): void {
  halted.clear();
}

function parseArguments(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? {};
  try {
    return JSON.parse(raw);
  } catch {
    // Unparseable arguments are still scanned and evaluated, as a plain string.
    return raw;
  }
}

export async function decideToolCall(agentId: string, call: ProposedToolCall): Promise<ToolDecision> {
  const args = parseArguments(call.arguments);
  const base = { tool: call.name, arguments: args, audit: false, halt: false };

  const check = checkCommand(args);
  if (check.matched) {
    const message = check.source === 'approval_required' ? 'command requires human approval' : 'destructive command pattern';
    return { ...base, allowed: false, source: 'blocklist', ruleId: check.rule, message };
  }

  const result = await evaluatePolicy(agentId, call.name, { args: [args] });
  const ruleId = result.rule?.id;
  const message = result.rule?.message;
  switch (result.action) {
    case 'allow':
      return { ...base, allowed: true, ruleId };
    case 'allow_and_audit':
      return { ...base, allowed: true, audit: true, source: 'policy', ruleId, message };
    case 'halt_agent':
      halted.set(agentId, ruleId ?? 'halt_agent');
      return { ...base, allowed: false, halt: true, source: 'policy', ruleId, message };
    case 'block':
    case 'require_approval':
      return { ...base, allowed: false, source: 'policy', ruleId: ruleId ?? 'defaultAction', message };
  }
}

export async function decideToolCalls(agentId: string, calls: ProposedToolCall[]): Promise<ToolDecision[]> {
  const decisions: ToolDecision[] = [];
  for (const call of calls) decisions.push(await decideToolCall(agentId, call));
  return decisions;
}

/** Human-readable explanation returned to the agent in place of withheld tool calls. */
export function withheldNote(decisions: ToolDecision[]): string {
  const blocked = decisions.filter(d => !d.allowed);
  const reasons = blocked.map(d => `${d.tool} (${d.source} rule "${d.ruleId}"${d.message ? `: ${d.message}` : ''})`);
  const halt = blocked.some(d => d.halt) ? ' This agent has been halted.' : '';
  return `[Interveil] Tool call${blocked.length > 1 ? 's' : ''} blocked by policy: ${reasons.join('; ')}.${halt}`;
}

/** OpenAI chat.completion tool calls, across all choices. */
export function toolCallsInResponse(response: Record<string, unknown>): ProposedToolCall[] {
  const choices = (response.choices ?? []) as Array<{ message?: { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }>;
  return choices.flatMap(c => (c.message?.tool_calls ?? []).map(tc => ({
    name: tc.function?.name ?? '',
    arguments: tc.function?.arguments ?? '',
  })));
}

/**
 * Removes every tool call from a chat.completion and puts the note in the
 * message content, so the agent has nothing to execute. A response is treated
 * as a unit: if any of its tool calls is disallowed, none are passed on.
 */
export function withholdToolCalls(response: Record<string, unknown>, note: string): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(response)) as Record<string, unknown>;
  for (const choice of (copy.choices ?? []) as Array<{ message?: Record<string, unknown>; finish_reason?: string }>) {
    if (!choice.message?.tool_calls) continue;
    delete choice.message.tool_calls;
    const content = typeof choice.message.content === 'string' && choice.message.content ? `${choice.message.content}\n\n` : '';
    choice.message.content = content + note;
    choice.finish_reason = 'stop';
  }
  return copy;
}
