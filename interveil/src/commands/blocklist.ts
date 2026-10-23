/**
 * Pre-execution command blocklist.
 *
 * This is a speed bump for obviously destructive commands, not a sandbox: a
 * determined agent can always obfuscate a command past pattern matching. Rules
 * are regexes over a normalized form of each string (lowercased, quotes and
 * backslashes removed, whitespace collapsed) so trivial variations such as
 * `rm  -fr`, `r''m -rf` or `DROP\tTABLE` are still caught. The Python SDK
 * mirrors these rules; test-fixtures/blocklist-cases.json keeps them in sync.
 */

export interface BlockRule {
  id: string;
  pattern: RegExp;
}

export const DEFAULT_RULES: BlockRule[] = [
  { id: 'rm-recursive', pattern: /\brm\s+(?:[^;&|]*\s)?(?:-[a-z]*r[a-z]*|--recursive)\b/ },
  { id: 'sudo-rm', pattern: /\bsudo\s+rm\b/ },
  { id: 'find-delete', pattern: /\bfind\b[^;&|]*\s-delete\b/ },
  { id: 'rmtree', pattern: /\bshutil\.rmtree\b|\bfs\.rmsync\b|\brimraf\b/ },
  { id: 'pipe-to-shell', pattern: /\b(?:curl|wget)\b[^;&]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/ },
  { id: 'decode-to-shell', pattern: /\bbase64\s+(?:-d|--decode)\b[^;&]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/ },
  { id: 'sql-drop', pattern: /\bdrop\s+(?:table|database|schema)\b/ },
  { id: 'sql-truncate', pattern: /\btruncate\s+table\b|^truncate\s+[a-z_][\w.]*$/ },
  { id: 'mkfs', pattern: /\bmkfs(?:\.\w+)?\b/ },
  { id: 'dd-to-device', pattern: /\bdd\b[^;&|]*\bof=\/dev\// },
  { id: 'windows-format', pattern: /\bformat\s+[a-z]:|\bdiskpart\b/ },
  { id: 'chmod-777-absolute', pattern: /\bchmod\s+(?:-[a-z]+\s+)*0?777\s+\// },
  { id: 'system-credentials', pattern: /\/etc\/(?:passwd|shadow|sudoers)\b/ },
  { id: 'user-credentials', pattern: /\/\.ssh\/|\.aws\/credentials\b/ },
];

export interface UserCommandConfig {
  /** Extra patterns to block (substring match on the normalized string). */
  block?: string[];
  /** Exact commands to exempt. A segment must equal the entry after normalization. */
  whitelist?: string[];
  /** Patterns that need a human before running (substring match). */
  requireApproval?: string[];
}

export interface MatchResult {
  matched: boolean;
  rule: string;
  source: 'default_blocklist' | 'user_config' | 'approval_required' | 'scan_limit' | 'none';
  /** The string value from the argument that triggered the match. */
  matchedValue?: string;
}

/** Strings scanned per call before giving up and blocking (fail closed). */
export const MAX_SCANNED_STRINGS = 10_000;

export function normalize(command: string): string {
  return command.toLowerCase().replace(/['"\\]/g, '').replace(/\s+/g, ' ').trim();
}

/** Splits a normalized command into the pieces a shell would run separately. */
function segments(normalized: string): string[] {
  return normalized.split(/\s*(?:&&|\|\||;|\n|\$\(|`)\s*/).filter(Boolean);
}

/**
 * Collects every string in a value — object keys included — without a depth
 * limit. Returns null if the value holds more than `limit` strings.
 */
export function extractStrings(value: unknown, limit = MAX_SCANNED_STRINGS): string[] | null {
  const out: string[] = [];
  const seen = new WeakSet<object>();
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v === 'string') out.push(v);
    else if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') out.push(String(v));
    else if (v !== null && typeof v === 'object') {
      if (seen.has(v)) continue;
      seen.add(v);
      if (Array.isArray(v)) stack.push(...v);
      else for (const [k, child] of Object.entries(v)) stack.push(k, child);
    }
    if (out.length > limit) return null;
  }
  return out;
}

/**
 * Deep-scans any value (strings, arrays, objects) and returns the first match.
 * Order: user block patterns, default rules, then require-approval patterns.
 * A whitelisted segment is skipped, but every other segment and string is
 * still checked.
 */
export function checkCommand(command: unknown, userConfig: UserCommandConfig = {}): MatchResult {
  const candidates = extractStrings(command);
  if (candidates === null) {
    return { matched: true, rule: `more than ${MAX_SCANNED_STRINGS} strings`, source: 'scan_limit' };
  }

  const whitelist = new Set((userConfig.whitelist ?? []).map(normalize));
  const block = (userConfig.block ?? []).map(normalize).filter(Boolean);
  const approval = (userConfig.requireApproval ?? []).map(normalize).filter(Boolean);

  const checked = candidates.flatMap(raw =>
    segments(normalize(raw)).filter(s => !whitelist.has(s)).map(segment => ({ raw, segment })),
  );

  // Blocks take priority over approvals anywhere in the input.
  for (const { raw, segment } of checked) {
    const userBlock = block.find(p => segment.includes(p));
    if (userBlock) return { matched: true, rule: userBlock, source: 'user_config', matchedValue: raw };

    const rule = DEFAULT_RULES.find(r => r.pattern.test(segment));
    if (rule) return { matched: true, rule: rule.id, source: 'default_blocklist', matchedValue: raw };
  }

  for (const { raw, segment } of checked) {
    const needsApproval = approval.find(p => segment.includes(p));
    if (needsApproval) return { matched: true, rule: needsApproval, source: 'approval_required', matchedValue: raw };
  }

  return { matched: false, rule: '', source: 'none' };
}
