import path from 'path';
import { extractStrings, normalize } from '../commands/blocklist.js';
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
  { id: 'interveil-key', pattern: /\binterveil_api_key\b|\.interveil(?:\/|$|\s)/, message: 'reads or changes Interveil\'s key or data directory' },
  { id: 'interveil-hook', pattern: /\.claude\/(?:settings[\w.-]*\.json\b|hooks\b)|\b(?:interveil|cli\.js)\s+init\b/, message: 'changes Claude Code settings or hooks, which is where Interveil is registered' },
  { id: 'interveil-process', pattern: /\b(?:p?kill|killall|taskkill|stop-process|docker\s+(?:stop|kill|rm))\b.*\binterveil\b|\b(?:pkill|killall)\s+(?:-\S+\s+)*node(?:\.exe)?\b|\btaskkill\b.*\bnode(?:\.exe)?\b/, message: 'stops the Interveil server' },
];

let port: number | undefined;

/** Called by the server once it is listening. */
export function protectPort(p: number | undefined): void {
  port = p;
}

function dynamicRules(): GuardRule[] {
  const rules: GuardRule[] = [];
  if (port) {
    rules.push({
      id: 'interveil-api',
      pattern: new RegExp(`(?:localhost|127\\.0\\.0\\.1|\\[?::1\\]?|0\\.0\\.0\\.0):${port}\\b`),
      message: 'calls the Interveil server directly',
    });
  }
  const policyFile = activePolicyFile();
  if (policyFile) {
    const name = path.basename(policyFile).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    rules.push({ id: 'interveil-policy', pattern: new RegExp(`(?:^|[/\\s=:])${name}\\b`), message: 'reads or changes the active Interveil policy file' });
  }
  return rules;
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
  for (const raw of strings) {
    const forms = [normalize(raw), raw.toLowerCase().replace(/\\/g, '/').replace(/['"]/g, '').replace(/\s+/g, ' ')];
    for (const rule of rules) {
      if (forms.some(f => rule.pattern.test(f))) return { rule: rule.id, message: rule.message };
    }
  }
  return null;
}
