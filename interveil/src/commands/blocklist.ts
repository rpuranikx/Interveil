import { readFileSync } from 'fs';
import path from 'path';

interface BlocklistConfig {
  patterns: string[];
}

let defaultPatterns: Array<string | RegExp> = [];

try {
  const raw = readFileSync(path.join(__dirname, '../../config/blocklist.json'), 'utf-8');
  const config = JSON.parse(raw) as BlocklistConfig;
  defaultPatterns = config.patterns;
} catch {
  defaultPatterns = [
    'rm -rf', 'rm -r ', 'rm --recursive',
    'DROP TABLE', 'DROP DATABASE', 'TRUNCATE',
    'FORMAT', 'DISKPART',
    'chmod 777 /', 'curl | bash', 'curl|bash', 'wget | bash', 'wget|bash',
    'sudo rm', 'sudo mkfs',
    '/etc/passwd', '/etc/shadow', '/.ssh/',
  ];
}

export interface UserCommandConfig {
  block?: string[];
  whitelist?: string[];
  requireApproval?: string[];
}

export interface MatchResult {
  matched: boolean;
  rule: string;
  source: 'default_blocklist' | 'user_config' | 'approval_required' | 'whitelisted';
  /** The string value from the argument that triggered the match. */
  matchedValue?: string;
}

/**
 * Recursively extracts every string value from a value of any type.
 * - Strings are returned directly.
 * - Array elements and object values are traversed.
 * - Primitives other than strings are converted via String() so numeric
 *   paths like SQL fragments are also checked.
 * Depth is capped at 8 levels to prevent runaway traversal on huge objects.
 */
export function extractStrings(value: unknown, depth = 0): string[] {
  if (depth > 8) return [];
  if (typeof value === 'string') return [value];
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
  if (Array.isArray(value)) {
    return value.flatMap(item => extractStrings(item, depth + 1));
  }
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap(v => extractStrings(v, depth + 1));
  }
  return [];
}

/**
 * Check a single string (or any value — objects are deep-scanned) against
 * the blocklist and user config. Returns the first match found.
 */
export function checkCommand(command: unknown, userConfig: UserCommandConfig = {}): MatchResult {
  const candidates = extractStrings(command);

  for (const raw of candidates) {
    const cmd = raw.toLowerCase();

    // Whitelist overrides everything
    for (const pattern of userConfig.whitelist ?? []) {
      if (matchPattern(cmd, pattern)) {
        return { matched: false, rule: pattern, source: 'whitelisted', matchedValue: raw };
      }
    }

    // User require-approval patterns
    for (const pattern of userConfig.requireApproval ?? []) {
      if (matchPattern(cmd, pattern)) {
        return { matched: true, rule: pattern, source: 'approval_required', matchedValue: raw };
      }
    }

    // User block patterns
    for (const pattern of userConfig.block ?? []) {
      if (matchPattern(cmd, pattern)) {
        return { matched: true, rule: pattern, source: 'user_config', matchedValue: raw };
      }
    }

    // Default blocklist
    for (const pattern of defaultPatterns) {
      if (matchPattern(cmd, pattern)) {
        return { matched: true, rule: String(pattern), source: 'default_blocklist', matchedValue: raw };
      }
    }
  }

  return { matched: false, rule: '', source: 'default_blocklist' };
}

function matchPattern(command: string, pattern: string | RegExp): boolean {
  if (pattern instanceof RegExp) return pattern.test(command);
  return command.includes(pattern.toLowerCase());
}
