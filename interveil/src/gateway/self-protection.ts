import path from 'path';
import { extractStrings, normalize } from '../commands/blocklist.js';
import { mentionsPath, segmentMatches, shellTokens } from '../commands/shell-paths.js';
import { activePolicyFile } from '../policy/engine.js';

/**
 * Stops an agent from switching Interveil off. A prompt-injected agent with a
 * shell could otherwise lift its own halt over HTTP, kill the server, read the
 * API key, or rewrite the policy and the hook that calls Interveil. These checks
 * run before the blocklist and the policy, for every agent.
 *
 * Like the blocklist this is pattern matching, not a sandbox: it closes the
 * obvious routes, and the API key (`interveil init` writes one) closes the HTTP
 * route for anything that slips past.
 */

export interface GuardMatch {
  rule: string;
  message: string;
}

interface GuardRule {
  id: string;
  pattern: RegExp;
  message: string;
}

const STATIC_RULES: GuardRule[] = [
  { id: 'interveil-key', pattern: /interveil_api_key|\$\{!\w*[*@]\}/, message: 'reads Interveil\'s API key' },
  { id: 'interveil-hook', pattern: /\b(?:interveil|cli\.js)\s+init\b/, message: 'changes Claude Code settings or hooks, which is where Interveil is registered' },
];

/** Paths an agent may not touch, as segments; globs and parent directories that reach them count. */
const PROTECTED_PATHS: Array<{ id: string; segments: string[]; message: string }> = [
  { id: 'interveil-key', segments: ['.interveil'], message: 'reads or changes Interveil\'s key, hook or data directory' },
  { id: 'interveil-hook', segments: ['.claude', 'settings.json'], message: 'changes Claude Code settings or hooks, which is where Interveil is registered' },
  { id: 'interveil-hook', segments: ['.claude', 'settings.local.json'], message: 'changes Claude Code settings or hooks, which is where Interveil is registered' },
  { id: 'interveil-hook', segments: ['.claude', 'hooks'], message: 'changes Claude Code settings or hooks, which is where Interveil is registered' },
];

const KILLERS = /^(?:p?kill|killall|pgrep|pidof|taskkill|stop-process|fuser)$/;
/** What a process pattern (pkill regex, killall name, taskkill image) must not be able to match. */
const SERVER_PROCESS = ['interveil', 'node', 'node.exe', 'node dist/cli.js serve --preset coding-agent'];

function targetsServerProcess(text: string): boolean {
  const tokens = shellTokens(text);
  const at = tokens.findIndex(t => KILLERS.test(t.replace(/^.*\//, '')));
  if (at === -1) return false;
  return tokens.slice(at + 1).some(t => {
    if (t.startsWith('-') || t.startsWith('/') && t.length <= 3 || /^%?\d+$/.test(t)) return false;
    let re: RegExp | null = null;
    try { re = new RegExp(t, 'i'); } catch { /* not a regex: still try it as a glob */ }
    return SERVER_PROCESS.some(p => re?.test(p) || segmentMatches(t, p));
  });
}

let port: number | undefined;

/** Called by the server once it is listening. */
export function protectPort(p: number | undefined): void {
  port = p;
}

function dynamicRules(): GuardRule[] {
  const rules: GuardRule[] = [];
  if (port) {
    // Any host: 127.1, 0x7f000001, 2130706433, [::ffff:127.0.0.1], a LAN address
    // or a variable all reach the same socket, so the port alone decides.
    rules.push({
      id: 'interveil-api',
      pattern: new RegExp(`(?::|%3a)${port}(?!\\d)|/dev/(?:tcp|udp)/[^/\\s]+/${port}(?!\\d)|\\b${port}/(?:tcp|udp)\\b|\\b(?:nc|ncat|netcat|telnet|socat)\\b.*\\b${port}\\b|\\b(?:connect|create_connection|createconnection)\\b[^;&|]*\\b${port}\\b`),
      message: 'calls the Interveil server directly',
    });
  }
  return rules;
}

function protectedPaths() {
  const policyFile = activePolicyFile();
  return policyFile
    ? [...PROTECTED_PATHS, { id: 'interveil-policy', segments: [path.basename(policyFile).toLowerCase()], message: 'reads or changes the active Interveil policy file' }]
    : PROTECTED_PATHS;
}

/**
 * Each string is checked twice: the blocklist's normalization (quotes and
 * backslashes removed, so `inter''veil` is caught) and a path-friendly one
 * (backslashes become slashes, so Windows paths match).
 */
export function checkSelfProtection(value: unknown): GuardMatch | null {
  const strings = extractStrings(value);
  if (strings === null) return null; // the blocklist's scan limit already blocks this
  const rules = [...STATIC_RULES, ...dynamicRules()];
  const paths = protectedPaths();
  for (const raw of strings) {
    const forms = [normalize(raw), raw.toLowerCase().replace(/\\/g, '/').replace(/['"]/g, '').replace(/\s+/g, ' ')];
    for (const rule of rules) {
      if (forms.some(f => rule.pattern.test(f))) return { rule: rule.id, message: rule.message };
    }
    const hit = paths.find(p => mentionsPath(raw, p.segments));
    if (hit) return { rule: hit.id, message: hit.message };
    if (targetsServerProcess(raw)) return { rule: 'interveil-process', message: 'stops the Interveil server' };
  }
  return null;
}
