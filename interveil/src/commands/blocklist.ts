/**
 * Pre-execution command blocklist.
 *
 * This is a speed bump for obviously destructive commands, not a sandbox: a
 * determined agent can always obfuscate a command past pattern matching. Rules
 * are regexes over a normalized form of each string (lowercased, quotes and
 * backslashes removed, whitespace collapsed) so trivial variations such as
 * `rm  -fr`, `r''m -rf` or `DROP\tTABLE` are still caught. The Python SDK
 * mirrors these rules; test-fixtures/blocklist-cases.json keeps them in sync.
 *
 * Recursive rm is only blocked when a target leaves the working tree or wipes
 * it (`/`, `~`, `$VAR`, `..`, `.`, `*`), so `rm -rf node_modules dist` runs.
 */

export interface BlockRule {
  id: string;
  pattern: RegExp;
  /**
   * For shell commands (`{ shell: true }`), the segment must also match this.
   * SQL rules use it so `grep -r "DROP TABLE" migrations/` is not a database call.
   */
  inShell?: RegExp;
}

const DB_CLIENT = /\b(?:psql|mysql|mariadb|sqlite3|sqlcmd|cockroach|clickhouse-client|duckdb)\b/;

export const DEFAULT_RULES: BlockRule[] = [
  // PowerShell's Remove-Item and its aliases take -Recurse (or -r), which the flag test already reads.
  { id: 'rm-recursive', pattern: /\b(?:rm|remove-item|ri|rmdir|rd)(?=[^;&|]*\s(?:-[a-z]*r[a-z]*|--recursive)(?:\s|$))[^;&|]*\s(?:[/~$]|[a-z]:|\*\/?(?=\s|$)|\.{1,2}\/?\*?(?=\s|$)|\.\.\/|\S*\/\.\.(?=\/|\s|$))/ },
  { id: 'sudo-rm', pattern: /\bsudo\s+rm\b/ },
  { id: 'find-delete', pattern: /\bfind\b[^;&|]*\s-delete\b/ },
  { id: 'bulk-rm', pattern: /\bfind\b[^;&|]*\s-exec(?:dir)?\s+(?:sudo\s+)?(?:\S*\/)?rm\b|\bxargs\b[^;&]*\brm\b/ },
  { id: 'rmtree', pattern: /\bshutil\.rmtree\b|\bfs\.rmsync\b|\brimraf\b|\bperl\b[^;&|]*(?:\b(?:rmtree|remove_tree)\s*\(|-mfile::path\b)/ },
  { id: 'pipe-to-shell', pattern: /\b(?:curl|wget)\b[^;&]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/ },
  // bash <(curl ...), source <(curl ...): the same download-and-run without a pipe.
  { id: 'process-substitution-to-shell', pattern: /(?:\b(?:ba|z|da|k)?sh|\bsource|(?:^|\s)\.)\s+<\(\s*(?:curl|wget)\b/ },
  { id: 'decode-to-shell', pattern: /\bbase64\s+(?:-d|--decode)\b[^;&]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/ },
  { id: 'sql-drop', pattern: /\bdrop\s+(?:table|database|schema)\b/, inShell: DB_CLIENT },
  { id: 'sql-truncate', pattern: /\btruncate\s+table\b|^truncate\s+[a-z_][\w.]*$/, inShell: DB_CLIENT },
  { id: 'mkfs', pattern: /\bmkfs(?:\.\w+)?\b/ },
  { id: 'dd-to-device', pattern: /\bdd\b[^;&|]*\bof=\/dev\// },
  { id: 'windows-format', pattern: /\bformat\s+[a-z]:|\bdiskpart\b|\b(?:format-volume|clear-disk|initialize-disk)\b/ },
  { id: 'chmod-777-absolute', pattern: /\bchmod\s+(?:-[a-z]+\s+)*0?777\s+\// },
  { id: 'system-credentials', pattern: /\/etc\/(?:passwd|shadow|sudoers)\b/ },
  { id: 'user-credentials', pattern: /\.aws\/credentials\b|\bid_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?\b(?!\.pub)|\.ssh\/identity\b/ },
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
 * still checked. With `shell: true` the value is a shell command, and rules
 * that only make sense inside a program (SQL) need that program in the segment.
 */
export function checkCommand(command: unknown, userConfig: UserCommandConfig = {}, opts: { shell?: boolean } = {}): MatchResult {
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

    const rule = DEFAULT_RULES.find(r => r.pattern.test(segment) && !(opts.shell && r.inShell && !r.inShell.test(segment)));
    if (rule) return { matched: true, rule: rule.id, source: 'default_blocklist', matchedValue: raw };
  }

  for (const { raw, segment } of checked) {
    const needsApproval = approval.find(p => segment.includes(p));
    if (needsApproval) return { matched: true, rule: needsApproval, source: 'approval_required', matchedValue: raw };
  }

  return { matched: false, rule: '', source: 'none' };
}
