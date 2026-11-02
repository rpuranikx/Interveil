/**
 * Which parts of a tool call the command blocklist reads.
 *
 * Coding agents (Claude Code, the Claude Agent SDK) pass file bodies and prose
 * through their tools: a SQL migration in Write, a README install line in Edit,
 * a search pattern in Grep. Those are data, not commands, so scanning them only
 * produces false positives. For these tools, the shell tools' `command` (Bash,
 * PowerShell, Monitor) is scanned as a shell command, data fields are skipped, and everything else (paths, URLs) is
 * scanned as usual. Unknown tools are scanned in full.
 */

const DATA_FIELDS: Record<string, string[]> = {
  Bash: ['description'],
  PowerShell: ['description'],
  Monitor: ['description'],
  Write: ['content'],
  Edit: ['old_string', 'new_string'],
  MultiEdit: ['edits'],
  NotebookEdit: ['new_source'],
  Grep: ['pattern'],
  WebFetch: ['prompt'],
  WebSearch: ['query'],
  Task: ['prompt', 'description'],
  Agent: ['prompt', 'description'],
  TodoWrite: ['todos'],
};

const SHELL_FIELDS: Record<string, string> = {
  Bash: 'command',
  PowerShell: 'command',
  Monitor: 'command',
};

export interface ScanScope {
  /** Shell commands, checked with shell-only rule scoping. */
  shell: string[];
  /** Everything else that should be scanned. */
  other: unknown;
}

/** Splits a tool call's positional arguments into what the blocklist should read. */
export function scanScope(toolName: string, positional: unknown[]): ScanScope {
  const data = DATA_FIELDS[toolName];
  const shellField = SHELL_FIELDS[toolName];
  const args = positional[0];
  if (!data || positional.length !== 1 || !args || typeof args !== 'object' || Array.isArray(args)) {
    return { shell: [], other: positional };
  }
  const rest: Record<string, unknown> = {};
  const shell: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (data.includes(key)) continue;
    if (key === shellField && typeof value === 'string') shell.push(value);
    else rest[key] = value;
  }
  return { shell, other: rest };
}
