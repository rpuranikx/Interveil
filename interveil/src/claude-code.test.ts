import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { hookOutput, initClaudeCode, onFailureSupport } from './claude-code.js';

describe('hookOutput', () => {
  const url = 'http://localhost:3000';

  it('allows with no output', () => {
    expect(hookOutput({ ok: true, allowed: true }, url)).toBeNull();
  });

  it('asks for require_approval and denies everything else', () => {
    expect(hookOutput({ ok: true, allowed: false, approval_required: true, source: 'policy', rule_id: 'r', message: 'm' }, url)?.hookSpecificOutput)
      .toMatchObject({ permissionDecision: 'ask' });
    expect(hookOutput({ ok: true, allowed: false, source: 'blocklist', rule_id: 'pipe-to-shell', message: 'm' }, url)?.hookSpecificOutput)
      .toMatchObject({ permissionDecision: 'deny' });
  });

  it('fails closed with a way to start the server', () => {
    const out = hookOutput(null, url)?.hookSpecificOutput;
    expect(out?.permissionDecision).toBe('deny');
    expect(out?.permissionDecisionReason).toContain('interveil serve --preset coding-agent');
  });
});

describe('initClaudeCode', () => {
  let dir: string;
  let settingsFile: string;
  const prevKeyFile = process.env.INTERVEIL_API_KEY_FILE;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'interveil-init-'));
    settingsFile = path.join(dir, '.claude', 'settings.json');
    process.env.INTERVEIL_API_KEY_FILE = path.join(dir, 'api-key');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (prevKeyFile === undefined) delete process.env.INTERVEIL_API_KEY_FILE;
    else process.env.INTERVEIL_API_KEY_FILE = prevKeyFile;
  });

  const init = (extra: Partial<Parameters<typeof initClaudeCode>[0]> = {}) => initClaudeCode({
    settingsFile, hookScript: '/home/me/.interveil/hooks/claude-code.js', url: 'http://127.0.0.1:3000', agentId: 'claude-code', key: true, ...extra,
  });

  it('keeps existing settings, adds the hook once, and creates a key', () => {
    fs.mkdirSync(path.dirname(settingsFile));
    // An older shell-form Interveil hook is replaced, not duplicated.
    fs.writeFileSync(settingsFile, JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, hooks: { PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'other' }] },
      { hooks: [{ type: 'command', command: '"node" "/clone/dist/cli.js" hook claude-code' }] },
    ] } }));

    const first = init();
    expect(first).toMatchObject({ replaced: true, keyCreated: true });
    const second = init({ url: 'http://localhost:4000' });
    expect(second).toMatchObject({ replaced: true, keyCreated: false });

    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    expect(settings.permissions).toEqual({ allow: ['Bash(ls)'] });
    const entries = settings.hooks.PreToolUse.flatMap((g: { hooks: object[] }) => g.hooks);
    expect(entries).toHaveLength(2);
    expect(entries[1]).toEqual({
      type: 'command', command: process.execPath, timeout: 10, onFailure: 'block',
      args: ['/home/me/.interveil/hooks/claude-code.js', '--url', 'http://localhost:4000'],
    });
    expect(fs.readFileSync(path.join(dir, 'api-key'), 'utf-8').trim()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('leaves a settings file it cannot parse alone', () => {
    fs.mkdirSync(path.dirname(settingsFile));
    fs.writeFileSync(settingsFile, '{ not json');
    expect(() => init()).toThrow(/not valid JSON/);
    expect(fs.readFileSync(settingsFile, 'utf-8')).toBe('{ not json');
  });
});

describe('installed hook script', () => {
  it('runs on its own, outside the clone, and fails closed when the server is down', async () => {
    const { execFileSync } = await import('child_process');
    const { installHookScript } = await import('./claude-code.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'interveil-hook-'));
    try {
      // Build output is CommonJS; vitest runs the .ts source, so copy the compiled file when present.
      const compiled = path.join(__dirname, '../dist/claude-code.js');
      if (!fs.existsSync(compiled)) return;
      const dest = path.join(dir, 'claude-code.js');
      fs.copyFileSync(compiled, dest);
      const out = execFileSync(process.execPath, [dest, '--url', 'http://127.0.0.1:1'], {
        input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'a' } }),
      }).toString();
      expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe('deny');
      expect(typeof installHookScript).toBe('function');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('onFailureSupport', () => {
  it.each([
    ['2.1.295 (Claude Code)', 'ok'], ['2.2.0 (Claude Code)', 'ok'], ['3.0.1', 'ok'],
    ['2.1.294 (Claude Code)', 'old'], ['1.9.999', 'old'], ['2.0.400', 'old'],
    ['', 'unknown'], [null, 'unknown'], ['command not found', 'unknown'],
  ])('%j → %s', (out, status) => {
    expect(onFailureSupport(out).status).toBe(status);
  });
});
