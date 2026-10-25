import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomBytes } from 'crypto';

/**
 * Claude Code integration: `interveil hook claude-code` is the PreToolUse
 * command hook, and `interveil init claude-code` registers it.
 *
 * The API key lives in ~/.interveil/api-key rather than in the environment:
 * the agent's Bash tool inherits environment variables, and self-protection
 * refuses tool calls that touch ~/.interveil.
 */

export const DEFAULT_URL = 'http://127.0.0.1:3000';
export const DEFAULT_AGENT_ID = 'claude-code';

export function keyFilePath(): string {
  return process.env.INTERVEIL_API_KEY_FILE || path.join(os.homedir(), '.interveil', 'api-key');
}

/** The key from the key file, if there is one. */
export function readKeyFile(): string | undefined {
  try {
    return fs.readFileSync(keyFilePath(), 'utf-8').trim() || undefined;
  } catch {
    return undefined;
  }
}

interface Decision {
  ok: boolean;
  allowed?: boolean;
  approval_required?: boolean;
  source?: string | null;
  rule_id?: string | null;
  message?: string | null;
  error?: string;
}

interface HookOutput {
  hookSpecificOutput: { hookEventName: 'PreToolUse'; permissionDecision: 'deny' | 'ask'; permissionDecisionReason: string };
}

/** Allow (null), ask for require_approval, deny otherwise. `null` decision = server unreachable. */
export function hookOutput(decision: Decision | null, url: string): HookOutput | null {
  if (decision?.ok && decision.allowed) return null;
  let permissionDecision: 'deny' | 'ask' = 'deny';
  let reason: string;
  if (!decision) {
    reason = `Interveil at ${url} did not answer, so this tool call was denied. Start it with: interveil serve --preset coding-agent`;
  } else if (!decision.ok) {
    reason = `Interveil could not evaluate this tool call, so it was denied: ${decision.error ?? 'unknown error'}`;
  } else if (decision.approval_required) {
    permissionDecision = 'ask';
    reason = `Interveil ${decision.source} rule "${decision.rule_id}" needs your approval: ${decision.message}.`;
  } else {
    reason = `Blocked by Interveil ${decision.source} rule "${decision.rule_id}": ${decision.message}.`;
  }
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason: reason } };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf-8');
}

export async function runHook(opts: { url: string; agentId: string }): Promise<void> {
  let output: HookOutput | null;
  try {
    const event = JSON.parse(await readStdin()) as { tool_name: string; tool_input?: unknown; session_id?: string };
    const key = readKeyFile() ?? process.env.INTERVEIL_API_KEY;
    let decision: Decision | null = null;
    try {
      const res = await fetch(`${opts.url.replace(/\/$/, '')}/api/v1/policy/evaluate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(key ? { 'x-interveil-key': key } : {}) },
        body: JSON.stringify({ tool: event.tool_name, arguments: event.tool_input ?? {}, agent_id: opts.agentId, session_id: event.session_id }),
        signal: AbortSignal.timeout(5000),
      });
      decision = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` })) as Decision;
      if (!res.ok) decision = { ok: false, error: decision.error ?? `HTTP ${res.status}` };
    } catch {
      decision = null;
    }
    output = hookOutput(decision, opts.url);
  } catch (err) {
    output = hookOutput({ ok: false, error: `bad hook input: ${(err as Error).message}` }, opts.url);
  }
  if (output) process.stdout.write(JSON.stringify(output));
}

// ── init ─────────────────────────────────────────────────────────────────────

const HOOK_MARKER = ' hook claude-code';

export interface InitResult {
  settingsFile: string;
  command: string;
  replaced: boolean;
  keyFile?: string;
  keyCreated: boolean;
}

/** Creates the key file (if asked and missing) and writes the hook into a Claude Code settings file. */
export function initClaudeCode(opts: { settingsFile: string; cliPath: string; url: string; agentId: string; key: boolean }): InitResult {
  let keyCreated = false;
  const keyFile = opts.key ? keyFilePath() : undefined;
  if (keyFile && !fs.existsSync(keyFile)) {
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    fs.writeFileSync(keyFile, randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
    keyCreated = true;
  }

  const fwd = (p: string) => p.replace(/\\/g, '/');
  let command = `"${fwd(process.execPath)}" "${fwd(opts.cliPath)}"${HOOK_MARKER}`;
  if (opts.url !== DEFAULT_URL) command += ` --url ${opts.url}`;
  if (opts.agentId !== DEFAULT_AGENT_ID) command += ` --agent-id ${opts.agentId}`;

  let settings: Record<string, unknown> = {};
  if (fs.existsSync(opts.settingsFile)) {
    const text = fs.readFileSync(opts.settingsFile, 'utf-8');
    try {
      settings = text.trim() ? JSON.parse(text) as Record<string, unknown> : {};
    } catch (err) {
      throw new Error(`${opts.settingsFile} is not valid JSON, so it was left alone: ${(err as Error).message}`);
    }
  }
  const hooks = (settings.hooks ??= {}) as Record<string, unknown>;
  const preToolUse = (hooks.PreToolUse ??= []) as Array<{ hooks?: Array<{ type?: string; command?: string; timeout?: number }> }>;

  let replaced = false;
  for (const group of preToolUse) {
    for (const h of group.hooks ?? []) {
      if (h.command?.includes(HOOK_MARKER)) {
        h.command = command;
        replaced = true;
      }
    }
  }
  if (!replaced) preToolUse.push({ hooks: [{ type: 'command', command, timeout: 10 }] });

  fs.mkdirSync(path.dirname(opts.settingsFile), { recursive: true });
  fs.writeFileSync(opts.settingsFile, JSON.stringify(settings, null, 2) + '\n');
  return { settingsFile: opts.settingsFile, command, replaced, keyFile, keyCreated };
}
