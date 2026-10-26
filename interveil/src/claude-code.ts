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

/**
 * Where `init` installs the hook script. Running a copy from ~/.interveil rather
 * than from the clone means the agent can't disable it by moving or editing the
 * repository, and self-protection already refuses tool calls that touch ~/.interveil.
 * This file depends only on Node built-ins, so it runs on its own.
 */
export function installedHookPath(): string {
  return path.join(os.homedir(), '.interveil', 'hooks', 'claude-code.js');
}

/** Copies this module to `dest` (default installedHookPath()) and returns the path. */
export function installHookScript(dest = installedHookPath()): string {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(__filename, dest);
  return dest;
}

interface HookEntry { type?: string; command?: string; args?: string[]; timeout?: number; onFailure?: string }

const isInterveilHook = (h: HookEntry) =>
  !!h.command?.includes(' hook claude-code') || !!h.args?.some(a => a.replace(/\\/g, '/').endsWith('/claude-code.js'));

export interface InitResult {
  settingsFile: string;
  entry: HookEntry;
  replaced: boolean;
  keyFile?: string;
  keyCreated: boolean;
}

/**
 * Creates the key file (if asked and missing) and writes the hook into a Claude
 * Code settings file. The entry runs in exec form (no shell to tamper with) with
 * `onFailure: "block"`: if the hook can't start, crashes or times out, the tool
 * call is blocked instead of going ahead.
 */
export function initClaudeCode(opts: { settingsFile: string; hookScript: string; url: string; agentId: string; key: boolean }): InitResult {
  let keyCreated = false;
  const keyFile = opts.key ? keyFilePath() : undefined;
  if (keyFile && !fs.existsSync(keyFile)) {
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    fs.writeFileSync(keyFile, randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
    keyCreated = true;
  }

  const args = [opts.hookScript];
  if (opts.url !== DEFAULT_URL) args.push('--url', opts.url);
  if (opts.agentId !== DEFAULT_AGENT_ID) args.push('--agent-id', opts.agentId);
  const entry: HookEntry = { type: 'command', command: process.execPath, args, timeout: 10, onFailure: 'block' };

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
  const preToolUse = (hooks.PreToolUse ??= []) as Array<{ hooks?: HookEntry[] }>;

  let replaced = false;
  for (const group of preToolUse) {
    group.hooks = (group.hooks ?? []).map(h => {
      if (!isInterveilHook(h)) return h;
      replaced = true;
      return { ...entry };
    });
  }
  if (!replaced) preToolUse.push({ hooks: [{ ...entry }] });

  fs.mkdirSync(path.dirname(opts.settingsFile), { recursive: true });
  fs.writeFileSync(opts.settingsFile, JSON.stringify(settings, null, 2) + '\n');
  return { settingsFile: opts.settingsFile, entry, replaced, keyFile, keyCreated };
}

// Run directly (the installed copy): node claude-code.js [--url <url>] [--agent-id <id>]
if (require.main === module) {
  const flag = (name: string) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? undefined : process.argv[i + 1];
  };
  void runHook({
    url: flag('--url') ?? process.env.INTERVEIL_URL ?? DEFAULT_URL,
    agentId: flag('--agent-id') ?? process.env.INTERVEIL_AGENT_ID ?? DEFAULT_AGENT_ID,
  });
}
