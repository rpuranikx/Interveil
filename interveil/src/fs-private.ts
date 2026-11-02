import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Owner-only files for what Interveil keeps on disk: stored prompts and tool
 * arguments, the API key, the installed hook. On Windows, chmod only toggles the
 * read-only bit, so these calls are harmless there and the user profile's ACLs apply.
 */

/** The data directory, ~/.interveil. */
export function interveilHome(): string {
  return path.join(os.homedir(), '.interveil');
}

/** Creates `dir` (and parents) as 0700, and tightens it if it already exists. */
export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* not ours to change */ }
}

/** Sets an existing file to 0600; missing files are ignored. */
export function makePrivate(file: string): void {
  try { fs.chmodSync(file, 0o600); } catch { /* missing, or not ours to change */ }
}
