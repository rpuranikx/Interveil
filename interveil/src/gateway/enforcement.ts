import { evaluatePolicy, ruleTags } from '../policy/engine.js';
import { checkCommand } from '../commands/blocklist.js';
import { scanScope } from '../commands/tool-scope.js';
import { checkSelfProtection } from './self-protection.js';
import { store } from '../store/memory.js';

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
  /**
   * require_approval matched: refused unless a human approves it. Clients with a
   * human in the loop (the Claude Code hook) ask; everything else treats it as a block.
   */
  approval: boolean;
  source?: 'blocklist' | 'policy' | 'self_protection';
  ruleId?: string;
  message?: string;
  /** Session tags this call added (see `tag` in the policy schema). */
  tags?: string[];
  arguments: unknown;
}

/** Agents stopped by a halt_agent rule, mapped to the rule id. Lives for the server's lifetime. */
const halted = new Map<string, string>();

export function haltedBy(agentId: string): string | undefined {
  return halted.get(agentId);
}

/** Loads halts saved by a previous run, so a restart does not lift them. */
export async function restoreHalts(): Promise<void> {
  for (const h of await store.getHalts()) halted.set(h.agent_id, h.rule_id);
}

/** Lifts a halt. Returns false if the agent was not halted. */
export async function liftHalt(agentId: string): Promise<boolean> {
  const was = halted.delete(agentId);
  return (await store.deleteHalt(agentId)) || was;
}

/** Test helper. */
export function resetHalts(): void {
  halted.clear();
}

/**
 * Tags set by `tag` rules, per agent and session. A session condition such as
 * "a secret was read" must not leak into another session, and an agent must not
 * be able to clear its own tags, so they live here rather than with the client.
 * In memory: a server restart clears them. Oldest sessions are dropped past the cap.
 */
const sessionTags = new Map<string, Set<string>>();
const MAX_TAGGED_SESSIONS = 10_000;

const sessionKey = (agentId: string, sessionId?: string) => `${agentId}\u0000${sessionId ?? ''}`;

export function tagsOf(agentId: string, sessionId?: string): ReadonlySet<string> {
  return sessionTags.get(sessionKey(agentId, sessionId)) ?? new Set();
}

function addTags(agentId: string, sessionId: string | undefined, tags: string[]): void {
  const key = sessionKey(agentId, sessionId);
  let set = sessionTags.get(key);
  if (!set) {
    if (sessionTags.size >= MAX_TAGGED_SESSIONS) sessionTags.delete(sessionTags.keys().next().value as string);
    set = new Set();
    sessionTags.set(key, set);
  }
  for (const t of tags) set.add(t);
}

/** Test helper. */
export function resetSessionTags(): void {
  sessionTags.clear();
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

/**
 * A tool call's arguments object is evaluated as the first positional argument.
 * `sessionId` scopes session tags; calls without one share a per-agent scope.
 */
export async function decideToolCall(agentId: string, call: ProposedToolCall, sessionId?: string): Promise<ToolDecision> {
  const args = parseArguments(call.arguments);
  return decide(agentId, call.name, args, [args], sessionId);
}

/** A method call (SDK `trace()` style) is evaluated with its positional arguments as-is. */
export async function decideMethodCall(agentId: string, name: string, args: unknown[], sessionId?: string): Promise<ToolDecision> {
  return decide(agentId, name, args, args, sessionId);
}

async function decide(agentId: string, name: string, recorded: unknown, positional: unknown[], sessionId?: string): Promise<ToolDecision> {
  const base = { tool: name, arguments: recorded, audit: false, halt: false, approval: false };
  const scope = scanScope(name, positional);

  const guard = checkSelfProtection([scope.shell, scope.other]);
  if (guard) return { ...base, allowed: false, source: 'self_protection', ruleId: guard.rule, message: guard.message };

  const shellCheck = checkCommand(scope.shell, {}, { shell: true });
  const check = shellCheck.matched ? shellCheck : checkCommand(scope.other);
  if (check.matched) {
    const approval = check.source === 'approval_required';
    const message = approval ? 'command requires human approval' : 'matches the built-in command blocklist';
    return { ...base, allowed: false, approval, source: 'blocklist', ruleId: check.rule, message };
  }

  const result = await evaluatePolicy(agentId, name, { args: positional }, { sessionTags: tagsOf(agentId, sessionId) });
  const ruleId = result.rule?.id;
  const message = result.rule?.message;
  // Tag only calls that may run: a blocked read never happened.
  const tags = result.rule && ['allow', 'allow_and_audit', 'require_approval'].includes(result.action) ? ruleTags(result.rule) : [];
  if (tags.length > 0) addTags(agentId, sessionId, tags);
  const tagged = tags.length > 0 ? { tags } : {};
  switch (result.action) {
    case 'allow':
      return { ...base, ...tagged, allowed: true, ruleId };
    case 'allow_and_audit':
      return { ...base, ...tagged, allowed: true, audit: true, source: 'policy', ruleId, message };
    case 'halt_agent':
      halted.set(agentId, ruleId ?? 'halt_agent');
      await store.saveHalt({ agent_id: agentId, rule_id: ruleId ?? 'halt_agent', halted_at: new Date().toISOString() });
      return { ...base, allowed: false, halt: true, source: 'policy', ruleId, message };
    case 'require_approval':
      return { ...base, ...tagged, allowed: false, approval: true, source: 'policy', ruleId, message };
    case 'block':
      return { ...base, allowed: false, source: 'policy', ruleId: ruleId ?? 'defaultAction', message };
  }
}

export async function decideToolCalls(agentId: string, calls: ProposedToolCall[], sessionId?: string): Promise<ToolDecision[]> {
  const decisions: ToolDecision[] = [];
  for (const call of calls) decisions.push(await decideToolCall(agentId, call, sessionId));
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
