/**
 * Does a command or path refer to a given file, including through shell globs?
 *
 * Regexes miss `cat .e*`, `mv .cl*` or `~/.inter?eil/api-key`, because the
 * shell expands those into protected names only at run time. This tokenizes the
 * way a shell would (quotes and backslashes removed, split on whitespace and
 * operators), expands simple braces, and matches each path segment against the
 * target name with glob semantics, so a glob that could expand to the target
 * counts as naming it.
 *
 * Still pattern matching: a name built at run time (`$(printf .%s env)`) or
 * read from a file is not seen.
 */

const GLOB_CHARS = /[*?[]/;
const MAX_BRACE_EXPANSIONS = 64;

/**
 * Shell-like tokens of a command or path, in order, with quotes and backslashes
 * removed. Two readings of backslashes, one list each: shell escapes (`.e\\nv`
 * is `.env`) and Windows separators.
 */
function tokenLists(text: string): string[][] {
  const forms = [text.replace(/['"\\]/g, ''), text.replace(/['"]/g, '').replace(/\\/g, '/')];
  return forms.map(form => {
    const out: string[] = [];
    for (const raw of form.split(/[\s;&|<>()`=]+|\$\(/)) {
      if (!raw) continue;
      // Braces first (their commas are alternatives), then commas as separators (`('host', 3000)`).
      for (const t of expandBraces(raw)) for (const part of t.split(',')) if (part) out.push(part.toLowerCase());
    }
    return out;
  });
}

export function shellTokens(text: string): string[] {
  return [...new Set(tokenLists(text).flat())];
}

/**
 * Options whose next argument is a name pattern matched by the tool itself
 * (find, grep, rg, fd), where `*` also matches dotfiles and, for paths, `/`.
 */
const PATTERN_FLAGS = new Set(['-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '--include', '--exclude', '-g', '--glob', '--iglob']);
const REGEX_FLAGS = new Set(['-regex', '-iregex']);

/**
 * A name of the same shape as `name` that no one would protect: `claude-code.js`
 * → `zzqx.js`. A pattern that matches it too (`*.js`, `*`) is generic, not aimed
 * at `name`, and strict matching ignores it.
 */
function decoy(name: string): string {
  const dot = name.lastIndexOf('.');
  return (name.startsWith('.') ? '.' : '') + 'zzqx' + (dot > 0 ? name.slice(dot) : '');
}

function patternMatches(pattern: string, target: string[], regex: boolean, strict: boolean): boolean {
  const candidates = [...target, target.join('/'), `/x/${target.join('/')}`];
  let re: RegExp;
  try {
    re = regex
      ? new RegExp(`^(?:${pattern})$`, 'i')
      : new RegExp(`^${pattern.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
  } catch {
    return false;
  }
  if (strict && re.test(decoy(target[target.length - 1]))) return false;
  return candidates.some(c => re.test(c));
}

/** `a{b,c}d` → `abd`, `acd` (nested braces expand innermost first). */
export function expandBraces(token: string): string[] {
  let results = [token];
  for (let guard = 0; guard < 8; guard++) {
    let changed = false;
    const next: string[] = [];
    for (const t of results) {
      const m = /\{([^{}]*,[^{}]*)\}/.exec(t);
      if (!m) {
        next.push(t);
        continue;
      }
      changed = true;
      for (const alt of m[1].split(',')) next.push(t.slice(0, m.index) + alt + t.slice(m.index + m[0].length));
    }
    results = next.slice(0, MAX_BRACE_EXPANSIONS);
    if (!changed) break;
  }
  return results;
}

/** One path segment as a glob. A pattern that doesn't start with `.` never matches a dotfile, as in a shell. */
export function segmentMatches(pattern: string, name: string): boolean {
  if (!GLOB_CHARS.test(pattern)) return pattern === name;
  if (pattern === '**') return true;
  if (name.startsWith('.') && !pattern.startsWith('.') && !pattern.startsWith('[')) return false;
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[') {
      const end = pattern.indexOf(']', i + 2);
      if (end === -1) { re += '\\['; continue; }
      const body = pattern.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\');
      re += `[${body}]`;
      i = end;
    } else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  try {
    return new RegExp(`^${re}$`).test(name);
  } catch {
    return false;
  }
}

/**
 * True if any token names the target path (given as segments, e.g.
 * `['.claude', 'settings.json']`) or one of its parent directories within the
 * target (`.claude` alone, as in `mv .claude x`). Each token segment may be a
 * glob, and the argument of `find -name`, `grep --include` and the like is
 * matched as that tool would. `strict` ignores generic patterns (`*`, `*.js`)
 * at the first segment, for callers that deny rather than ask.
 */
export function mentionsPath(text: string, target: string[], strict = false): boolean {
  for (const list of tokenLists(text)) {
    for (let k = 1; k < list.length; k++) {
      if (PATTERN_FLAGS.has(list[k - 1]) && patternMatches(list[k], target, false, strict)) return true;
      if (REGEX_FLAGS.has(list[k - 1]) && patternMatches(list[k], target, true, strict)) return true;
    }
  }
  for (const token of shellTokens(text)) {
    const segs = token.split('/').filter(Boolean);
    for (let i = 0; i < segs.length; i++) {
      if (strict && GLOB_CHARS.test(segs[i]) && segmentMatches(segs[i], decoy(target[0]))) continue;
      let j = 0;
      while (j < target.length && i + j < segs.length && segmentMatches(segs[i + j], target[j])) j++;
      // Matched the whole target, or ran out of token after matching a parent directory of it.
      if (j === target.length || (j > 0 && i + j === segs.length)) return true;
    }
  }
  return false;
}
